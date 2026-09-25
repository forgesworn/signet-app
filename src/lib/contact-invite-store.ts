import { validContactOrigin, normaliseContactOrigin, type ContactOrigin } from './contact-origins';
import { contactExchangeKey } from './contact-exchange-key';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { parseContactInvite, parseContactExchangeMessage, contactMessageHash, contactCommitment,
  contactVerificationWords, CONTACT_INVITE_PENDING_LIMIT } from '@forgesworn/signet-contacts';
import type { ContactInvite, ContactExchangeState, ContactRequest } from '@forgesworn/signet-contacts';
import type { SealedContactPacket } from '@forgesworn/signet-contacts/adapters/invite-nostr-tools';
import type { NostrEvent } from 'signet-protocol';
import { verifyEvent } from 'signet-protocol';
import { getDb } from './db';
import { decryptSecret } from './crypto-store';
import { privateVaultQueue } from './private-vault-queue';
import { updateEncryptedPrivateState } from './private-vault-store';

export interface ContactInviteAppOrigin {
  grantId: string; requestId: string; requestHash: string; appName: string;
  autoAcceptUntil?: number;
}
export function validContactInviteAppOrigin(raw: unknown): raw is ContactInviteAppOrigin {
  if (!raw || typeof raw !== 'object') return false;
  const v = raw as ContactInviteAppOrigin;
  return /^[0-9a-f]{32}$/.test(v.grantId) && /^[0-9a-f]{32}$/.test(v.requestId)
    && /^[0-9a-f]{64}$/.test(v.requestHash) && typeof v.appName === 'string' && v.appName.length > 0 && v.appName.length <= 100
    && (v.autoAcceptUntil === undefined || (Number.isSafeInteger(v.autoAcceptUntil) && v.autoAcceptUntil >= 0));
}
export interface StoredContactInvite {
  id: string; identityPubkey: string; name: string; invite: ContactInvite;
  mode: 'standing' | 'single-use'; enabled: boolean; createdAt: number; updatedAt: number;
  intendedPubkey?: string; app?: ContactInviteAppOrigin;
}
export interface ContactArrival {
  id: string; inviteId: string; identityPubkey: string; packet?: SealedContactPacket; packetHash?: string;
  receivedAt: number; channel?: 'invite' | 'exchange'; request?: ContactRequest; dismissedAt?: number;
}
export interface ContactInviteOutbox {
  id: string; identityPubkey: string; relays: string[]; event: NostrEvent; acknowledgedAt?: number;
  exchangeId?: string; messageType?: 'request' | 'acceptance' | 'reveal';
}
/** The child pairing a guardian-managed child exchange was approved under
 * (D5): the dependant's endpoint pubkey and its authorised client pubkey. */
export interface ChildExchangePairing { endpoint: string; client: string }
export interface StoredContactExchange extends ContactExchangeState { app?: ContactInviteAppOrigin; origin?: ContactOrigin; contactId?: string; wordsConfirmedAt?: number; wordsRecordedAt?: number; pairing?: ChildExchangePairing }
/** Child-originated: stamped at `requestChildPlan`, or an older unstamped row
 * written by that path (requester with an accepted-request origin). */
export function isChildContactExchange(exchange: StoredContactExchange): boolean {
  return exchange.pairing !== undefined || (exchange.role === 'requester' && exchange.origin?.method === 'accepted-request');
}
export interface ContactInviteVault {
  v: 1; directoryId: string; invites: StoredContactInvite[]; arrivals: ContactArrival[];
  exchanges: StoredContactExchange[]; outbox: ContactInviteOutbox[];
  /** Quarantined transcripts are retained for review, never automatically resumed. */
  conflicts?: StoredContactExchange[];
}
const HEX = /^[0-9a-f]{64}$/, ID = /^[0-9a-f]{32}$/;
const LIMIT = 512;
/** Compact replay receipts are separate from the live encrypted-packet budget.
 * They are never evicted silently, including consumed single-use invitations. */
