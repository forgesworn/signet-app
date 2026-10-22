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
import { KEEP_REFUSAL_REASONS } from './keep-wire';

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
  invites: StoredInvite[];
}

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
