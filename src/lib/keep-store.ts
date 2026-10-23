/**
 * The Keeps this account has claimed (K1d, K1e), one account-level list.
 *
 * A Keep is not tied to a persona's view: every record names the persona that
 * sent the claim (`claimedBy`) and the owner personas linked to it (`personas`,
 * with the state of each in `links`). Invites and revokes for a Keep are signed
 * by an owner persona the Keep counts as active (see `keep-owners.ts`).
 *
 * K1f fields (`passes`, `settings`, `passesRequestedAt`) are optional and added the same way: a record
 * without them reads as no passes, the default setting and no request sent yet.
 *
 * K1e fields (`scope`, `rev`, `links`, `seen`, `update`) are added to the K1d
 * record in place: a K1d record reads as scope `one`, revision 0, the claimer
 * as its only owner persona. `personas` and every K1d field keep their shape, so
 * an older build still reads a newer record.
 *
 * Stored as ONE encrypted `identity`-store row (see `db.ts`), so there is no
 * IndexedDB version change. The invite secrets in it are what lets someone
 * join the Keep, hence the encryption. This file holds the shape, validation
 * and the pure state changes; `keep-service.ts` does the sending.
 */
import type { KeepAck, KeepPassReport, PassState, PassVia, RefusalReason } from './keep-messages';
import {
  KEEP_ACK_BACKDATE_S, KEEP_ACK_FIRST_LOOKBACK_S, KEEP_MAX_PASSES, KEEP_PASSES_REQUEST_AFTER_S, KEEP_PASS_STATES, KEEP_PASS_VIAS,
  KEEP_PASS_REVOKE_WINDOW_S, KEEP_REFUSAL_REASONS, KEEP_RESEND_AFTER_S, KEEP_SCOPES, KEEP_SECTION_GAMES,
} from './keep-wire';

export type KeepScope = typeof KEEP_SCOPES[number];

export type InviteStatus = 'waiting' | 'active' | 'revoked' | 'refused';
export type InviteKind = 'personal' | 'guest';

export interface StoredInvite {
  /** 32 hex, made here. */
  grant: string;
  /** 64 hex, made here. */
  secret: string;
  kind: InviteKind;
  /** The contact's persona (personal invite only). */
  persona?: string;
  /** Set on an owner persona's own games invite (K1e): the owner persona it keeps in the game. Not a member's invite. */
  gamesFor?: string;
  /** The contact's name, or a label for a guest pass. */
  label?: string;
  createdAt: number;
  /** Unix seconds. */
  expiration: number;
  status: InviteStatus;
  reason?: RefusalReason;
  /** True once a revoke has been sent and its ack has not come yet. */
  revokeSent?: boolean;
  /** When the invite was last sent (or tried), unix seconds. */
  sentAt?: number;
  /** When the revoke was last sent (or tried), unix seconds. */
  revokeSentAt?: number;
  /** The real time of the newest ack applied (the ack rumor's `created_at`). */
  ackAt?: number;
}

/**
 * A return pass the Keep issued to a player (K1f), as the Keep last reported it. Never holds the pass's secret:
 * the report does not carry one, and the player is not the owner persona.
 */
export interface StoredPass {
  /** 32 hex, made by the Keep when it issued the pass. Revoking is by this. */
  grant: string;
  /** The player persona the pass is bound to. */
  persona: string;
  /** The seat name the Keep saw, if any. */
  name?: string;
  state: PassState;
  /** Unix seconds. */
  expiration: number;
  /** When the player was last seen, unix seconds. */
  seenAt: number;
  via?: PassVia;
  /** The real time (the rumor's `created_at`) of the newest report applied. */
  reportAt: number;
  /** True once a revoke has been sent and neither its ack nor a `revoked` report has come yet. */
  revokeSent?: boolean;
  /** When the revoke was last sent (or tried), unix seconds. */
  revokeSentAt?: number;
}

/**
 * The return-passes switch (K1f) as the owner set it, with the revision the Keep counts it by (separate from the
 * owners `rev`). Absent until the owner changes it: the Keep's default is on, and nothing is sent.
 */
export interface KeepSettings {
  returnPasses: boolean;
  /** The revision of the newest settings message made. */
  setrev: number;
  /** When it was made, unix seconds. An ack dated before it cannot be the answer to it. */
  composedAt: number;
  /** When it was last sent (0 = not yet), unix seconds. */
  sentAt: number;
  /** The Keep has acked this revision. */
  confirmed: boolean;
  /** The Keep's time of the newest `refused stale` applied: a refusal at or before it is a repeat, not an answer. */
  refusedAt?: number;
  /** True once a `refused stale` made us try again with a newer revision. */
  retried?: boolean;
  /** The Keep refused it for good (after the one retry). */
  failed?: 'stale';
}

/** One owner persona linked to a Keep (K1e). */
export interface PersonaLink {
  /** Sections switched on for this persona (`games`). Unknown names are kept. */
  sections: string[];
  /** The revision of the update that most recently added it; absent while that update is not made yet. */
  addedRev?: number;
  /** True once the Keep has said this persona accepted (the claimer always is, the claim being its acceptance). */
  active: boolean;
  /** Set while the persona's accept is outstanding. */
  accept?: {
    /** The update revision the accept answers. */
    rev: number;
    /** When it was last sent (0 = not yet), unix seconds. */
    sentAt: number;
    /** When this accept was made, unix seconds. An ack dated before it cannot be the answer to it. */
    composedAt: number;
    /** The Keep said `pending`: it has the accept but not the update that lists this persona. */
    pending?: boolean;
  };
}