const RECEIPT_LIMIT = 8192;
function recordId(directoryId: string): string {
  if (directoryId !== 'owner' && !/^dependant:[0-9a-f]{64}$/.test(directoryId)) throw new Error('Invalid invite directory');
  return `contact-invites:${directoryId}`;
}
function empty(directoryId: string): ContactInviteVault { return { v: 1, directoryId, invites: [], arrivals: [], exchanges: [], outbox: [] }; }
function packetHash(packet: SealedContactPacket): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([packet.v, packet.key, packet.ciphertext]))));
}
function arrivalPacketHash(arrival: ContactArrival): string | undefined { return arrival.packet ? packetHash(arrival.packet) : arrival.packetHash; }
const stamp = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
function validExchange(state: StoredContactExchange): boolean {
  try {
    if (!state || !['requester', 'recipient'].includes(state.role) || !HEX.test(state.nonce)
      || !['requested', 'accepted', 'reveal-pending', 'complete', 'declined'].includes(state.phase)) return false;
    if (state.wordsRecordedAt !== undefined && (!stamp(state.wordsRecordedAt) || state.wordsRecordedAt !== state.wordsConfirmedAt)) return false;
    if ((state.contactId !== undefined && !ID.test(state.contactId)) || (state.wordsConfirmedAt !== undefined && !stamp(state.wordsConfirmedAt))) return false;
    const request = parseContactExchangeMessage(JSON.stringify(state.request));
    if (request?.type !== 'signet-contact-request') return false;
    if (state.role === 'requester' && contactCommitment({ ...request, nonce: state.nonce }) !== request.commitment) return false;
    if (state.phase === 'accepted' && (state.role !== 'recipient' || !state.acceptance || state.reveal)) return false;
    if (state.phase === 'requested' && (state.role !== 'requester' || state.acceptance || state.reveal)) return false;
    if (state.app && !validContactInviteAppOrigin(state.app)) return false;
    if (state.pairing !== undefined && (!state.pairing || typeof state.pairing !== 'object' || !HEX.test(state.pairing.endpoint)
      || !HEX.test(state.pairing.client) || Object.keys(state.pairing).length !== 2 || state.role !== 'requester' || state.app)) return false;
    if (state.origin && (!validContactOrigin(state.origin) || state.origin.ownerIdentityPubkey !== (state.role === 'requester' ? request.from : request.to))) return false;
    if (state.phase === 'reveal-pending' && state.role !== 'requester') return false;
    if ((state.contactId || state.wordsConfirmedAt !== undefined) && state.phase !== 'complete') return false;
    if (state.acceptance) {
      const acceptance = parseContactExchangeMessage(JSON.stringify(state.acceptance));
      if (acceptance?.type !== 'signet-contact-accept' || acceptance.id !== request.id
        || acceptance.from !== request.to || acceptance.to !== request.from
        || acceptance.createdAt < request.createdAt || acceptance.createdAt >= request.expiresAt
        || acceptance.requestHash !== contactMessageHash(request)
        || (state.role === 'recipient' && acceptance.nonce !== state.nonce)) return false;
    }
    if (state.reveal) {
      if (!state.acceptance) return false;
      contactVerificationWords(request, state.acceptance, state.reveal, request.from);
    }
    return (state.phase !== 'complete' && state.phase !== 'reveal-pending') || !!state.reveal;
  } catch { return false; }
}
/** Entire bundle is validated before any restore write. */
export async function parseContactInviteVault(raw: string, directoryId: string): Promise<ContactInviteVault> {
  if (raw.length > 8 * 1024 * 1024) throw new Error('Invite state exceeds limit');
  const value = JSON.parse(raw) as ContactInviteVault;
  if (!value || value.v !== 1 || value.directoryId !== directoryId) throw new Error('Invalid invite vault');
  for (const rows of [value.invites, value.exchanges, value.outbox, value.conflicts ?? []]) {
    if (!Array.isArray(rows) || rows.length > LIMIT) throw new Error('Invite state exceeds limit');
  }
  if (!Array.isArray(value.arrivals) || value.arrivals.length > RECEIPT_LIMIT
    || value.arrivals.filter(row => row.packet !== undefined).length > LIMIT) throw new Error('Invite state exceeds limit');
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (!unique(value.invites.map(i => i.id)) || !unique(value.arrivals.map(i => i.id))
    || !unique(value.outbox.map(i => i.id)) || !unique(value.exchanges.map(i => contactExchangeKey(i.request)))) throw new Error('Duplicate invite state');
  for (const row of value.invites) {
    const invite = parseContactInvite(JSON.stringify(row.invite));
    if (!ID.test(row.id) || !HEX.test(row.identityPubkey) || !invite || invite.recipient !== row.identityPubkey
      || typeof row.name !== 'string' || row.name.length > 100 || !['standing', 'single-use'].includes(row.mode)
      || typeof row.enabled !== 'boolean' || !stamp(row.createdAt) || !stamp(row.updatedAt)
      || (row.app !== undefined && (!validContactInviteAppOrigin(row.app) || (row.app.autoAcceptUntil !== undefined
        && (row.mode !== 'single-use' || row.app.autoAcceptUntil > row.createdAt + 300 || row.app.autoAcceptUntil < row.createdAt))))
      || (row.intendedPubkey !== undefined && !HEX.test(row.intendedPubkey))) throw new Error('Invalid stored invite');
    row.invite = invite;
  }
  for (const row of value.arrivals) {
    if (!HEX.test(row.id) || !ID.test(row.inviteId) || !HEX.test(row.identityPubkey)
      || (row.channel !== undefined && row.channel !== 'invite' && row.channel !== 'exchange')
      || !stamp(row.receivedAt)
      || (row.packet === undefined ? row.dismissedAt === undefined || row.request !== undefined || !row.packetHash
        : !row.packet || row.packet.v !== 1 || !HEX.test(row.packet.key)
          || typeof row.packet.ciphertext !== 'string' || row.packet.ciphertext.length > 20000)
      || (row.packetHash !== undefined && (!HEX.test(row.packetHash) || (row.packet && row.packetHash !== packetHash(row.packet))))
      || (row.dismissedAt !== undefined && !stamp(row.dismissedAt))) throw new Error('Invalid contact arrival');
    if (row.request) {
      const request = parseContactExchangeMessage(JSON.stringify(row.request));
      if (!request || request.type !== 'signet-contact-request' || request.to !== row.identityPubkey) throw new Error('Invalid inbox request');
      row.request = request;
    }
  }
  if (!value.exchanges.every(validExchange) || !(value.conflicts ?? []).every(validExchange)) throw new Error('Invalid contact exchange state');
  for (const row of value.outbox) {
    if (!HEX.test(row.id) || row.id !== row.event?.id || row.event.kind !== 1059 || row.event.content.length > 32000
      || !HEX.test(row.identityPubkey) || (row.acknowledgedAt !== undefined && !stamp(row.acknowledgedAt))
      || !parseContactInvite(JSON.stringify({ v: 1, recipient: row.identityPubkey, secret: '0'.repeat(64), relays: row.relays }))
      || (row.exchangeId !== undefined && (!ID.test(row.exchangeId) || !value.exchanges.some(e => contactExchangeKey(e.request) === row.exchangeId)))
      || (row.messageType !== undefined && (!row.exchangeId || !['request', 'acceptance', 'reveal'].includes(row.messageType)))
      || !await verifyEvent(row.event)) throw new Error('Invalid invite outbox');
  }
  return value;
}
export async function loadContactInviteVault(directoryId: string, key: string): Promise<ContactInviteVault> {
  const row = await (await getDb()).get('privateVaultState', recordId(directoryId));
  return row ? parseContactInviteVault(await decryptSecret(row.encrypted, key), directoryId) : empty(directoryId);
}
export function updateContactInviteVault(directoryId: string, key: string,
  change: (state: ContactInviteVault) => ContactInviteVault): Promise<ContactInviteVault> {
  return privateVaultQueue.run(async () => {
    // The synchronous change is re-run on CAS collision; it must have no effects.
    const next = await updateEncryptedPrivateState<ContactInviteVault>(recordId(directoryId), key, async old => {
      const next = change(old ?? empty(directoryId));
      if (old && JSON.stringify(next) === JSON.stringify(old)) return old;
      return parseContactInviteVault(JSON.stringify(next), directoryId);
    });
    return next;
  });
}
export function createStoredContactInvite(args: { identityPubkey: string; name: string; relays: string[];
  mode?: 'standing' | 'single-use'; now: number; expiresAt?: number; caption?: string; intendedPubkey?: string }): StoredContactInvite {
  const secret = bytesToHex(randomBytes(32));
  const invite = parseContactInvite(JSON.stringify({ v: 1, recipient: args.identityPubkey, secret, relays: args.relays, expiresAt: args.expiresAt, caption: args.caption }), args.now);
  if ((args.intendedPubkey !== undefined && (!HEX.test(args.intendedPubkey) || args.mode !== 'single-use'))
    || !invite || !args.name.trim() || args.name.length > 100 || !stamp(args.now)) throw new Error('Invalid invite details');
  return { id: bytesToHex(sha256(new TextEncoder().encode(secret))).slice(0, 32), identityPubkey: args.identityPubkey,
    name: args.name.trim(), invite, mode: args.mode ?? 'standing', enabled: true, createdAt: args.now, updatedAt: args.now,
    ...(args.intendedPubkey ? { intendedPubkey: args.intendedPubkey } : {}) };
}
/** Keep replay/consumption receipts and complete word transcripts; discard only
 * transport material whose work is finished. Terminal transcripts are also the
 * durable tombstones preventing stale outboxes from being resumed on restore. */
