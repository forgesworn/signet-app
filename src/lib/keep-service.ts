/**
 * Claiming a Keep and managing who may play on it (K1d): the sending and
 * receiving side. Pure logic is in `keep-store.ts` and `keep-messages.ts`;
 * this file glues them to storage and relays.
 *
 * Everything the Keep must see is a gift wrap signed by `claimedBy`, so only
 * personas whose key this device holds (a `LocalSigningBackend`) can do it.
 * `deps.backendFor` returns null for any other persona and the caller shows
 * "Not available for this persona yet".
 */
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent, NostrFilter } from 'signet-protocol';
import { loadKeepsRow, saveKeepsRow } from './db';
import type { DecryptingSigningBackend } from './signing-backend';
import { publishWrappedToRelays } from './relay-publish';
import { fetchEventsWithReach, subscribeEvents } from './relay-service';
import {
  claimRumor, inviteRumor, revokeRumor, unwrapKeepAck, wrapForKeep, type InviteSpec, type KeepAck,
} from './keep-messages';
import {
  KeepsUnreadableError, ackReadSince, advanceAckCursors, applyAck, findKeep, markRevokeSent, newPendingKeep, parseStoredKeeps, repairKeep, withInvite, withKeep,
  type StoredInvite, type StoredKeep,
} from './keep-store';
import type { KeepPairLink } from './keep-link';
import { KEEP_GUEST_PASS_S, KEEP_PERSONAL_INVITE_S } from './keep-wire';

export interface KeepDeps {
  encryptionKey: string;
  /** The signing backend for a persona this device holds the key of; null otherwise. */
  backendFor: (persona: string) => DecryptingSigningBackend | null;
  /** Defaults to publishing to each relay and reporting which accepted. */
  publish?: (wrap: NostrEvent, relays: readonly string[]) => Promise<boolean[]>;
  now?: () => number;
}

export class PersonaNotAvailableError extends Error {
  constructor() { super('Not available for this persona yet'); }
}

const nowOf = (deps: KeepDeps) => (deps.now ?? (() => Math.floor(Date.now() / 1000)))();

// ---- storage ---------------------------------------------------------------

/**
 * The stored list: empty only when nothing is stored. A row that exists but
 * cannot be decrypted or parsed throws `KeepsUnreadableError`, so the next
 * write can never replace Keeps (and invite grants) this build cannot read.
 */
export async function loadStoredKeeps(encryptionKey: string): Promise<StoredKeep[]> {
  let raw: unknown;
  try { raw = await loadKeepsRow(encryptionKey); } catch { throw new KeepsUnreadableError(); }
  if (raw === null || raw === undefined) return [];
  const list = parseStoredKeeps(raw);
  if (!list) throw new KeepsUnreadableError();
  return list;
}

// Read-modify-write is serialised: an ack landing while an invite is being
// saved must not drop either one.
let queue: Promise<unknown> = Promise.resolve();

