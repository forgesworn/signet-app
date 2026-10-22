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
  applyAck, findKeep, markRevokeSent, newPendingKeep, parseStoredKeeps, withInvite, withKeep,
  type StoredInvite, type StoredKeep,
} from './keep-store';
import type { KeepPairLink } from './keep-link';
import { KEEP_ACK_LOOKBACK_S, KEEP_GUEST_PASS_S, KEEP_PERSONAL_INVITE_S } from './keep-wire';

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

export async function loadStoredKeeps(encryptionKey: string): Promise<StoredKeep[]> {
  return parseStoredKeeps(await loadKeepsRow(encryptionKey)) ?? [];
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
  | { kind: 'exists'; keep: StoredKeep }
  | { kind: 'claimed'; keep: StoredKeep; sent: boolean };

/**
 * Send the claim. The record is saved first (as `pending`), so a failure to
 * reach the relays leaves a Keep the owner can send again, not a lost code.
 */
export async function claimKeep(deps: KeepDeps, link: KeepPairLink, claimedBy: string): Promise<ClaimResult> {
  if (!deps.backendFor(claimedBy)) throw new PersonaNotAvailableError();
  let created: StoredKeep | null = null;
  let existing: StoredKeep | undefined;
  await updateStoredKeeps(deps.encryptionKey, list => {
    existing = findKeep(list, link.keep);
    if (existing) return list;
    created = newPendingKeep({ keep: link.keep, name: link.name, relays: link.relays, claimedBy, code: link.code, now: nowOf(deps) });
    return withKeep(list, created);
  });
  if (existing) return { kind: 'exists', keep: existing };
  const keep = created!;
  const sent = await send(deps, keep, (b, now) => claimRumor(b, keep.keep, link.code, now)).catch(() => false);
  return { kind: 'claimed', keep, sent };
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
): Promise<{ keep: StoredKeep; invite: StoredInvite; sent: boolean }> {
  const now = nowOf(deps);
  const invite: StoredInvite = {
    grant: randomHex(16), secret: randomHex(32), kind: req.kind,
    ...(req.kind === 'personal' ? { persona: req.persona } : {}),
    label: req.kind === 'guest' ? 'Guest pass' : req.label,
    createdAt: now,
    expiration: now + (req.kind === 'guest' ? KEEP_GUEST_PASS_S : KEEP_PERSONAL_INVITE_S),
    status: 'waiting',
  };
  if (req.kind === 'personal' && !/^[0-9a-f]{64}$/.test(req.persona ?? '')) throw new Error('Invalid invite');
  let keep: StoredKeep | undefined;
  await updateStoredKeeps(deps.encryptionKey, list => {
    const found = findKeep(list, keepId);
    if (!found) return list;
    keep = withInvite(found, invite);
    return withKeep(list, keep);
  });
  if (!keep) throw new Error('Unknown Keep');
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
  const acks: KeepAck[] = [];
  for (const wrap of events) {
    const persona = wrap.tags?.find(t => t[0] === 'p')?.[1];
    if (!persona) continue;
    const keeps = new Set(stored.filter(k => k.claimedBy === persona).map(k => k.keep));
    const backend = keeps.size > 0 ? deps.backendFor(persona) : null;
    if (!backend) continue;
    const ack = await unwrapKeepAck(wrap, backend, keeps);
    if (ack) acks.push(ack);
  }
  if (acks.length === 0) return stored;
  return updateStoredKeeps(deps.encryptionKey, list => acks.reduce(applyAck, list));
}

function ackScopes(keeps: readonly StoredKeep[]): Array<{ persona: string; relays: string[] }> {
  const byPersona = new Map<string, Set<string>>();
  for (const k of keeps) {
    const set = byPersona.get(k.claimedBy) ?? new Set<string>();
    k.relays.forEach(r => set.add(r));
    byPersona.set(k.claimedBy, set);
  }
  return [...byPersona].map(([persona, relays]) => ({ persona, relays: [...relays] }));
}

/** One catch-up read of the acks addressed to each owner persona. Resolves with the updated list. */
export async function refreshAcks(deps: KeepDeps): Promise<StoredKeep[]> {
  const keeps = await loadStoredKeeps(deps.encryptionKey);
  const since = nowOf(deps) - KEEP_ACK_LOOKBACK_S;
  for (const { persona, relays } of ackScopes(keeps)) {
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
  const stops = ackScopes(keeps).map(({ persona, relays }) => {
    const filter = { kinds: [1059], '#p': [persona], since: nowOf(deps) - KEEP_ACK_LOOKBACK_S } as unknown as NostrFilter;
    return subscribeEvents([filter], relays, event => {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      void applyAckEvents(deps, [event]).then(onChange, () => undefined);
    });
  });
  return () => stops.forEach(stop => stop());
}
