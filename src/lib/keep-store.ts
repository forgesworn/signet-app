/**
 * The Keeps this account has claimed (K1d), one account-level list.
 *
 * A Keep is not tied to a persona's view: every record names the persona that
 * sent the claim (`claimedBy`) and the personas allowed to use it (`personas`,
 * for now always `[claimedBy]`). Invites and revokes for a Keep are signed by
 * `claimedBy`.
 *
 * Stored as ONE encrypted `identity`-store row (see `db.ts`), so there is no
 * IndexedDB version change. The invite secrets in it are what lets someone
 * join the Keep, hence the encryption. This file holds the shape, validation
 * and the pure state changes; `keep-service.ts` does the sending.
 */
import type { KeepAck, RefusalReason } from './keep-messages';
import { KEEP_ACK_BACKDATE_S, KEEP_ACK_FIRST_LOOKBACK_S, KEEP_REFUSAL_REASONS } from './keep-wire';

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
  /** The contact's name, or a label for a guest pass. */
  label?: string;
  createdAt: number;
  /** Unix seconds. */
  expiration: number;
  status: InviteStatus;
  reason?: RefusalReason;
  /** True once a revoke has been sent and its ack has not come yet. */
  revokeSent?: boolean;
  /** The real time of the newest ack applied (the ack rumor's `created_at`). */
  ackAt?: number;
}

export interface StoredKeep {
  /** The Keep's key, lowercase hex. */
  keep: string;
  name: string;
  relays: string[];
  /** The persona that sent the claim. */
  claimedBy: string;
  /** Personas allowed to use this Keep. Today always `[claimedBy]`. */
  personas: string[];
  /** `pending` until the Keep's `paired` ack arrives. */
  status: 'pending' | 'paired';
  /** The one-time claim code; kept only until paired (a lost first claim can be sent again). */
  code?: string;
  claimedAt: number;
  /**
   * The `created_at` of the newest valid ack wrap read for this Keep (never later than the
   * moment it was read). The next read starts 2 days before it, since the Keep backdates its
   * acks by up to 2 days. Absent until the first ack: that read goes 3 days back.
   */
  ackCursor?: number;
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
    && (i.label === undefined || typeof i.label === 'string')
    && Number.isSafeInteger(i.createdAt) && Number.isSafeInteger(i.expiration)
    && typeof i.status === 'string' && STATUSES.includes(i.status)
    && (i.reason === undefined || (KEEP_REFUSAL_REASONS as readonly string[]).includes(i.reason as string))
    && (i.revokeSent === undefined || typeof i.revokeSent === 'boolean')
    && (i.ackAt === undefined || Number.isSafeInteger(i.ackAt));
}

function isKeep(v: unknown): v is StoredKeep {
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

/** The stored list, or null when it is not a well-formed list. */
export function parseStoredKeeps(raw: unknown): StoredKeep[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  for (const k of raw) {
    if (!isKeep(k) || seen.has(k.keep)) return null;
    seen.add(k.keep);
  }
  return raw as StoredKeep[];
}

export function newPendingKeep(a: {
  keep: string; name: string; relays: string[]; claimedBy: string; code: string; now: number;
}): StoredKeep {
  return {
    keep: a.keep, name: a.name, relays: [...a.relays], claimedBy: a.claimedBy,
    personas: [a.claimedBy], status: 'pending', code: a.code, claimedAt: a.now, invites: [],
  };
}

/**
 * A stored Keep that took a new pairing link (it restarted or was reset): back
 * to `pending` with the new code, relays and name. Its invites stay; the acks
 * decide what the Keep still knows of them.
 */
export function repairKeep(keep: StoredKeep, a: { name: string; relays: string[]; code: string; now: number }): StoredKeep {
  const { ackCursor: _cursor, ...rest } = keep; // a new pairing reads acks afresh
  return { ...rest, name: a.name, relays: [...a.relays], code: a.code, status: 'pending', claimedAt: a.now };
}

/** Where a read of the acks for these Keeps (one owner persona) starts: before the oldest cursor. */
export function ackReadSince(keeps: readonly StoredKeep[], now: number): number {
  return Math.min(...keeps.map(k => (k.ackCursor === undefined ? now - KEEP_ACK_FIRST_LOOKBACK_S : k.ackCursor - KEEP_ACK_BACKDATE_S)));
}

/**
 * Move the ack cursor of each Keep forward to the newest wrap time read for it
 * (capped at `now`, so a wrap dated in the future cannot push it past what
 * exists). Returns the same list when nothing moved.
 */
export function advanceAckCursors(
  list: readonly StoredKeep[], read: ReadonlyArray<{ keep: string; wrapAt: number }>, now: number,
): StoredKeep[] {
  const newest = new Map<string, number>();
  for (const { keep, wrapAt } of read) newest.set(keep, Math.max(newest.get(keep) ?? -Infinity, Math.min(wrapAt, now)));
  let changed = false;
  const next = list.map(k => {
    const at = newest.get(k.keep);
    if (at === undefined || (k.ackCursor !== undefined && k.ackCursor >= at)) return k;
    changed = true;
    return { ...k, ackCursor: at };
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

export function markRevokeSent(keep: StoredKeep, grant: string): StoredKeep {
  return { ...keep, invites: keep.invites.map(i => (i.grant === grant && i.status !== 'revoked' ? { ...i, revokeSent: true } : i)) };
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
