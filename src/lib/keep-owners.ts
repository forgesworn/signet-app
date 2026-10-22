/**
 * Owner personas of a Keep (K1e): who is linked, what the Keep has confirmed,
 * and the owners updates, accepts and games invites that follow from it. Pure
 * state changes only; `keep-service.ts` signs and sends.
 *
 * The record keeps what the owner WANTS in `links` (switches take effect there
 * at once) and the one update that is still unanswered in `update`. Each change
 * of the list makes a new update at the next revision; it replaces an
 * unanswered one (the Keep applies the highest revision). A linked persona
 * counts as active here only once the Keep has said it accepted.
 */
import {
  KEEP_GAMES_INVITE_S, KEEP_GAMES_RENEW_BEFORE_S, KEEP_MAX_OWNER_PERSONAS, KEEP_RESEND_AFTER_S, KEEP_SECTION_GAMES,
} from './keep-wire';
import type { KeepAck } from './keep-messages';
import {
  CLAIM_ACK_SKEW_S, isExpired, withKeep, type PendingUpdate, type PersonaLink, type StoredInvite, type StoredKeep,
} from './keep-store';

// ---- who is an owner -------------------------------------------------------

/** Linked, and the Keep has confirmed the persona accepted (the claimer, until unlinked, always has). */
export function isActiveOwner(keep: StoredKeep, persona: string): boolean {
  return keep.links[persona]?.active === true;
}

export function activeOwners(keep: StoredKeep): string[] {
  return keep.personas.filter(p => keep.links[p]?.active);
}

export function isLinked(keep: StoredKeep, persona: string): boolean {
  return keep.links[persona] !== undefined;
}

export function gamesOn(keep: StoredKeep, persona: string): boolean {
  return keep.links[persona]?.sections.includes(KEEP_SECTION_GAMES) === true;
}

/**
 * The owner persona that signs a message nobody asked for in the moment (a
 * renewal, a resend, an auto-link): the one preferred, else the claimer, else
 * any other active owner, each only if this device holds its key.
 */
export function pickSigner(keep: StoredKeep, canSign: (persona: string) => boolean, prefer?: string): string | null {
  const order = [prefer, keep.claimedBy, ...activeOwners(keep)];
  for (const p of order) if (p && isActiveOwner(keep, p) && canSign(p)) return p;
  return null;
}

function withLinks(keep: StoredKeep, links: Record<string, PersonaLink>): StoredKeep {
  return { ...keep, links, personas: Object.keys(links) };
}

// ---- changing the list -----------------------------------------------------

/**
 * Make an owners update from the current links, at the next revision, signed
 * by `signer`; and an accept for each linked persona the Keep has not yet
 * confirmed. It replaces any update that has not been answered.
 */
export function composeUpdate(keep: StoredKeep, signer: string, now: number): StoredKeep {
  const rev = Math.max(keep.rev, keep.update?.rev ?? 0) + 1;
  const links: Record<string, PersonaLink> = {};
  for (const p of keep.personas) {
    const { accept: _old, ...l } = keep.links[p];
    links[p] = { ...l, addedRev: l.addedRev ?? rev, ...(l.active ? {} : { accept: { rev, sentAt: 0, composedAt: now } }) };
  }
  const update: PendingUpdate = {
    rev, signer, sentAt: 0, composedAt: now,
    // A refusal already seen stays a repeat for the update that replaces the refused one.
    ...(keep.update?.refusedAt !== undefined ? { refusedAt: keep.update.refusedAt } : {}),
    personas: keep.personas.map(p => ({ persona: p, sections: [...links[p].sections] })),
  };
  return { ...withLinks(keep, links), update };
}

/** The list with `persona` added (games on), or null when it is linked already or the list is full. */
export function linkPersona(keep: StoredKeep, persona: string): StoredKeep | null {
  if (isLinked(keep, persona) || keep.personas.length >= KEEP_MAX_OWNER_PERSONAS) return null;
  const next = withLinks(keep, { ...keep.links, [persona]: { sections: [KEEP_SECTION_GAMES], active: false } });
  return keep.seen.includes(persona) ? next : { ...next, seen: [...keep.seen, persona] };
}

/** True when `persona` can be taken off: at least one other persona the Keep counts as active must remain. */
export function canUnlink(keep: StoredKeep, persona: string): boolean {
  return isLinked(keep, persona) && activeOwners(keep).some(p => p !== persona);
}