export function compactContactInviteVault(state: ContactInviteVault, now?: number): ContactInviteVault {
  if (now !== undefined && !stamp(now)) throw new Error('Invalid cleanup time');
  const conflicts = conflictedContactExchanges(state);
  const exchanges = state.exchanges.map(exchange => now !== undefined && exchange.request.expiresAt <= now
    && exchange.phase !== 'complete' && exchange.phase !== 'declined' && !conflicts.has(contactExchangeKey(exchange.request))
    ? { ...exchange, phase: 'declined' as const } : exchange);
  const terminal = new Set(exchanges.filter(e => (e.phase === 'complete' || e.phase === 'declined')
    && !conflicts.has(contactExchangeKey(e.request))).map(e => contactExchangeKey(e.request)));
  return { ...state, exchanges,
    arrivals: state.arrivals.map(row => {
      const retiredAt = row.dismissedAt ?? (now !== undefined && ((row.request && row.request.expiresAt <= now)
        || (row.channel === 'exchange' && terminal.has(row.inviteId))) ? now : undefined);
      if (retiredAt === undefined) return row;
      const { packet: _packet, request: _request, ...receipt } = row;
      return { ...receipt, packetHash: arrivalPacketHash(row), dismissedAt: retiredAt };
    }),
    outbox: state.outbox.filter(row => !row.exchangeId || !terminal.has(row.exchangeId)),
  };
}

