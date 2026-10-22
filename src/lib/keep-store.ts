/**
 * The Keeps this account has claimed (K1d, K1e), one account-level list.
 *
 * A Keep is not tied to a persona's view: every record names the persona that
 * sent the claim (`claimedBy`) and the owner personas linked to it (`personas`,
 * with the state of each in `links`). Invites and revokes for a Keep are signed
 * by an owner persona the Keep counts as active (see `keep-owners.ts`).
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
import type { KeepAck, RefusalReason } from './keep-messages';
import {
  KEEP_ACK_BACKDATE_S, KEEP_ACK_FIRST_LOOKBACK_S, KEEP_REFUSAL_REASONS, KEEP_RESEND_AFTER_S, KEEP_SCOPES, KEEP_SECTION_GAMES,
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

/** The stored list (K1d records migrated in memory), or null when it is not a well-formed list. */
export function parseStoredKeeps(raw: unknown): StoredKeep[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  for (const k of raw) {
    if (!isKeep(k) || seen.has((k as { keep: string }).keep)) return null;
    seen.add((k as { keep: string }).keep);
  }
  return (raw as Array<Record<string, unknown>>).map(migrateKeep);
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
 * A stored Keep that took a new pairing link (it restarted or was reset): back
 * to `pending` with the new code, relays and name. Its invites stay; the acks
 * decide what the Keep still knows of them.
 */
export function repairKeep(
  keep: StoredKeep, a: { name: string; relays: string[]; code: string; now: number; scope?: KeepScope },
): StoredKeep {
  const { ackCursors: _cursors, update: _update, ...rest } = keep; // a new pairing reads acks afresh
  // A reset Keep has forgotten its owners list: back to the claimer alone at revision 0, to be linked again.
  // The owner personas' own games invites may be gone from the box too: send them again (a repeat is harmless).
  return {
    ...rest, name: a.name, relays: [...a.relays], code: a.code, status: 'pending', claimedAt: a.now,
    scope: a.scope ?? keep.scope, rev: 0,
    personas: [keep.claimedBy],
    links: { [keep.claimedBy]: { sections: keep.links[keep.claimedBy]?.sections ?? [KEEP_SECTION_GAMES], addedRev: 0, active: true } },
    seen: [keep.claimedBy],
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
  if (!invite || invite.status === 'revoked') return list as StoredKeep[];
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