/** The list without `persona`, or null when that would leave no active owner. It is not linked again by the auto-link. */
export function unlinkPersona(keep: StoredKeep, persona: string): StoredKeep | null {
  if (!canUnlink(keep, persona)) return null;
  const { [persona]: _gone, ...rest } = keep.links;
  const next = withLinks(keep, rest);
  return keep.seen.includes(persona) ? next : { ...next, seen: [...keep.seen, persona] };
}

export function setSection(keep: StoredKeep, persona: string, section: string, on: boolean): StoredKeep | null {
  const l = keep.links[persona];
  if (!l || l.sections.includes(section) === on) return null;
  const sections = on ? [...l.sections, section] : l.sections.filter(s => s !== section);
  return withLinks(keep, { ...keep.links, [persona]: { ...l, sections } });
}

// ---- what the Keep tells us ------------------------------------------------

/**
 * Apply an ack of an owners update or accept (`ack.owners`, sent to `ack.to`):
 * - `updated` at the revision of our unanswered update, to its signer: the update is in. A persona whose
 *   accept the Keep held as `pending` gets it sent again, now that the Keep lists the persona.
 * - `updated` to a persona with an outstanding accept at or below that revision: it is active.
 * - `pending` to a persona with an outstanding accept: the Keep has it and waits for the update.
 * - `refused stale` to the signer of our update: the Keep is at a revision at or above ours. Take its
 *   revision, make the update again one higher, once; the second time it is given up.
 * - any other refusal to the signer of our update: given up.
 * Relays return old acks again (after a re-pair, or on every new subscription), and a revision alone does
 * not say which message an ack answers. So an ack counts only if it is dated after the claim (as the claim
 * ack already must be) and after the update or accept it answers was made. `now` is the time of any
 * update this makes again. Returns the same list when nothing changed.
 */
export function applyOwnersAck(list: readonly StoredKeep[], ack: KeepAck, now: number): StoredKeep[] {
  const keep = list.find(k => k.keep === ack.keep);
  if (!keep || !ack.owners || !ack.to) return list as StoredKeep[];
  if (ack.at < keep.claimedAt - CLAIM_ACK_SKEW_S) return list as StoredKeep[]; // from before this pairing
  const to = ack.to;
  const update = keep.update;
  const link = keep.links[to];
  let next: StoredKeep = keep;

  if (ack.status === 'updated' && ack.rev !== undefined) {
    // The Keep was at this revision when it sent the ack, whatever the ack answers.
    next = { ...next, rev: Math.max(next.rev, ack.rev) };
    if (update && update.signer === to && !update.failed && ack.rev === update.rev && ack.at >= update.composedAt - CLAIM_ACK_SKEW_S) {
      const { update: _done, ...rest } = next;
      const links = { ...rest.links };
      for (const p of rest.personas) {
        const a = links[p].accept;
        if (a?.pending) links[p] = { ...links[p], accept: { rev: a.rev, sentAt: 0, composedAt: a.composedAt } };
      }
      next = withLinks(rest as StoredKeep, links);
    } else if (link?.accept && ack.rev >= link.accept.rev && ack.at >= link.accept.composedAt - CLAIM_ACK_SKEW_S) {
      const { accept: _accept, ...active } = link;
      next = withLinks(next, { ...next.links, [to]: { ...active, active: true } });
    }
  } else if (ack.status === 'pending' && ack.rev !== undefined) {
    next = { ...next, rev: Math.max(next.rev, ack.rev) };
    if (link?.accept && !link.accept.pending && ack.at >= link.accept.composedAt - CLAIM_ACK_SKEW_S) {
      next = withLinks(next, { ...next.links, [to]: { ...link, accept: { ...link.accept, pending: true } } });
    }
  } else if (
    ack.status === 'refused' && update && update.signer === to && !update.failed
    && ack.at >= update.composedAt - CLAIM_ACK_SKEW_S && (update.refusedAt === undefined || ack.at > update.refusedAt)
  ) {
    const seen: PendingUpdate = { ...update, refusedAt: ack.at };
    if (ack.reason === 'stale' && ack.rev !== undefined) {
      if (ack.rev < update.rev) return list as StoredKeep[]; // refused an older send of ours; the newer one stands
      next = { ...next, rev: Math.max(next.rev, ack.rev) };
      if (update.retried) {
        next = { ...next, update: { ...seen, failed: 'stale' } };
      } else {
        const again = composeUpdate({ ...next, update: seen }, update.signer, now);
        next = { ...again, update: { ...again.update!, retried: true } };
      }
    } else if (ack.reason === 'too_many' || ack.reason === 'malformed') {
      next = { ...next, update: { ...seen, failed: ack.reason } };
    } else {
      return list as StoredKeep[];
    }
  }
  return next === keep ? list as StoredKeep[] : withKeep(list, next);
}

