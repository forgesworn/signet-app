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
  claimRumor, inviteRumor, ownerAcceptRumor, ownersUpdateRumor, revokeRumor, unwrapKeepAck, wrapForKeep, type InviteSpec, type KeepAck,
} from './keep-messages';
import {
  KeepsUnreadableError, ackReadSince, advanceAckCursors, applyAck, findKeep, markInviteSent, markRevokeSent, newPendingKeep, parseStoredKeeps, repairKeep, resendDue, withInvite, withKeep,
  type KeepScope, type StoredInvite, type StoredKeep,
} from './keep-store';
import {
  applyOwnersAck, canUnlink, composeUpdate, isActiveOwner, linkPersona, markOwnersSent, ownersDue, pickSigner, reconcileKeep,
  retryGames, setSection, unlinkPersona, type ReconcileContext,
} from './keep-owners';
import type { KeepPairLink } from './keep-link';
import { KEEP_GUEST_PASS_S, KEEP_PERSONAL_INVITE_S, KEEP_SECTION_GAMES } from './keep-wire';

export interface KeepDeps {
  encryptionKey: string;
  /** The signing backend for a persona this device holds the key of; null otherwise. */
  backendFor: (persona: string) => DecryptingSigningBackend | null;
  /**
   * Every persona of the account this device can sign for, dependants left out (K1e). An
   * `all` Keep links these, new ones too. Absent: nothing is linked by itself.
   */
  eligiblePersonas?: () => string[];
  /** The name the person gave a persona, for the label of its games invite. */
  personaName?: (persona: string) => string;
  /** Defaults to publishing to each relay and reporting which accepted. */
  publish?: (wrap: NostrEvent, relays: readonly string[]) => Promise<boolean[]>;
  now?: () => number;
}

export class PersonaNotAvailableError extends Error {
  constructor() { super('Not available for this persona yet'); }
}

/** The signed-in persona is not an active owner persona of this Keep. */
export class NotAnOwnerError extends Error {
  constructor() { super('This persona is not linked to the Keep'); }
}