/** Arrival processing stays local and never opens an identity seal. */
export function recordContactArrival(directoryId: string, key: string, arrival: ContactArrival): Promise<ContactInviteVault> {
  return updateContactInviteVault(directoryId, key, old => {
    const state = compactContactInviteVault(old);
    if (!arrival.packet) return state;
    const digest = packetHash(arrival.packet);
    if (state.arrivals.some(row => row.identityPubkey === arrival.identityPubkey && arrivalPacketHash(row) === digest)) return state;
    if (arrival.channel === 'exchange') {
      const exchange = state.exchanges.find(e => contactExchangeKey(e.request) === arrival.inviteId);
      if (!exchange || exchange.phase === 'complete' || exchange.phase === 'declined' || exchange.request.expiresAt <= arrival.receivedAt
        || (exchange.role === 'requester' ? exchange.request.from : exchange.request.to) !== arrival.identityPubkey
        || state.arrivals.some(a => a.id === arrival.id) || state.outbox.some(o => o.id === arrival.id)
        || state.arrivals.filter(a => a.channel === 'exchange' && a.inviteId === arrival.inviteId && a.dismissedAt === undefined).length >= CONTACT_INVITE_PENDING_LIMIT
        || state.arrivals.filter(a => a.packet !== undefined).length >= LIMIT || state.arrivals.length >= RECEIPT_LIMIT) return state;
      return { ...state, arrivals: [...state.arrivals, arrival] };
    }
    const invite = state.invites.find(i => i.id === arrival.inviteId && i.identityPubkey === arrival.identityPubkey);
    if (!invite?.enabled || (invite.invite.expiresAt !== undefined && invite.invite.expiresAt <= arrival.receivedAt)
      || state.arrivals.some(a => a.id === arrival.id)) return state;
    const rows = state.arrivals.filter(a => a.inviteId === invite.id && a.channel !== 'exchange');
    const count = rows.filter(a => a.dismissedAt === undefined).length;
    if (count >= CONTACT_INVITE_PENDING_LIMIT || state.arrivals.filter(a => a.packet !== undefined).length >= LIMIT || state.arrivals.length >= RECEIPT_LIMIT
      || (invite.mode === 'single-use' && rows.length > 0)) return state;
    return { ...state, arrivals: [...state.arrivals, arrival] };
  });
}