/**
 * What to send for a paired Keep: an update the Keep has not answered; and, once no update is outstanding, the
 * accepts it has not confirmed (never together with the update that lists the persona).
 */
export function ownersDue(keep: StoredKeep, now: number): { update: boolean; accepts: string[] } {
  if (keep.status !== 'paired') return { update: false, accepts: [] };
  const update = !!keep.update && !keep.update.failed && now - keep.update.sentAt > KEEP_RESEND_AFTER_S;
  const accepts: string[] = [];
  if (!keep.update?.failed) {
    for (const p of keep.personas) {
      const a = keep.links[p].accept;
      if (!a) continue;
      // An accept goes only once the Keep has acked the update that lists the persona (sent earlier it is
      // only held, and may be evicted). The resend rule below covers a lost accept.
      if (keep.update) continue;
      if (now - a.sentAt > KEEP_RESEND_AFTER_S) accepts.push(p);
    }
  }
  return { update, accepts };
}

/** Note when the update, and which accepts, went out (or were tried). */
export function markOwnersSent(keep: StoredKeep, sent: { update: boolean; accepts: readonly string[] }, now: number): StoredKeep {
  let next = keep;
  if (sent.update && keep.update) next = { ...next, update: { ...keep.update, sentAt: now } };
  if (sent.accepts.length > 0) {
    const links = { ...next.links };
    for (const p of sent.accepts) {
      const a = links[p]?.accept;
      if (a) links[p] = { ...links[p], accept: { ...a, sentAt: now } };
    }
    next = withLinks(next, links);
  }
  return next;
}

// ---- games invites of the owner personas -----------------------------------

const GAMES_LABEL_NAME_MAX = 31; // plus " (owner)", the contract's 40

function liveInvite(i: StoredInvite, now: number): boolean {
  return (i.status === 'waiting' || i.status === 'active') && !i.revokeSent && !isExpired(i, now);
}

/** An owner persona's own games invites (not a member's). */
export function gamesInvitesFor(keep: StoredKeep, persona: string): StoredInvite[] {
  return keep.invites.filter(i => i.gamesFor === persona);
}

/** The invite to hand to the game for `persona`: the live active one that lasts longest; null when there is none yet. */
export function playInvite(keep: StoredKeep, persona: string, now: number): StoredInvite | null {
  const active = gamesInvitesFor(keep, persona).filter(i => i.status === 'active' && liveInvite(i, now));
  return active.sort((a, b) => b.expiration - a.expiration)[0] ?? null;
}

/** Where `persona`'s games invite stands, for the words next to its switch. */
export function gamesState(keep: StoredKeep, persona: string, now: number): 'off' | 'ready' | 'waiting' | 'refused' {
  if (!gamesOn(keep, persona)) return 'off';
  const mine = gamesInvitesFor(keep, persona).sort((a, b) => b.createdAt - a.createdAt);
  const play = playInvite(keep, persona, now);
  if (play) {
    // Still playable, but the renewal was refused: say so, so the owner can try again before it runs out.
    return mine[0]?.status === 'refused' && play.expiration - now < KEEP_GAMES_RENEW_BEFORE_S ? 'refused' : 'ready';
  }
  if (mine.some(i => liveInvite(i, now))) return 'waiting';
  return mine[0]?.status === 'refused' ? 'refused' : 'waiting';
}

function newGamesInvite(persona: string, ctx: ReconcileContext): StoredInvite {
  const name = Array.from(ctx.nameOf(persona)).slice(0, GAMES_LABEL_NAME_MAX).join('');
  return {
    grant: ctx.randomHex(16), secret: ctx.randomHex(32), kind: 'personal', persona, gamesFor: persona,
    label: `${name} (owner)`, createdAt: ctx.now, expiration: ctx.now + KEEP_GAMES_INVITE_S,
    status: 'waiting', sentAt: 0,
  };
}