/** A change of the owner list that cannot be made (full list, or no active owner would remain). */
export class OwnerChangeRefusedError extends Error {
  constructor(message: string) { super(message); }
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
  deps: KeepDeps, keep: StoredKeep, signer: string,
  build: (backend: DecryptingSigningBackend, now: number) => ReturnType<typeof claimRumor>,
): Promise<boolean> {
  const backend = deps.backendFor(signer);
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
export async function claimKeep(deps: KeepDeps, link: KeepPairLink, claimedBy: string, scope: KeepScope = 'one'): Promise<ClaimResult> {
  if (!deps.backendFor(claimedBy)) throw new PersonaNotAvailableError();
  const out: { kind: 'exists' | 'other-owner' | 'new' | 'repair'; keep?: StoredKeep } = { kind: 'new' };
  await updateStoredKeeps(deps.encryptionKey, list => {
    const existing = findKeep(list, link.keep);
    if (existing) {
      out.keep = existing;
      if (existing.status === 'pending' && existing.code === link.code) { out.kind = 'exists'; return list; }
      if (existing.claimedBy !== claimedBy) { out.kind = 'other-owner'; return list; }
      out.kind = 'repair';
      out.keep = repairKeep(existing, { name: link.name, relays: link.relays, code: link.code, now: nowOf(deps), scope });
      return withKeep(list, out.keep);
    }
    out.keep = newPendingKeep({ keep: link.keep, name: link.name, relays: link.relays, claimedBy, code: link.code, now: nowOf(deps), scope });
    return withKeep(list, out.keep);
  });
  if (out.kind === 'exists' || out.kind === 'other-owner') return { kind: out.kind, keep: out.keep! };
  const keep = out.keep!;
  const sent = await send(deps, keep, claimedBy, (b, now) => claimRumor(b, keep.keep, link.code, now, keep.scope)).catch(() => false);
  return { kind: 'claimed', keep, sent, ...(out.kind === 'repair' ? { repaired: true } : {}) };
}

/** Send the claim again (a lost first claim or a lost `paired` ack). Pending Keeps only. */
export async function resendClaim(deps: KeepDeps, keep: StoredKeep): Promise<boolean> {
  if (keep.status !== 'pending' || !keep.code) return false;
  const code = keep.code;
  return send(deps, keep, keep.claimedBy, (b, now) => claimRumor(b, keep.keep, code, now, keep.scope));
}

function randomHex(bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export interface InviteRequest {
  kind: 'personal' | 'guest';
  /** Personal invite: the contact's persona key and their name. */
  persona?: string;
  label?: string;
  /** The signed-in persona, which signs it (it must be an active owner persona). Absent: the claimer, or another active owner. */
  actor?: string;
}

/** The owner persona to sign with: the actor if it is an active owner we hold, else the claimer or another active one. */
function signerFor(deps: KeepDeps, keep: StoredKeep, actor?: string): string {
  const signer = pickSigner(keep, p => deps.backendFor(p) !== null, actor);
  if (!signer) throw new PersonaNotAvailableError();
  return signer;
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
  const signer = signerFor(deps, target, req.actor);
  const now = nowOf(deps);
  const invite: StoredInvite = {
    grant: randomHex(16), secret: randomHex(32), kind: req.kind,
    ...(req.kind === 'personal' ? { persona: req.persona } : {}),
    ...(req.kind === 'personal' && req.label ? { label: req.label } : {}),
    createdAt: now,
    expiration: now + (req.kind === 'guest' ? KEEP_GUEST_PASS_S : KEEP_PERSONAL_INVITE_S),
    status: 'waiting',
    sentAt: now,
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
  const sent = await send(deps, keep, signer, (b, t) => inviteRumor(b, specOf(keep!, invite), t)).catch(e => {
    if (e instanceof PersonaNotAvailableError) throw e;
    return false;
  });
  return { keep, invite, sent };
}

/** Send a waiting invite again (same grant, same tags, so the Keep treats it as a repeat). */
export async function resendInvite(deps: KeepDeps, keep: StoredKeep, invite: StoredInvite, actor?: string): Promise<boolean> {
  const signer = signerFor(deps, keep, actor);
  const at = nowOf(deps);
  await updateStoredKeeps(deps.encryptionKey, list => {
    const found = findKeep(list, keep.keep);
    return found ? withKeep(list, markInviteSent(found, invite.grant, at)) : list;
  });
  return send(deps, keep, signer, (b, now) => inviteRumor(b, specOf(keep, invite), now));
}

/** Mark the revoke as sent (saved first), then send it. The ack makes it final. */
export async function revokeInvite(deps: KeepDeps, keepId: string, grant: string, actor?: string): Promise<boolean> {
  let keep: StoredKeep | undefined;
  await updateStoredKeeps(deps.encryptionKey, list => {
    const found = findKeep(list, keepId);
    if (!found) return list;
    keep = markRevokeSent(found, grant, nowOf(deps));
    return withKeep(list, keep);
  });
  if (!keep) return false;
  return send(deps, keep, signerFor(deps, keep, actor), (b, now) => revokeRumor(b, keepId, grant, now));
}

/**
 * Send again what the Keep has not answered: an owners update and accepts (K1e), invites still
 * waiting and revokes not yet acked `revoked`, for paired Keeps, when the last send is over 10
 * minutes old (see `ownersDue`, `resendDue`). Things just made (`sentAt` 0) are due at once.
 * Each is stamped as sent before it goes out, inside the serialised write, so two callers (the
 * list and the Keep's page opening together) send it once. A send that fails is tried again after
 * the next 10 minutes, or by the owner with Send again. An accept is signed by its own persona;
 * the rest by an owner persona the Keep counts as active. Order: update, accepts, invites, revokes.
 * Returns how many were sent.
 */
export async function resendOutstanding(deps: KeepDeps): Promise<number> {
  const at = nowOf(deps);
  const canSign = (p: string) => deps.backendFor(p) !== null;
  const batch: Array<{ keep: StoredKeep; signer: string; build: (b: DecryptingSigningBackend, now: number) => ReturnType<typeof claimRumor> }> = [];
  await updateStoredKeeps(deps.encryptionKey, list => {
    let next = list as StoredKeep[];
    for (const k of list) {
      let updated = k;
      const owners = ownersDue(k, at);
      const stamped = { update: false, accepts: [] as string[] };
      const out: typeof batch = [];
      const update = k.update;
      if (owners.update && update && canSign(update.signer)) {
        stamped.update = true;
        out.push({ keep: k, signer: update.signer, build: (b, now) => ownersUpdateRumor(b, k.keep, update.rev, update.personas, now) });
      }
      for (const p of owners.accepts) {
        const rev = k.links[p].accept!.rev;
        if (!canSign(p)) continue;
        stamped.accepts.push(p);
        out.push({ keep: k, signer: p, build: (b, now) => ownerAcceptRumor(b, k.keep, rev, now) });
      }
      updated = markOwnersSent(updated, stamped, at);
      const signer = pickSigner(k, canSign);
      if (signer) {
        for (const { invite, revoke } of resendDue(k, at)) {
          updated = revoke ? markRevokeSent(updated, invite.grant, at) : markInviteSent(updated, invite.grant, at);
          out.push({ keep: k, signer, build: (b, now) => (revoke ? revokeRumor(b, k.keep, invite.grant, now) : inviteRumor(b, specOf(k, invite), now)) });
        }
      }
      if (out.length === 0) continue;
      batch.push(...out.map(o => ({ ...o, keep: updated })));
      next = withKeep(next, updated);
    }
    return next;
  });
  let sent = 0;
  for (const { keep, signer, build } of batch) {
    try {
      await send(deps, keep, signer, build);
      sent++;
    } catch { /* tried again at the next opening */ }
  }
  return sent;
}

// ---- owner personas (K1e) --------------------------------------------------

function reconcileContext(deps: KeepDeps): ReconcileContext {
  return {
    now: nowOf(deps),
    eligible: deps.eligiblePersonas?.() ?? [],
    canSign: p => deps.backendFor(p) !== null,
    nameOf: deps.personaName ?? (p => `Persona ${p.slice(0, 8)}`),
    randomHex,
  };
}

/** Bring every paired Keep in line with what the owner wants (see `reconcileKeep`) and save it. Sends nothing. */
export function reconcileKeeps(deps: KeepDeps): Promise<StoredKeep[]> {
  return updateStoredKeeps(deps.encryptionKey, list => {
    const ctx = reconcileContext(deps);
    let changed = false;
    const next = list.map(k => { const r = reconcileKeep(k, ctx); if (r !== k) changed = true; return r; });
    return changed ? next : list;
  });
}

/** Reconcile, then send whatever is due. Resolves with the new list. */
export async function settle(deps: KeepDeps): Promise<StoredKeep[]> {
  await reconcileKeeps(deps);
  await resendOutstanding(deps);
  return loadStoredKeeps(deps.encryptionKey);
}

export type OwnerChange =
  | { kind: 'link'; persona: string }
  | { kind: 'unlink'; persona: string }
  | { kind: 'games'; persona: string; on: boolean }
  /** Make the update again after the Keep gave it up. */
  | { kind: 'retry' };

/**
 * Change the owner list as `actor`, the signed-in persona, which must be an active owner persona
 * of the Keep with its key on this device. The new list goes out as the next revision; a persona
 * being added also needs its own key (it signs its accept, in the same tap). Games off, or
 * unlinking, revokes that persona's games invite; Games on makes one. Resolves with the new list.
 */
export async function changeOwners(deps: KeepDeps, keepId: string, actor: string, change: OwnerChange): Promise<StoredKeep[]> {
  if (!deps.backendFor(actor)) throw new PersonaNotAvailableError();
  if (change.kind === 'link' && !deps.backendFor(change.persona)) throw new PersonaNotAvailableError();
  await updateStoredKeeps(deps.encryptionKey, list => {
    const found = findKeep(list, keepId);
    if (!found || found.status !== 'paired') throw new OwnerChangeRefusedError('This Keep is not connected yet.');
    if (!isActiveOwner(found, actor)) throw new NotAnOwnerError();
    let changed: StoredKeep | null = found;
    if (change.kind === 'link') changed = linkPersona(found, change.persona);
    else if (change.kind === 'unlink') changed = canUnlink(found, change.persona) ? unlinkPersona(found, change.persona) : null;
    else if (change.kind === 'games') changed = setSection(found, change.persona, KEEP_SECTION_GAMES, change.on);
    else if (!found.update?.failed) changed = null;
    if (!changed) {
      if (change.kind === 'link') throw new OwnerChangeRefusedError('That persona is already linked, or the list is full.');
      if (change.kind === 'unlink') throw new OwnerChangeRefusedError('At least one persona the Keep has confirmed must stay linked.');
      return list; // nothing to change
    }
    const composed = composeUpdate(changed, actor, nowOf(deps));
    return withKeep(list, reconcileKeep(composed, reconcileContext(deps)));
  });
  return settle(deps);
}

/** Try again a games invite the Keep refused: a new grant for the persona, sent at once. */
export async function retryGamesInvite(deps: KeepDeps, keepId: string, actor: string, persona: string): Promise<StoredKeep[]> {
  if (!deps.backendFor(actor)) throw new PersonaNotAvailableError();
  await updateStoredKeeps(deps.encryptionKey, list => {
    const found = findKeep(list, keepId);
    if (!found || found.status !== 'paired') throw new OwnerChangeRefusedError('This Keep is not connected yet.');
    if (!isActiveOwner(found, actor)) throw new NotAnOwnerError();
    const next = retryGames(found, persona, reconcileContext(deps));
    return next ? withKeep(list, next) : list;
  });
  return settle(deps);
}

/** What opening the Keeps does: read the acks, bring the owner list and games invites in line, send what is due. Resolves with the new list. */
export async function catchUp(deps: KeepDeps): Promise<StoredKeep[]> {
  await refreshAcks(deps);
  return settle(deps);
}

/** Forget a Keep on this device only (used for a claim that never completed). */
export async function forgetKeep(deps: KeepDeps, keepId: string): Promise<StoredKeep[]> {
  return updateStoredKeeps(deps.encryptionKey, list => (findKeep(list, keepId) ? list.filter(k => k.keep !== keepId) : list));
}

// ---- receiving -------------------------------------------------------------

/** Open gift wraps and apply the acks inside; wraps that are not valid acks from our Keeps are ignored. */
export async function applyAckEvents(deps: KeepDeps, events: readonly NostrEvent[]): Promise<StoredKeep[]> {
  const stored = await loadStoredKeeps(deps.encryptionKey);
  const acks: Array<{ ack: KeepAck; persona: string; wrapAt: number }> = [];
  for (const wrap of events) {
    const persona = wrap.tags?.find(t => t[0] === 'p')?.[1];
    if (!persona) continue;
    const keeps = new Set(stored.filter(k => ackPersonas(k).includes(persona)).map(k => k.keep));
    const backend = keeps.size > 0 ? deps.backendFor(persona) : null;
    if (!backend) continue;
    const ack = await unwrapKeepAck(wrap, backend, keeps);
    if (ack && Number.isSafeInteger(wrap.created_at)) acks.push({ ack, persona, wrapAt: wrap.created_at });
  }
  if (acks.length === 0) return stored;
  const now = nowOf(deps);
  return updateStoredKeeps(deps.encryptionKey, list => advanceAckCursors(
    acks.reduce((l, a) => (a.ack.owners ? applyOwnersAck(l, a.ack, now) : applyAck(l, a.ack)), list),
    acks.map(a => ({ keep: a.ack.keep, persona: a.persona, wrapAt: a.wrapAt })), now,
  ));
}

/** The personas whose key an ack for this Keep may be addressed to: the claimer, every linked persona, the signer of an update. */
export function ackPersonas(keep: StoredKeep): string[] {
  return [...new Set([keep.claimedBy, ...keep.personas, ...(keep.update ? [keep.update.signer] : [])])];
}

/**
 * What to read for each owner persona: its acks on every relay of every one of its Keeps' pairing
 * links, from before the oldest of the persona's own cursors for those Keeps.
 */
function ackScopes(keeps: readonly StoredKeep[], now: number): Array<{ persona: string; relays: string[]; since: number }> {
  const byPersona = new Map<string, StoredKeep[]>();
  for (const k of keeps) for (const p of ackPersonas(k)) byPersona.set(p, [...(byPersona.get(p) ?? []), k]);
  return [...byPersona].map(([persona, group]) => ({
    persona, relays: [...new Set(group.flatMap(k => k.relays))], since: ackReadSince(group, persona, now),
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
      // An ack can make something due (an update after `paired`, an accept after `updated`): send it now.
      void applyAckEvents(deps, [event]).then(() => settle(deps)).then(onChange, () => undefined);
    });
  });
  return () => stops.forEach(stop => stop());
}