/** An owners update on its way to the Keep (K1e), kept until the Keep acks it. */
export interface PendingUpdate {
  rev: number;
  /** The owner persona that signs it. */
  signer: string;
  personas: Array<{ persona: string; sections: string[] }>;
  /** When it was last sent (0 = not yet), unix seconds. */
  sentAt: number;
  /** When this update was made, unix seconds. An ack dated before it cannot be the answer to it. */
  composedAt: number;
  /**
   * The Keep's time of the newest refusal applied to this update or the ones it replaced. A refusal dated
   * at or before it is a repeat of one already seen (relays return old acks again), not an answer to this update.
   */
  refusedAt?: number;
  /** True once a `refused stale` made us try again with a newer revision. */
  retried?: boolean;
  /** The Keep refused it for good (after the one retry on stale). */
  failed?: 'stale' | 'too_many' | 'malformed';
}

export interface StoredKeep {
  /** The Keep's key, lowercase hex. */
  keep: string;
  name: string;
  relays: string[];
  /** The persona that sent the claim. */
  claimedBy: string;
  /** The owner personas linked to this Keep: the keys of `links`, claimer first. */
  personas: string[];
  /** `all`: every persona of the account is linked, later ones too. `one`: just the claimer until linked by hand. */
  scope: KeepScope;
  /** The newest revision of the owners list the Keep is known to have (0 after a claim). */
  rev: number;
  /** State of each linked persona. */
  links: Record<string, PersonaLink>;
  /** For `all`: personas already linked or unlinked on purpose, so the auto-link does not link them again. */
  seen: string[];
  /** The owners update still unanswered, if any. */
  update?: PendingUpdate;
  /** `pending` until the Keep's `paired` ack arrives. */
  status: 'pending' | 'paired';
  /** The one-time claim code; kept only until paired (a lost first claim can be sent again). */
  code?: string;
  claimedAt: number;
  /**
   * Per owner persona: the `created_at` of the newest valid ack wrap read for this Keep from the
   * wraps addressed to that persona (never later than the moment it was read). The next read of
   * that persona's acks starts 2 days before it, since the Keep backdates its acks by up to
   * 2 days. A persona with none yet reads 3 days back. A K1d record had one cursor for the Keep
   * (`ackCursor`); it is copied to each owner persona when the record is read.
   */
  ackCursors?: Record<string, number>;
  invites: StoredInvite[];
  /** K1f: the return passes the Keep has reported, at most `KEEP_MAX_PASSES`. */
  passes?: StoredPass[];
  /** K1f: the return-passes switch; absent while the owner has not changed it (the Keep's default is on). */
  settings?: KeepSettings;
  /** K1f: when a passes request was last sent, unix seconds. */
  passesRequestedAt?: number;
}

/** The stored Keeps are there but cannot be read; nothing may be saved over them. */
export class KeepsUnreadableError extends Error {
  constructor() { super('The saved Keeps could not be read'); }
}

export const KEEPS_UNREADABLE_TEXT =
  'Your saved Keeps could not be read on this device, so nothing was changed. Your Keeps and invites are still stored. Update My Signet or unlock again, then try once more.';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const STATUSES: readonly string[] = ['waiting', 'active', 'revoked', 'refused'];

function isInvite(v: unknown): v is StoredInvite {
  if (!v || typeof v !== 'object') return false;
  const i = v as Record<string, unknown>;
  return typeof i.grant === 'string' && HEX32.test(i.grant)
    && typeof i.secret === 'string' && HEX64.test(i.secret)
    && (i.kind === 'personal' || i.kind === 'guest')
    && (i.persona === undefined || (typeof i.persona === 'string' && HEX64.test(i.persona)))
    && (i.gamesFor === undefined || (typeof i.gamesFor === 'string' && HEX64.test(i.gamesFor)))
    && (i.label === undefined || typeof i.label === 'string')
    && Number.isSafeInteger(i.createdAt) && Number.isSafeInteger(i.expiration)
    && typeof i.status === 'string' && STATUSES.includes(i.status)
    && (i.reason === undefined || (KEEP_REFUSAL_REASONS as readonly string[]).includes(i.reason as string))
    && (i.revokeSent === undefined || typeof i.revokeSent === 'boolean')
    && (i.sentAt === undefined || Number.isSafeInteger(i.sentAt))
    && (i.revokeSentAt === undefined || Number.isSafeInteger(i.revokeSentAt))
    && (i.ackAt === undefined || Number.isSafeInteger(i.ackAt));
}

function isPass(v: unknown): v is StoredPass {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return typeof p.grant === 'string' && HEX32.test(p.grant)
    && typeof p.persona === 'string' && HEX64.test(p.persona)
    && (p.name === undefined || typeof p.name === 'string')
    && typeof p.state === 'string' && (KEEP_PASS_STATES as readonly string[]).includes(p.state)
    && Number.isSafeInteger(p.expiration) && (p.expiration as number) >= 0
    && Number.isSafeInteger(p.seenAt) && (p.seenAt as number) >= 0 && Number.isSafeInteger(p.reportAt)
    && (p.via === undefined || (KEEP_PASS_VIAS as readonly unknown[]).includes(p.via))
    && (p.revokeSent === undefined || typeof p.revokeSent === 'boolean')
    && (p.revokeSentAt === undefined || Number.isSafeInteger(p.revokeSentAt));
}

