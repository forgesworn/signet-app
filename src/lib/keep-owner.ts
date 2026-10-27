import { extractEndpointPubkey } from './dependant-status-sync';
import type { StoredKeep } from './keep-store';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The one key a Keep set up with a Heartwood is claimed under: the Heartwood's own master key, which is
 * deliberately NOT one of the persona keys (onboarding refuses a slot equal to it). Only for a bunker install.
 * The live `get_public_key` answer when connected, else the pubkey in the stored bunker:// address (available
 * before reconnect). One key, never both: a lookup sends exactly one key.
 *
 * Never reads a private key. Sent to a relay only when the person picks "My Heartwood" (or it is a remembered
 * key from that pick); it is never part of any other query.
 */
export function heartwoodLookupKey(args: {
  signingMode?: string;
  bunkerUri?: string;
  liveSignerPubkey?: string;
}): string | null {
  if (args.signingMode !== 'bunker') return null;
  for (const candidate of [args.liveSignerPubkey, args.bunkerUri ? extractEndpointPubkey(args.bunkerUri) : null]) {
    const key = (candidate ?? '').toLowerCase();
    if (HEX64.test(key)) return key;
  }
  return null;
}

/**
 * What to ask the relays about, as separate requests (each an array for one `authors` filter, never merged):
 * - each saved Keep asks about its own keys only, the claimer and the personas linked to it;
 * - each remembered lookup key asks about that key alone, unless a saved Keep's own keys already cover it.
 * Identical key sets are asked once.
 *
 * `owned` is the keys the CURRENT account can look under (its active personas, and the Heartwood master only
 * while it is offered). Any key outside it is dropped at query time and a group left empty is skipped: the
 * remembered row is device-wide, so a deleted persona, a disconnected Heartwood or another identity on the
 * same device must never have its key sent. Nothing is deleted from storage here.
 */
export function keepLookupGroups(stored: readonly StoredKeep[], remembered: readonly string[], owned: readonly string[]): string[][] {
  const mine = new Set(owned.map(k => k.toLowerCase()));
  const groups: string[][] = [];
  const seen = new Set<string>();
  const add = (keys: readonly string[]) => {
    const clean = [...new Set(keys.map(k => k.toLowerCase()).filter(k => HEX64.test(k) && mine.has(k)))].sort();
    const id = clean.join(',');
    if (clean.length === 0 || seen.has(id)) return;
    seen.add(id);
    groups.push(clean);
  };
  for (const keep of stored) add([keep.claimedBy, ...keep.personas]);
  const covered = new Set(groups.flat());
  for (const key of remembered) if (!covered.has(key.toLowerCase())) add([key]);
  return groups;
}