/** Apply `change` to the stored list and save it when it returned a different list. */
export function updateStoredKeeps(
  encryptionKey: string, change: (list: StoredKeep[]) => StoredKeep[],
): Promise<StoredKeep[]> {
  const run = queue.then(async () => {
    const current = await loadStoredKeeps(encryptionKey);
    const next = change(current);
    if (next !== current) await saveKeepsRow(next, encryptionKey);
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}

// ---- sending ---------------------------------------------------------------

async function send(
  deps: KeepDeps, keep: StoredKeep,
  build: (backend: DecryptingSigningBackend, now: number) => ReturnType<typeof claimRumor>,
): Promise<boolean> {
  const backend = deps.backendFor(keep.claimedBy);
  if (!backend) throw new PersonaNotAvailableError();
  const wrap = await wrapForKeep(build(backend, nowOf(deps)), keep.keep, backend);
  const results = await (deps.publish ?? publishWrappedToRelays)(wrap, keep.relays);
  return results.some(Boolean);
}

export type ClaimResult =
  /** Already added with this very code (a repeat paste): nothing was changed or sent. */
  | { kind: 'exists'; keep: StoredKeep }
  /** Stored under a different owner persona: it is not re-paired from this one. */
  | { kind: 'other-owner'; keep: StoredKeep }
  /** `repaired`: the Keep was already stored and took a new code, keeping its invites. */
  | { kind: 'claimed'; keep: StoredKeep; sent: boolean; repaired?: boolean };

/**
 * Send the claim. The record is saved first (as `pending`), so a failure to
 * reach the relays leaves a Keep the owner can send again, not a lost code.
 *
 * A Keep that is already stored but now shows a different pairing code has been
 * restarted or reset (the code changes at each start). Adding it again then
 * pairs it again: the record and its invites stay, the code, relays and name
 * come from the new link, and it waits for the Keep as a new claim does.
 */
export async function claimKeep(deps: KeepDeps, link: KeepPairLink, claimedBy: string): Promise<ClaimResult> {
  if (!deps.backendFor(claimedBy)) throw new PersonaNotAvailableError();
  const out: { kind: 'exists' | 'other-owner' | 'new' | 'repair'; keep?: StoredKeep } = { kind: 'new' };
  await updateStoredKeeps(deps.encryptionKey, list => {
    const existing = findKeep(list, link.keep);
    if (existing) {
      out.keep = existing;
      if (existing.status === 'pending' && existing.code === link.code) { out.kind = 'exists'; return list; }
      if (existing.claimedBy !== claimedBy) { out.kind = 'other-owner'; return list; }
      out.kind = 'repair';
      out.keep = repairKeep(existing, { name: link.name, relays: link.relays, code: link.code, now: nowOf(deps) });
      return withKeep(list, out.keep);
    }
    out.keep = newPendingKeep({ keep: link.keep, name: link.name, relays: link.relays, claimedBy, code: link.code, now: nowOf(deps) });
    return withKeep(list, out.keep);
  });
  if (out.kind === 'exists' || out.kind === 'other-owner') return { kind: out.kind, keep: out.keep! };
  const keep = out.keep!;
  const sent = await send(deps, keep, (b, now) => claimRumor(b, keep.keep, link.code, now)).catch(() => false);
  return { kind: 'claimed', keep, sent, ...(out.kind === 'repair' ? { repaired: true } : {}) };
}

/** Send the claim again (a lost first claim or a lost `paired` ack). Pending Keeps only. */
export async function resendClaim(deps: KeepDeps, keep: StoredKeep): Promise<boolean> {
  if (keep.status !== 'pending' || !keep.code) return false;
  const code = keep.code;
  return send(deps, keep, (b, now) => claimRumor(b, keep.keep, code, now));
}

function randomHex(bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export interface InviteRequest {
  kind: 'personal' | 'guest';
  /** Personal invite: the contact's persona key and their name. */
  persona?: string;
  label?: string;
}

function specOf(keep: StoredKeep, invite: StoredInvite): InviteSpec {
  return {
    keep: keep.keep, grant: invite.grant, secret: invite.secret, expiration: invite.expiration,
    ...(invite.kind === 'personal' ? { persona: invite.persona } : { guest: true }),
    label: invite.label,
  };
}

/** The link the share sheet gets: identical to the Keep's own `stampede://keep/<K>/<secret>`. */
export function keepShareLink(keep: string, secret: string): string {
  return `stampede://keep/${keep}/${secret}`;
}

/**
 * Make an invite (grant and secret from the CSPRNG), save it as waiting, and
 * send it. Personal invites last 30 days, guest passes 24 hours.
 */
export async function createInvite(
  deps: KeepDeps, keepId: string, req: InviteRequest,
  /** Called once the invite is saved and before it is sent, so a share sheet can open inside the user's tap. */
  onSaved?: (invite: StoredInvite) => void,
): Promise<{ keep: StoredKeep; invite: StoredInvite; sent: boolean }> {
  if (req.kind === 'personal' && !/^[0-9a-f]{64}$/.test(req.persona ?? '')) throw new Error('Invalid invite');
  // Check the owner persona can still sign before anything is saved or shared:
  // otherwise the friend would get a link the Keep never hears of.
  const target = findKeep(await loadStoredKeeps(deps.encryptionKey), keepId);
  if (!target) throw new Error('Unknown Keep');
  if (!deps.backendFor(target.claimedBy)) throw new PersonaNotAvailableError();
  const now = nowOf(deps);
  const invite: StoredInvite = {
    grant: randomHex(16), secret: randomHex(32), kind: req.kind,
    ...(req.kind === 'personal' ? { persona: req.persona } : {}),
    ...(req.kind === 'personal' && req.label ? { label: req.label } : {}),
    createdAt: now,
    expiration: now + (req.kind === 'guest' ? KEEP_GUEST_PASS_S : KEEP_PERSONAL_INVITE_S),
    status: 'waiting',
  };
  let keep: StoredKeep | undefined;
  await updateStoredKeeps(deps.encryptionKey, list => {
    const found = findKeep(list, keepId);
    if (!found) return list;
    keep = withInvite(found, invite);
    return withKeep(list, keep);
  });
  if (!keep) throw new Error('Unknown Keep');
  onSaved?.(invite);
  const sent = await send(deps, keep, (b, t) => inviteRumor(b, specOf(keep!, invite), t)).catch(e => {
    if (e instanceof PersonaNotAvailableError) throw e;
    return false;
  });
  return { keep, invite, sent };
}

/** Send a waiting invite again (same grant, same tags, so the Keep treats it as a repeat). */
export function resendInvite(deps: KeepDeps, keep: StoredKeep, invite: StoredInvite): Promise<boolean> {
  return send(deps, keep, (b, now) => inviteRumor(b, specOf(keep, invite), now));
}

/** Mark the revoke as sent (saved first), then send it. The ack makes it final. */
export async function revokeInvite(deps: KeepDeps, keepId: string, grant: string): Promise<boolean> {
  let keep: StoredKeep | undefined;
  await updateStoredKeeps(deps.encryptionKey, list => {
    const found = findKeep(list, keepId);
    if (!found) return list;
    keep = markRevokeSent(found, grant);
    return withKeep(list, keep);
  });
  if (!keep) return false;
  return send(deps, keep, (b, now) => revokeRumor(b, keepId, grant, now));
}

/** Forget a Keep on this device only (used for a claim that never completed). */
export async function forgetKeep(deps: KeepDeps, keepId: string): Promise<StoredKeep[]> {
  return updateStoredKeeps(deps.encryptionKey, list => (findKeep(list, keepId) ? list.filter(k => k.keep !== keepId) : list));
}

// ---- receiving -------------------------------------------------------------

/** Open gift wraps and apply the acks inside; wraps that are not valid acks from our Keeps are ignored. */
export async function applyAckEvents(deps: KeepDeps, events: readonly NostrEvent[]): Promise<StoredKeep[]> {
  const stored = await loadStoredKeeps(deps.encryptionKey);
  const acks: Array<{ ack: KeepAck; wrapAt: number }> = [];
  for (const wrap of events) {
    const persona = wrap.tags?.find(t => t[0] === 'p')?.[1];
    if (!persona) continue;
    const keeps = new Set(stored.filter(k => k.claimedBy === persona).map(k => k.keep));
    const backend = keeps.size > 0 ? deps.backendFor(persona) : null;
    if (!backend) continue;
    const ack = await unwrapKeepAck(wrap, backend, keeps);
    if (ack && Number.isSafeInteger(wrap.created_at)) acks.push({ ack, wrapAt: wrap.created_at });
  }
  if (acks.length === 0) return stored;
  const now = nowOf(deps);
  return updateStoredKeeps(deps.encryptionKey, list => advanceAckCursors(
    acks.reduce((l, a) => applyAck(l, a.ack), list),
    acks.map(a => ({ keep: a.ack.keep, wrapAt: a.wrapAt })), now,
  ));
}

/**
 * What to read for each owner persona: its acks on every relay of every one of
 * its Keeps' pairing links, from before the oldest Keep's cursor.
 */
function ackScopes(keeps: readonly StoredKeep[], now: number): Array<{ persona: string; relays: string[]; since: number }> {
  const byPersona = new Map<string, StoredKeep[]>();
  for (const k of keeps) byPersona.set(k.claimedBy, [...(byPersona.get(k.claimedBy) ?? []), k]);
  return [...byPersona].map(([persona, group]) => ({
    persona, relays: [...new Set(group.flatMap(k => k.relays))], since: ackReadSince(group, now),
  }));
}

/** One catch-up read of the acks addressed to each owner persona. Resolves with the updated list. */
export async function refreshAcks(deps: KeepDeps): Promise<StoredKeep[]> {
  const keeps = await loadStoredKeeps(deps.encryptionKey);
  for (const { persona, relays, since } of ackScopes(keeps, nowOf(deps))) {
    const filter = { kinds: [1059], '#p': [persona], since } as unknown as NostrFilter;
    const res = await fetchEventsWithReach([filter], { relays }).catch(() => null);
    if (res && res.events.length > 0) await applyAckEvents(deps, res.events);
  }
  return loadStoredKeeps(deps.encryptionKey);
}

/**
 * Keep listening for acks while a Keep screen is open. `onChange` gets the new
 * list after any ack changed it. Returns the stop function.
 */
export function watchAcks(deps: KeepDeps, keeps: readonly StoredKeep[], onChange: (list: StoredKeep[]) => void): () => void {
  const seen = new Set<string>();
  const stops = ackScopes(keeps, nowOf(deps)).map(({ persona, relays, since }) => {
    const filter = { kinds: [1059], '#p': [persona], since } as unknown as NostrFilter;
    return subscribeEvents([filter], relays, event => {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      void applyAckEvents(deps, [event]).then(onChange, () => undefined);
    });
  });
  return () => stops.forEach(stop => stop());
}