function isSettings(v: unknown): v is KeepSettings {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return typeof s.returnPasses === 'boolean' && Number.isSafeInteger(s.setrev) && (s.setrev as number) >= 0
    && Number.isSafeInteger(s.composedAt) && Number.isSafeInteger(s.sentAt) && typeof s.confirmed === 'boolean'
    && (s.refusedAt === undefined || Number.isSafeInteger(s.refusedAt))
    && (s.retried === undefined || typeof s.retried === 'boolean')
    && (s.failed === undefined || s.failed === 'stale');
}

function isSections(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

function isLink(v: unknown): v is PersonaLink {
  if (!v || typeof v !== 'object') return false;
  const l = v as Record<string, unknown>;
  const a = l.accept as Record<string, unknown> | undefined;
  return isSections(l.sections) && typeof l.active === 'boolean'
    && (l.addedRev === undefined || Number.isSafeInteger(l.addedRev))
    && (a === undefined || (!!a && typeof a === 'object' && Number.isSafeInteger(a.rev) && Number.isSafeInteger(a.sentAt)
      && (a.composedAt === undefined || Number.isSafeInteger(a.composedAt))
      && (a.pending === undefined || typeof a.pending === 'boolean')));
}

function isUpdate(v: unknown): v is PendingUpdate {
  if (!v || typeof v !== 'object') return false;
  const u = v as Record<string, unknown>;
  return Number.isSafeInteger(u.rev) && typeof u.signer === 'string' && HEX64.test(u.signer)
    && Array.isArray(u.personas) && u.personas.every(p => !!p && typeof p === 'object'
      && typeof (p as Record<string, unknown>).persona === 'string' && HEX64.test((p as { persona: string }).persona)
      && isSections((p as Record<string, unknown>).sections))
    && Number.isSafeInteger(u.sentAt)
    && (u.composedAt === undefined || Number.isSafeInteger(u.composedAt))
    && (u.refusedAt === undefined || Number.isSafeInteger(u.refusedAt))
    && (u.retried === undefined || typeof u.retried === 'boolean')
    && (u.failed === undefined || u.failed === 'stale' || u.failed === 'too_many' || u.failed === 'malformed');
}

/** A record as stored, K1d or K1e: the K1d fields as before, and the K1e fields when present. */
function isKeep(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const k = v as Record<string, unknown>;
  const links = k.links as Record<string, unknown> | undefined;
  return (k.scope === undefined || (KEEP_SCOPES as readonly unknown[]).includes(k.scope))
    && (k.rev === undefined || (Number.isSafeInteger(k.rev) && (k.rev as number) >= 0))
    && (links === undefined || (!!links && typeof links === 'object' && !Array.isArray(links)
      && Object.entries(links).every(([p, l]) => HEX64.test(p) && isLink(l))))
    && (k.seen === undefined || (Array.isArray(k.seen) && k.seen.every(p => typeof p === 'string' && HEX64.test(p))))
    && (k.update === undefined || isUpdate(k.update))
    && (k.passes === undefined || (Array.isArray(k.passes) && k.passes.every(isPass)))
    && (k.settings === undefined || isSettings(k.settings))
    && (k.passesRequestedAt === undefined || Number.isSafeInteger(k.passesRequestedAt))
    && (k.ackCursors === undefined || (!!k.ackCursors && typeof k.ackCursors === 'object' && !Array.isArray(k.ackCursors)
      && Object.entries(k.ackCursors).every(([p, at]) => HEX64.test(p) && Number.isSafeInteger(at))))
    && isK1dKeep(v);
}

function isK1dKeep(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const k = v as Record<string, unknown>;
  return typeof k.keep === 'string' && HEX64.test(k.keep)
    && typeof k.name === 'string'
    && Array.isArray(k.relays) && k.relays.every(r => typeof r === 'string')
    && typeof k.claimedBy === 'string' && HEX64.test(k.claimedBy)
    && Array.isArray(k.personas) && k.personas.every(p => typeof p === 'string' && HEX64.test(p))
    && (k.status === 'pending' || k.status === 'paired')
    && (k.code === undefined || (typeof k.code === 'string' && HEX32.test(k.code)))
    && Number.isSafeInteger(k.claimedAt)
    && (k.ackCursor === undefined || Number.isSafeInteger(k.ackCursor))
    && Array.isArray(k.invites) && k.invites.every(isInvite);
}

/**
 * A stored record with the K1e fields filled in. A K1d record has none: it is a Keep for
 * one persona (`one`), at revision 0, with the claimer as its only owner persona, active
 * (the claim being its acceptance). Nothing else changes, so it is saved in this shape the
 * next time the list is written.
 */
function migrateKeep(raw: Record<string, unknown>): StoredKeep {
  const { ackCursor: legacyCursor, ...fields } = raw;
  const k = fields as unknown as StoredKeep;
  const claimer: PersonaLink = { sections: [KEEP_SECTION_GAMES], addedRev: 0, active: true };
  const stored = raw.links ? (raw.links as Record<string, PersonaLink>) : { [k.claimedBy]: claimer };
  // Records made before the time of an update and of an accept was kept read as made at the claim.
  const links: Record<string, PersonaLink> = Object.fromEntries(Object.entries(stored).map(([p, l]) => [
    p, l.accept && l.accept.composedAt === undefined ? { ...l, accept: { ...l.accept, composedAt: k.claimedAt } } : l,
  ]));
  const update = k.update && k.update.composedAt === undefined ? { ...k.update, composedAt: k.claimedAt } : k.update;
  // One cursor for the Keep (K1d, early K1e) becomes the same cursor for each persona whose acks are read.
  const personas = Object.keys(links);
  const ackCursors = k.ackCursors ?? (Number.isSafeInteger(legacyCursor)
    ? Object.fromEntries([...new Set([k.claimedBy, ...personas, ...(update ? [update.signer] : [])])].map(p => [p, legacyCursor as number]))
    : undefined);
  return {
    ...k,
    ...(update ? { update } : {}),
    ...(ackCursors ? { ackCursors } : {}),
    scope: (KEEP_SCOPES as readonly unknown[]).includes(raw.scope) ? raw.scope as KeepScope : 'one',
    rev: Number.isSafeInteger(raw.rev) ? raw.rev as number : 0,
    links,
    personas: Object.keys(links),
    seen: Array.isArray(raw.seen) ? raw.seen as string[] : [k.claimedBy],
  };
}

/**
 * K1f: the return-pass data of a stored Keep is a mirror of what the Keep reports (a pass, the switch's last
 * message, when passes were last asked for), so a bad piece of it is dropped and the rest of the Keep is read
 * as usual: one bad pass must not make every Keep unreadable. A pass is dropped when it is not well formed or
 * repeats a grant; a settings record or request time that is not well formed is left out (the switch then
 * reads as never changed and the next passes request refills the passes). The record is copied only when
 * something was dropped. Invites, grants and secrets are never dropped: a bad one still makes the list unreadable.
 */
function scrubReturnPasses(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const k = v as Record<string, unknown>;
  const { passes, settings, passesRequestedAt, ...rest } = k;
  let changed = false;
  let nextPasses: unknown[] | undefined;
  if (passes !== undefined) {
    if (Array.isArray(passes)) {
      const grants = new Set<string>();
      nextPasses = passes.filter(p => {
        if (!isPass(p) || grants.has(p.grant)) return false;
        grants.add(p.grant);
        return true;
      });
      if (nextPasses.length !== passes.length) changed = true;
    } else changed = true;
  }
  const keepSettings = settings === undefined || isSettings(settings);
  const keepRequestedAt = passesRequestedAt === undefined || Number.isSafeInteger(passesRequestedAt);
  if (!keepSettings || !keepRequestedAt) changed = true;
  if (!changed) return v;
  return {
    ...rest,
    ...(nextPasses ? { passes: nextPasses } : {}),
    ...(settings !== undefined && keepSettings ? { settings } : {}),
    ...(passesRequestedAt !== undefined && keepRequestedAt ? { passesRequestedAt } : {}),
  };
}

/** The stored list (K1d records migrated in memory), or null when it is not a well-formed list. */
export function parseStoredKeeps(raw: unknown): StoredKeep[] | null {
  if (!Array.isArray(raw)) return null;
  const scrubbed = raw.map(scrubReturnPasses);
  const seen = new Set<string>();
  for (const k of scrubbed) {
    if (!isKeep(k) || seen.has((k as { keep: string }).keep)) return null;
    seen.add((k as { keep: string }).keep);
  }
  return (scrubbed as Array<Record<string, unknown>>).map(migrateKeep);
}

export function newPendingKeep(a: {
  keep: string; name: string; relays: string[]; claimedBy: string; code: string; now: number; scope?: KeepScope;
}): StoredKeep {
  return {
    keep: a.keep, name: a.name, relays: [...a.relays], claimedBy: a.claimedBy,
    personas: [a.claimedBy], scope: a.scope ?? 'one', rev: 0,
    links: { [a.claimedBy]: { sections: [KEEP_SECTION_GAMES], addedRev: 0, active: true } },
    seen: [a.claimedBy],
    status: 'pending', code: a.code, claimedAt: a.now, invites: [],
  };
}

/**
 * A stored Keep that took a new pairing link (it restarted, was reset, or was added again while still
 * paired): back to `pending` with the new code, relays and name. Its invites stay; the acks decide what
 * the Keep still knows of them.
 *
 * The Keep may or may not have forgotten its owners list, and this cannot tell. So the list, the
 * revision and the personas already met are kept; the claimer alone is active (its claim is its
 * acceptance) and every other linked persona must accept again. The caller then makes an update at a
 * higher revision (see `composeUpdate`), which a reset Keep takes from revision 0 and a Keep that was
 * not reset takes over its own list, accepts being repeat-safe at the Keep. Nothing the owner chose is
 * lost either way, and nothing is linked that the owner had not linked.
 */
export function repairKeep(
  keep: StoredKeep, a: { name: string; relays: string[]; code: string; now: number; scope?: KeepScope },
): StoredKeep {
  const { ackCursors: _cursors, update, passesRequestedAt: _requested, settings, ...rest } = keep; // a new pairing reads acks afresh
  const claimer = keep.claimedBy;
  const mine = keep.links[claimer];
  const links: Record<string, PersonaLink> = {
    [claimer]: { sections: mine?.sections ?? [KEEP_SECTION_GAMES], addedRev: mine?.addedRev ?? 0, active: true },
  };
  for (const [persona, link] of Object.entries(keep.links)) {
    if (persona === claimer) continue;
    const { accept: _accept, ...held } = link;
    links[persona] = { ...held, active: false };
  }
  // The owner personas' own games invites may be gone from the box too: send them again (a repeat is harmless).
  return {
    ...rest, name: a.name, relays: [...a.relays], code: a.code, status: 'pending', claimedAt: a.now,
    scope: a.scope ?? keep.scope,
    // A reset Keep has forgotten the switch (default on): send the owner's choice again, as a new message. A Keep
    // that was not reset answers `refused stale`, which makes the next revision (see `applySettingsAck`).
    ...(settings ? { settings: restartedSettings(settings, a.now) } : {}),
    // An update that was never answered may have been taken: number the next one above it.
    rev: Math.max(keep.rev, update?.rev ?? 0),
    personas: Object.keys(links), links,
    seen: keep.seen.includes(claimer) ? keep.seen : [...keep.seen, claimer],
    invites: keep.invites.map(i => (i.gamesFor && i.status !== 'revoked' && i.status !== 'refused' && !i.revokeSent
      ? { ...i, status: 'waiting' as const, sentAt: 0 } : i)),
  };
}

/** Where a read of the acks addressed to `persona` for these Keeps starts: before the oldest of its cursors. */
export function ackReadSince(keeps: readonly StoredKeep[], persona: string, now: number): number {
  return Math.min(...keeps.map(k => {
    const cursor = k.ackCursors?.[persona];
    return cursor === undefined ? now - KEEP_ACK_FIRST_LOOKBACK_S : cursor - KEEP_ACK_BACKDATE_S;
  }));
}

/**
 * Move the ack cursor of each (Keep, persona) forward to the newest wrap time read for it
 * (capped at `now`, so a wrap dated in the future cannot push it past what
 * exists). Returns the same list when nothing moved.
 */
export function advanceAckCursors(
  list: readonly StoredKeep[], read: ReadonlyArray<{ keep: string; persona: string; wrapAt: number }>, now: number,
): StoredKeep[] {
  const newest = new Map<string, Map<string, number>>();
  for (const { keep, persona, wrapAt } of read) {
    const byPersona = newest.get(keep) ?? new Map<string, number>();
    byPersona.set(persona, Math.max(byPersona.get(persona) ?? -Infinity, Math.min(wrapAt, now)));
    newest.set(keep, byPersona);
  }
  let changed = false;
  const next = list.map(k => {
    const found = newest.get(k.keep);
    if (!found) return k;
    let cursors = k.ackCursors;
    for (const [persona, at] of found) {
      if (cursors?.[persona] !== undefined && cursors[persona] >= at) continue;
      cursors = { ...cursors, [persona]: at };
    }
    if (cursors === k.ackCursors) return k;
    changed = true;
    return { ...k, ackCursors: cursors };
  });
  return changed ? next : list as StoredKeep[];
}

export function findKeep(list: readonly StoredKeep[], keep: string): StoredKeep | undefined {
  return list.find(k => k.keep === keep);
}

/** Replace one Keep by id (the list is otherwise untouched). */
export function withKeep(list: readonly StoredKeep[], next: StoredKeep): StoredKeep[] {
  return list.some(k => k.keep === next.keep) ? list.map(k => (k.keep === next.keep ? next : k)) : [...list, next];
}

export function withInvite(keep: StoredKeep, invite: StoredInvite): StoredKeep {
  return { ...keep, invites: [...keep.invites.filter(i => i.grant !== invite.grant), invite] };
}

/** The revoke is going out (or going out again): note it, and when, until the Keep acks `revoked`. */
export function markRevokeSent(keep: StoredKeep, grant: string, now?: number): StoredKeep {
  return {
    ...keep,
    invites: keep.invites.map(i => (i.grant === grant && i.status !== 'revoked'
      ? { ...i, revokeSent: true, ...(now !== undefined ? { revokeSentAt: now } : {}) } : i)),
  };
}

/** Note when an invite was last sent. */
export function markInviteSent(keep: StoredKeep, grant: string, now: number): StoredKeep {
  return { ...keep, invites: keep.invites.map(i => (i.grant === grant ? { ...i, sentAt: now } : i)) };
}

/**
 * What to send again for a paired Keep: an invite still waiting for the Keep,
 * and a revoke the Keep has not acked `revoked`, once the last send is more
 * than `KEEP_RESEND_AFTER_S` old. An expired invite is left alone (the Keep
 * would only refuse it), and so is one the Keep has refused or revoked. The
 * Keep treats a repeat of either message as idempotent.
 */
export function resendDue(keep: StoredKeep, now: number): Array<{ invite: StoredInvite; revoke: boolean }> {
  if (keep.status !== 'paired') return [];
  const due: Array<{ invite: StoredInvite; revoke: boolean }> = [];
  for (const invite of keep.invites) {
    if (isExpired(invite, now) || invite.status === 'revoked' || invite.status === 'refused') continue;
    if (invite.revokeSent) {
      if (now - (invite.revokeSentAt ?? invite.sentAt ?? invite.createdAt) > KEEP_RESEND_AFTER_S) due.push({ invite, revoke: true });
    } else if (invite.status === 'waiting' && now - (invite.sentAt ?? invite.createdAt) > KEEP_RESEND_AFTER_S) {
      due.push({ invite, revoke: false });
    }
  }
  return due;
}

/** How far before our claim a claim ack may be dated and still count (clock difference with the Keep). */
export const CLAIM_ACK_SKEW_S = 600;

/**
 * Apply one ack from the Keep. A revoke is final (a late `active` never undoes
 * it); otherwise the newest ack by its real time wins. Returns the same object
 * when nothing changed.
 */
export function applyAck(list: readonly StoredKeep[], ack: KeepAck): StoredKeep[] {
  const keep = findKeep(list, ack.keep);
  if (!keep) return list as StoredKeep[];
  if (ack.claim) {
    if (keep.status === 'paired') return list as StoredKeep[];
    // A claim ack carries no code, so an ack from an earlier pairing (before a reset) must not
    // pair a claim made after it: only acks dated near or after this claim count.
    if (ack.at < keep.claimedAt - CLAIM_ACK_SKEW_S) return list as StoredKeep[];
    const { code: _code, ...rest } = keep;
    return withKeep(list, { ...rest, status: 'paired' });
  }
  const invite = keep.invites.find(i => i.grant === ack.grant);
  if (!invite) {
    // K1f: the revoke of a return pass is acked `revoked` by the pass's grant. Nothing else about a pass is acked.
    const pass = keep.passes?.find(p => p.grant === ack.grant);
    if (!pass || ack.status !== 'revoked' || pass.state === 'revoked') return list as StoredKeep[];
    return withKeep(list, { ...keep, passes: keep.passes!.map(p => (p === pass ? { ...p, state: 'revoked' as const, revokeSent: false } : p)) });
  }
  if (invite.status === 'revoked') return list as StoredKeep[];
  if (invite.ackAt !== undefined && ack.at < invite.ackAt) return list as StoredKeep[];
  const { reason: _reason, ...base } = invite;
  const next: StoredInvite = {
    ...base, ackAt: ack.at,
    status: ack.status === 'paired' ? invite.status : ack.status as InviteStatus,
    ...(ack.status === 'refused' && ack.reason ? { reason: ack.reason } : {}),
    // A refusal or an active ack ends any pending revoke only if the Keep says so by acking revoked.
    ...(ack.status === 'revoked' ? { revokeSent: false } : {}),
  };
  return withKeep(list, { ...keep, invites: keep.invites.map(i => (i.grant === ack.grant ? next : i)) });
}

const REASONS: Record<RefusalReason, string> = {
  expired: 'it had already expired',
  expiry_too_long: 'it lasted too long',
  revoked: 'it was revoked before',
  full: 'the Keep is full',
  conflict: 'it clashed with an earlier invite',
  malformed: 'the Keep could not read it',
  stale: 'the Keep already has a newer list',
  too_many: 'there were too many personas',
};

export function refusalText(reason: RefusalReason | undefined): string {
  return reason ? REASONS[reason] : 'the Keep said no';
}

/** The words shown for an invite's state. */
export function inviteStatusLabel(invite: StoredInvite): string {
  if (invite.status === 'revoked') return 'Revoked';
  if (invite.status === 'refused') return `Refused (${refusalText(invite.reason)})`;
  if (invite.revokeSent) return 'Revoking, waiting for the Keep';
  return invite.status === 'active' ? 'Active' : 'Waiting for the Keep';
}

export function isExpired(invite: StoredInvite, nowSeconds: number): boolean {
  return invite.expiration <= nowSeconds;
}

// ---- return passes (K1f) ---------------------------------------------------

const passIsDead = (p: StoredPass, now: number) => p.state === 'expired' || (p.state === 'active' && p.expiration <= now);

/** True when a pass counts as active now: reported active and not past its expiration. */
export function isPassActive(pass: StoredPass, now: number): boolean {
  return pass.state === 'active' && pass.expiration > now;
}

/**
 * A pass whose revoke was sent and never acked, and which expired `KEEP_PASS_REVOKE_WINDOW_S` ago or more: the
 * Keep has forgotten its grant by now, so the revoke is not sent again and the pass counts as revoked.
 */
export function passRevokeGivenUp(pass: StoredPass, now: number): boolean {
  return !!pass.revokeSent && pass.state !== 'revoked' && now - pass.expiration >= KEEP_PASS_REVOKE_WINDOW_S;
}

/** The passes to list as returning players: active ones, and ones being revoked until the Keep says so. Newest seen first. */
export function returningPlayers(keep: StoredKeep, now: number): StoredPass[] {
  return (keep.passes ?? [])
    .filter(p => p.state !== 'revoked' && !passRevokeGivenUp(p, now) && (isPassActive(p, now) || p.revokeSent))
    .sort((a, b) => b.seenAt - a.seenAt);
}

/** The words shown for a pass's state. */
export function passStatusLabel(pass: StoredPass, now: number): string {
  if (pass.state === 'revoked' || passRevokeGivenUp(pass, now)) return 'Revoked';
  if (pass.revokeSent) return 'Revoking, waiting for the Keep';
  return isPassActive(pass, now) ? 'Active' : 'Expired';
}

function samePass(a: StoredPass, b: StoredPass): boolean {
  return a.grant === b.grant && a.persona === b.persona && a.name === b.name && a.state === b.state && a.expiration === b.expiration
    && a.seenAt === b.seenAt && a.via === b.via && a.reportAt === b.reportAt && a.revokeSent === b.revokeSent && a.revokeSentAt === b.revokeSentAt;
}

/**
 * Apply one pass report from the Keep. A pass is one entry per `(keep, grant)`: the report with the newest real
 * time wins, and `revoked` is final (a late `active` never undoes it, and a `revoked` report counts even when an
 * older-dated `active` was applied first). A report naming another persona for a grant already held is not
 * believed. At most `KEEP_MAX_PASSES` are kept: when full, expired ones go first, then the oldest-reported revoked
 * ones; if still full the new pass is not stored (the Keep lists at most as many, so this only follows a broken
 * Keep). Returns the same list when nothing changed.
 */
export function applyPassReport(list: readonly StoredKeep[], report: KeepPassReport, now: number): StoredKeep[] {
  const keep = findKeep(list, report.keep);
  if (!keep) return list as StoredKeep[];
  // Never store a number the saved list could not read back (the parser already refuses these).
  if (![report.expiration, report.seen, report.at].every(Number.isSafeInteger) || report.expiration < 0 || report.seen < 0) return list as StoredKeep[];
  // A Keep whose clock runs ahead must not pin a pass: its report time counts as at most `now` plus the usual skew.
  const at = Math.min(report.at, now + CLAIM_ACK_SKEW_S);
  const passes = keep.passes ?? [];
  const found = passes.find(p => p.grant === report.grant);
  if (found && (found.persona !== report.persona || found.state === 'revoked')) return list as StoredKeep[];
  if (found && at < found.reportAt) {
    if (report.state !== 'revoked') return list as StoredKeep[];
    // A `revoked` report dated before the one applied still ends the pass; what it says of the player is older, so it is not taken.
    const { revokeSent: _sent, ...rest } = found;
    return withKeep(list, { ...keep, passes: passes.map(p => (p === found ? { ...rest, state: 'revoked' as const } : p)) });
  }
  const next: StoredPass = {
    grant: report.grant, persona: report.persona,
    ...(report.name ? { name: report.name } : found?.name ? { name: found.name } : {}),
    state: report.state, expiration: report.expiration, seenAt: report.seen,
    ...(report.via ? { via: report.via } : found?.via ? { via: found.via } : {}),
    reportAt: at,
    ...(found?.revokeSent && report.state !== 'revoked' ? { revokeSent: true, ...(found.revokeSentAt !== undefined ? { revokeSentAt: found.revokeSentAt } : {}) } : {}),
  };
  if (found && samePass(found, next)) return list as StoredKeep[];
  let kept = passes;
  if (found) {
    kept = passes.map(p => (p === found ? next : p));
  } else {
    if (kept.length >= KEEP_MAX_PASSES) {
      const evict = (pick: (p: StoredPass) => boolean) => {
        const victim = kept.filter(pick).sort((a, b) => a.reportAt - b.reportAt)[0];
        if (victim) kept = kept.filter(p => p !== victim);
      };
      evict(p => passIsDead(p, now));
      if (kept.length >= KEEP_MAX_PASSES) evict(p => p.state === 'revoked');
      if (kept.length >= KEEP_MAX_PASSES) return list as StoredKeep[];
    }
    kept = [...kept, next];
  }
  return withKeep(list, { ...keep, passes: kept });
}

/** The revoke of a pass is going out (or going out again): note it, and when, until the Keep acks `revoked`. */
export function markPassRevokeSent(keep: StoredKeep, grant: string, now: number): StoredKeep {
  return {
    ...keep,
    passes: (keep.passes ?? []).map(p => (p.grant === grant && p.state !== 'revoked' ? { ...p, revokeSent: true, revokeSentAt: now } : p)),
  };
}

/**
 * The pass revokes to send again for a paired Keep: sent, not yet acked `revoked` (nor reported so), and the last
 * send older than `KEEP_RESEND_AFTER_S`. An expired pass is still revoked: the Keep keeps the grant for 30 days past
 * the pass's expiry and a revoke naming it blocks the persona, which is the point of it. Once the pass expired more
 * than `KEEP_PASS_REVOKE_WINDOW_S` ago the revoke is not sent again (the Keep no longer knows the grant).
 */
export function passRevokesDue(keep: StoredKeep, now: number): StoredPass[] {
  if (keep.status !== 'paired') return [];
  return (keep.passes ?? []).filter(p => p.revokeSent && p.state !== 'revoked' && !passRevokeGivenUp(p, now) && now - (p.revokeSentAt ?? 0) > KEEP_RESEND_AFTER_S);
}

/** The newest time a pass report was applied for this Keep (0 when none). */
export function lastReportAt(keep: StoredKeep): number {
  return (keep.passes ?? []).reduce((m, p) => Math.max(m, p.reportAt), 0);
}

/**
 * Whether to ask the Keep for its passes (27668). `opening`: the Keep's page was just opened. Opening asks again
 * once the last request is over `KEEP_RESEND_AFTER_S` old. Otherwise (a catch-up while the app is open) only a
 * Keep that has reported before is asked, and only when both its last report and the last request are over 7
 * days old: a Keep nobody has opened yet, or one with no passes, is not asked on every start.
 */
export function passesRequestDue(keep: StoredKeep, now: number, opening: boolean): boolean {
  if (keep.status !== 'paired') return false;
  const requested = keep.passesRequestedAt ?? 0;
  if (opening) return now - requested > KEEP_RESEND_AFTER_S;
  const last = lastReportAt(keep);
  return last > 0 && now - Math.max(last, requested) > KEEP_PASSES_REQUEST_AFTER_S;
}

export function markPassesRequested(keep: StoredKeep, now: number): StoredKeep {
  return { ...keep, passesRequestedAt: now };
}

// ---- the return-passes switch (K1f) ----------------------------------------

/** The switch as the owner sees it: the Keep's default (on) until it is changed. */
export function returnPassesOn(keep: StoredKeep): boolean {
  return keep.settings?.returnPasses ?? true;
}

/** True when the next settings revision is one the saved Keeps can hold. */
export function canComposeSettings(keep: StoredKeep): boolean {
  return (keep.settings?.setrev ?? 0) < Number.MAX_SAFE_INTEGER - 1;
}

/** The switch set to `on`, as the next revision, not yet sent. */
export function composeSettings(keep: StoredKeep, on: boolean, now: number): StoredKeep {
  if (!canComposeSettings(keep)) throw new RangeError('The Keep has no higher settings revision left');
  return {
    ...keep,
    settings: { returnPasses: on, setrev: (keep.settings?.setrev ?? 0) + 1, composedAt: now, sentAt: 0, confirmed: false },
  };
}

/** The settings of a Keep that took a new pairing link: sent again as a new message, as the Keep may have forgotten them. */
export function restartedSettings(settings: KeepSettings, now: number): KeepSettings {
  return { returnPasses: settings.returnPasses, setrev: settings.setrev, composedAt: now, sentAt: 0, confirmed: false };
}

export function markSettingsSent(keep: StoredKeep, now: number): StoredKeep {
  return keep.settings ? { ...keep, settings: { ...keep.settings, sentAt: now } } : keep;
}

/** The settings message to send (again): not acked yet, not given up, and the last send over `KEEP_RESEND_AFTER_S` old. */
export function settingsDue(keep: StoredKeep, now: number): boolean {
  const s = keep.settings;
  return keep.status === 'paired' && !!s && !s.confirmed && !s.failed && now - s.sentAt > KEEP_RESEND_AFTER_S;
}

/**
 * Apply an ack of a settings message (`ack.settings`). Relays return old acks again, so an ack counts only if it is
 * dated after the claim and after the message it answers was made.
 * - `updated` at our `setrev`: the Keep has the setting.
 * - `refused stale`: the Keep is at a revision at or above ours (a resend of a message it already took gets this
 *   too, at our own revision). Take its revision and make the message again one higher, once; the second time it
 *   is given up. Repeats of a refusal already seen are ignored.
 * Returns the same list when nothing changed.
 */
export function applySettingsAck(list: readonly StoredKeep[], ack: KeepAck, now: number): StoredKeep[] {
  const keep = findKeep(list, ack.keep);
  const s = keep?.settings;
  if (!keep || !s || !ack.settings || ack.setrev === undefined) return list as StoredKeep[];
  if (ack.at < keep.claimedAt - CLAIM_ACK_SKEW_S || ack.at < s.composedAt - CLAIM_ACK_SKEW_S) return list as StoredKeep[];
  if (ack.status === 'updated') {
    if (ack.setrev !== s.setrev || s.confirmed || s.failed) return list as StoredKeep[];
    return withKeep(list, { ...keep, settings: { ...s, confirmed: true } });
  }
  if (ack.status !== 'refused' || ack.reason !== 'stale' || s.confirmed || s.failed) return list as StoredKeep[];
  if (ack.setrev < s.setrev) return list as StoredKeep[]; // refused an older send of ours; the newer one stands
  if (s.refusedAt !== undefined && ack.at <= s.refusedAt) return list as StoredKeep[];
  const seen: KeepSettings = { ...s, refusedAt: ack.at };
  if (s.retried || ack.setrev >= Number.MAX_SAFE_INTEGER - 1) return withKeep(list, { ...keep, settings: { ...seen, failed: 'stale' } });
  return withKeep(list, {
    ...keep,
    settings: { returnPasses: s.returnPasses, setrev: ack.setrev + 1, composedAt: now, sentAt: 0, confirmed: false, refusedAt: ack.at, retried: true },
  });
}

/**
 * What to say under the switch: nothing when the Keep has it (or nothing was ever sent), "Waiting for the Keep"
 * until the ack, and "This Keep can't do this yet" once the resend window has passed with no ack (a Keep that
 * does not know the message never answers it).
 */
export function returnPassesLabel(keep: StoredKeep, now: number): string | undefined {
  const s = keep.settings;
  if (!s || s.confirmed) return undefined;
  if (s.failed) return 'The Keep has a newer setting. Switch it again.';
  return now - s.composedAt > KEEP_RESEND_AFTER_S ? 'This Keep can’t do this yet' : 'Waiting for the Keep';
}