/** A new games invite for a persona whose last one the Keep refused (the owner chose to try again). Null if there is nothing to retry. */
export function retryGames(keep: StoredKeep, persona: string, ctx: ReconcileContext): StoredKeep | null {
  if (gamesState(keep, persona, ctx.now) !== 'refused') return null;
  return { ...keep, invites: [...keep.invites, newGamesInvite(persona, ctx)] };
}

export interface ReconcileContext {
  now: number;
  /** Every persona of the account this device can sign for, dependants left out. */
  eligible: readonly string[];
  canSign: (persona: string) => boolean;
  nameOf: (persona: string) => string;
  randomHex: (bytes: number) => string;
}

/**
 * Bring a paired Keep in line with what the owner wants, without sending:
 * 1. an `all` Keep links every persona it has not met (new ones included);
 * 2. each linked persona with Games on has a live games invite, and gets a new one when less than 30
 *    days of it are left;
 * 3. an invite the owner no longer wants (Games off, persona unlinked, or a newer one is active) is marked
 *    to be revoked.
 * Idempotent; returns the same object when nothing needed doing.
 */
export function reconcileKeep(keep: StoredKeep, ctx: ReconcileContext): StoredKeep {
  if (keep.status !== 'paired') return keep;
  let k = keep;
  const { now } = ctx;

  if (k.scope === 'all' && !k.update?.failed) {
    const room = KEEP_MAX_OWNER_PERSONAS - k.personas.length;
    const fresh = ctx.eligible.filter(p => !k.seen.includes(p) && !isLinked(k, p)).slice(0, Math.max(room, 0));
    // Right after pairing, an `all` Keep sends its first list (rev 1) even with only the claimer on it.
    const first = k.rev === 0 && !k.update;
    const signer = fresh.length > 0 || first ? pickSigner(k, ctx.canSign) : null;
    if (signer) {
      let added: StoredKeep = k;
      for (const p of fresh) added = linkPersona(added, p) ?? added;
      k = composeUpdate(added, signer, now);
    }
  }

  // Games invites.
  let invites = k.invites;
  const mark = (i: StoredInvite) => { invites = invites.map(x => (x.grant === i.grant ? { ...x, revokeSent: true, revokeSentAt: 0 } : x)); };
  const owners = new Set<string>([...k.personas, ...k.invites.flatMap(i => (i.gamesFor ? [i.gamesFor] : []))]);
  for (const p of owners) {
    const mine = invites.filter(i => i.gamesFor === p);
    const wanted = gamesOn(k, p);
    if (!wanted) {
      for (const i of mine) if (i.status !== 'revoked' && !i.revokeSent && (i.status === 'waiting' || i.status === 'active')) mark(i);
      continue;
    }
    const live = mine.filter(i => liveInvite(i, now));
    const newest = [...live].sort((a, b) => b.expiration - a.expiration)[0];
    const latest = [...mine].sort((a, b) => b.createdAt - a.createdAt)[0];
    // A refusal of the newest invite stands until the owner tries again; renewing (or making the first one) again
    // and again would only be refused again each time.
    const needs = latest?.status !== 'refused' && (live.length === 0 || newest.expiration - now < KEEP_GAMES_RENEW_BEFORE_S);
    if (needs) invites = [...invites, newGamesInvite(p, ctx)];
    // An older invite goes once a newer one is active.
    const active = live.filter(i => i.status === 'active').sort((a, b) => b.expiration - a.expiration)[0];
    if (active && active.expiration - now >= KEEP_GAMES_RENEW_BEFORE_S) {
      for (const i of live) if (i.expiration < active.expiration) mark(i);
    }
  }
  return invites === k.invites ? k : { ...k, invites };
}

// ---- words -----------------------------------------------------------------

/**
 * "All of you" when every persona of the account is linked (and the Keep was
 * made for all of them, or there is more than one persona), else "Only A, B".
 */
export function scopeLabel(keep: StoredKeep, accountPersonas: readonly string[], nameOf: (persona: string) => string): string {
  const all = accountPersonas.length > 0 && accountPersonas.every(p => isLinked(keep, p));
  if (all && (keep.scope === 'all' || accountPersonas.length > 1)) return 'All of you';
  return `Only ${keep.personas.map(nameOf).join(', ')}`;
}

export function updateFailedText(update: PendingUpdate | undefined): string | null {
  if (!update?.failed) return null;
  return update.failed === 'stale'
    ? 'The Keep has a newer list than this phone could match. Try again.'
    : 'The Keep did not take the change. Try again.';
}
