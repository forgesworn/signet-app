/**
 * Telling a legacy phone-paired child's phone that the guardian revoked it.
 *
 * A legacy child talks NIP-46 to the guardian's phone (`dep.bunkerEndpoint`)
 * and reads the persona inventory the guardian publishes with that endpoint
 * key, NIP-44'd to the child's client key. A Revoke clears the endpoint, and
 * before this nothing told the child: it kept showing itself as paired.
 *
 * **Carrier.** The same `signet:child-unpaired:v1` notice a child-direct
 * pairing already uses (`child-activity.ts`: kind 30078, `d` =
 * `signet:child-unpaired:v1`, `p` = the client key, plaintext
 * `{ v: 1, clientPubkey }`, signed). For a legacy dependant it is signed by the
 * dependant's `bunkerEndpoint` key (the inventory's author) with `p` =
 * `bunkerEndpoint.authorizedClientPubkey` (the inventory's recipient), and goes
 * to the inventory's relays. Why an older child build ignores it:
 * - every rail an older legacy child reads from the endpoint author is a
 *   subscription filtered by its own `d` tag (persona inventory, dependant
 *   status, contact policy, contact directory); none asks for this `d` tag, and
 *   the only subscriber of it (`useChildDeviceLink`) runs on direct pairings
 *   only, against the rail key and the direct client key;
 * - should a relay ignore the `d` filter, those readers NIP-44-decrypt the
 *   content first, and this content is plaintext JSON, which fails to decrypt;
 * - and even decrypted, the inventory parser rejects it (no `revision`, no
 *   `extraPersonas`), so it can never read as an empty inventory.
 *
 * **Accepting it** (`acceptLegacyUnpairedNotice`): a validly signed notice from
 * the endpoint named by the stored pairing (the key the child already trusts
 * for the inventory), naming exactly this install's client key, and not older
 * than the pairing (`created_at >= pairedAt - LEGACY_UNPAIR_CLOCK_SKEW_S`).
 *
 * Why the pairing time and not the last inventory revision: the revision cache
 * is one global row that a re-pair clears to 0, so right after a re-pair (the
 * moment an old notice matters) it would let anything through; `pairedAt` is
 * per record and a re-pair rewrites it. The two clocks differ (`pairedAt` is
 * the child's, `created_at` the guardian's), hence the allowance. The author
 * pin is the stronger guard anyway: a revoke clears the endpoint and a re-pair
 * mints a fresh one, so a notice from before a re-pair is signed by a key the
 * re-paired child no longer reads from (a legacy re-pair keeps the client key,
 * so `p` alone could not tell the two pairings apart).
 */
import type { NostrEvent } from 'signet-protocol';
import type { PairedChildRecord } from '../types';
import { buildUnpairedNotice, isUnpairedNotice } from './child-activity';
import { guardianRailPubkey } from './paired-child-rail';
import { publishToEveryRelay } from './sync-relays';

const HEX64 = /^[0-9a-f]{64}$/;

/** How far the guardian's clock may run behind the child's before a genuine notice reads as older than the pairing. */
export const LEGACY_UNPAIR_CLOCK_SKEW_S = 300;
/** A revoke waits this long at most for the notice to publish. */
export const LEGACY_UNPAIR_PUBLISH_CAP_MS = 5_000;

/** The notice for a dependant's paired phone, or null when no phone ever connected (nothing to tell). */
export function buildLegacyUnpairedNotice(
  endpoint: { privateKey?: string; authorizedClientPubkey?: string } | undefined,
  nowS: number = Math.floor(Date.now() / 1000),
): NostrEvent | null {
  const priv = endpoint?.privateKey ?? '';
  const client = (endpoint?.authorizedClientPubkey ?? '').toLowerCase();
  if (!HEX64.test(priv) || !HEX64.test(client)) return null;
  try { return buildUnpairedNotice(priv, client, nowS); } catch { return null; }
}

/**
 * Publish the notice before the endpoint is cleared. Best effort and bounded:
 * resolves false (never throws) when there is nothing to send, the relays are
 * unreachable or the cap passes, and the revoke goes ahead either way.
 */
export async function publishLegacyUnpairedNotice(
  endpoint: { privateKey?: string; authorizedClientPubkey?: string } | undefined,
  relays: readonly string[],
  opts: { publish?: (ev: NostrEvent, relays: readonly string[]) => Promise<boolean>; capMs?: number; nowS?: number } = {},
): Promise<boolean> {
  try {
    const ev = buildLegacyUnpairedNotice(endpoint, opts.nowS);
    if (!ev || relays.length === 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), opts.capMs ?? LEGACY_UNPAIR_PUBLISH_CAP_MS); });
    try {
      return await Promise.race([(opts.publish ?? publishToEveryRelay)(ev, relays).catch(() => false), cap]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Whether `ev` tells THIS legacy pairing it was revoked (see the module note). */
export function acceptLegacyUnpairedNotice(
  ev: NostrEvent,
  record: Pick<PairedChildRecord, 'mode' | 'railPubkey' | 'bunkerUri' | 'clientKeypair' | 'pairedAt'>,
): boolean {
  if (record.mode === 'heartwood-direct') return false;
  const endpoint = guardianRailPubkey(record);
  const client = (record.clientKeypair?.publicKey ?? '').toLowerCase();
  if (!endpoint || !HEX64.test(client)) return false;
  if (!isUnpairedNotice(ev, endpoint, client)) return false;
  const pairedAt = Number.isFinite(record.pairedAt) ? record.pairedAt : 0;
  return typeof ev.created_at === 'number' && ev.created_at >= pairedAt - LEGACY_UNPAIR_CLOCK_SKEW_S;
}