export function conflictedContactExchanges(state: ContactInviteVault): Set<string> {
  return new Set((state.conflicts ?? []).map(exchange => contactExchangeKey(exchange.request)));
}

/** Conflicting transcripts are quarantined together. Other contacts and vault
 * data still merge; neither branch can resume or show replacement words. */
export function mergeContactInviteVault(local: ContactInviteVault, remote: ContactInviteVault): ContactInviteVault {
  if (local.directoryId !== remote.directoryId) throw new Error('Invite vault scope mismatch');
  const invites = new Map(local.invites.map(i => [i.id, i]));
  for (const row of remote.invites) {
    const old = invites.get(row.id);
    if (old && (old.identityPubkey !== row.identityPubkey || old.invite.secret !== row.invite.secret
      || old.mode !== row.mode || old.createdAt !== row.createdAt || JSON.stringify(old.app) !== JSON.stringify(row.app))) throw new Error('Invite identity changed');
    if (!old || row.updatedAt > old.updatedAt || (row.updatedAt === old.updatedAt
      && ((!row.enabled && old.enabled) || (row.enabled === old.enabled && JSON.stringify(row) < JSON.stringify(old))))) invites.set(row.id, row);
  }
  const arrivals = new Map(local.arrivals.map(i => [i.id, i]));
  for (const row of remote.arrivals) {
    const old = arrivals.get(row.id);
    if (old && (old.inviteId !== row.inviteId || old.channel !== row.channel || old.identityPubkey !== row.identityPubkey
      || arrivalPacketHash(old) !== arrivalPacketHash(row)
      || (old.request && row.request && contactMessageHash(old.request) !== contactMessageHash(row.request)))) throw new Error('Inbox entry changed');
    arrivals.set(row.id, old ? { ...old, request: old.request ?? row.request,
      receivedAt: Math.min(old.receivedAt, row.receivedAt),
      dismissedAt: old.dismissedAt === undefined ? row.dismissedAt : row.dismissedAt === undefined ? old.dismissedAt : Math.max(old.dismissedAt, row.dismissedAt) } : row);
  }
  const conflicts = new Map<string, StoredContactExchange>();
  const retainConflict = (row: StoredContactExchange) => conflicts.set(JSON.stringify(row), row);
  for (const row of [...(local.conflicts ?? []), ...(remote.conflicts ?? [])]) retainConflict(row);
  const exchanges = new Map(local.exchanges.map(i => [contactExchangeKey(i.request), i]));
  const rank = { requested: 0, accepted: 1, 'reveal-pending': 2, complete: 4, declined: 3 };
  for (const row of remote.exchanges) {
    const old = exchanges.get(contactExchangeKey(row.request));
    if (old && (JSON.stringify(old.app) !== JSON.stringify(row.app) || JSON.stringify(old.pairing) !== JSON.stringify(row.pairing) || old.role !== row.role || old.nonce !== row.nonce || contactMessageHash(old.request) !== contactMessageHash(row.request)
      || (old.acceptance && row.acceptance && contactMessageHash(old.acceptance) !== contactMessageHash(row.acceptance))
      || (old.reveal && row.reveal && contactMessageHash(old.reveal) !== contactMessageHash(row.reveal)))) {
      retainConflict(old); retainConflict(row);
      exchanges.set(contactExchangeKey(row.request), JSON.stringify(old) < JSON.stringify(row) ? old : row);
      continue;
    }
    if (!old || rank[row.phase] > rank[old.phase]) exchanges.set(contactExchangeKey(row.request), row);
    const chosen = exchanges.get(contactExchangeKey(row.request))!;
    exchanges.set(contactExchangeKey(row.request), { ...chosen, origin: [old?.origin, row.origin].filter((origin): origin is ContactOrigin => !!origin).map(normaliseContactOrigin).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)[0], contactId: [old?.contactId, row.contactId].filter((id): id is string => !!id).sort()[0],
      wordsConfirmedAt: Math.max(old?.wordsConfirmedAt ?? 0, row.wordsConfirmedAt ?? 0) || undefined,
      wordsRecordedAt: Math.max(old?.wordsRecordedAt ?? 0, row.wordsRecordedAt ?? 0) === Math.max(old?.wordsConfirmedAt ?? 0, row.wordsConfirmedAt ?? 0) ? Math.max(old?.wordsRecordedAt ?? 0, row.wordsRecordedAt ?? 0) || undefined : undefined });
  }
  const outbox = new Map(local.outbox.map(i => [i.id, i]));
  for (const row of remote.outbox) {
    const old = outbox.get(row.id);
    if (old && (old.identityPubkey !== row.identityPubkey || old.exchangeId !== row.exchangeId || old.messageType !== row.messageType || JSON.stringify(old.relays) !== JSON.stringify(row.relays)
      || JSON.stringify(old.event) !== JSON.stringify(row.event))) throw new Error('Contact outbox entry changed');
    outbox.set(row.id, old ? { ...old, acknowledgedAt: Math.max(old.acknowledgedAt ?? 0, row.acknowledgedAt ?? 0) || undefined } : row);
  }
  return compactContactInviteVault({ v: 1, directoryId: local.directoryId,
    invites: [...invites.values()].sort((a, b) => a.id.localeCompare(b.id)),
    arrivals: [...arrivals.values()].sort((a, b) => a.id.localeCompare(b.id)),
    exchanges: [...exchanges.values()].sort((a, b) => contactExchangeKey(a.request).localeCompare(contactExchangeKey(b.request))),
    outbox: [...outbox.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ...(conflicts.size ? { conflicts: [...conflicts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row) } : {}) }); 
}
export async function restoreContactInviteVault(directoryId: string, key: string, raw: string): Promise<void> {
  const remote = await parseContactInviteVault(raw, directoryId);
  await updateContactInviteVault(directoryId, key, local => mergeContactInviteVault(local, remote));
}
