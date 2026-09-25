import type { NostrEvent } from 'signet-protocol';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getDb } from './db';
import { decryptSecret } from './crypto-store';
import { updateEncryptedPrivateState } from './private-vault-store';
import { privateVaultQueue } from './private-vault-queue';
import { sanitizeDisplayName } from './text-sanitize';

export interface BotOwnershipState {
  event: NostrEvent;
  /** Explicit publication consent persists for renewals and revocation. */
  publishRequested: boolean; publishedEventId?: string; lastAttemptAt?: number;
}
export interface BotRecord {
  publicKey: string; ownerPersona: string; label: string;
  source: 'derived' | 'generated' | 'imported'; derivationName?: string;
  /** Local only. Profiles snapshots never include standalone signing keys. */
  privateKey?: string;
  ownership?: BotOwnershipState;
  hidden: boolean; createdAt: number; updatedAt: number; removedAt?: number;
}
export interface BotRegistry {
  v: 1; ownerRoot: string; bots: BotRecord[];
  /** Reservations include failed/abandoned creation and are never recycled. */
  allocated: string[];
  showNew: boolean; preferenceUpdatedAt: number;
}
const HEX = /^[0-9a-f]{64}$/, TOKEN = /^bot-(0|[1-9]\d*)$/;
const stamp = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const token = (v: string) => TOKEN.test(v) && Number.isSafeInteger(Number(v.slice(4))) && Number(v.slice(4)) < 0x7fffffff;
const recordId = (root: string) => { if (!HEX.test(root)) throw new Error('Invalid bot registry owner'); return `bots:${root}`; };
const empty = (ownerRoot: string): BotRegistry => ({ v: 1, ownerRoot, bots: [], allocated: [], showNew: true, preferenceUpdatedAt: 0 });
export function parseBotRegistry(raw: string, ownerRoot: string): BotRegistry {
  recordId(ownerRoot);
  if (raw.length > 1024 * 1024) throw new Error('Bot registry exceeds limit');
  const data = JSON.parse(raw) as BotRegistry;
  if (!data || data.v !== 1 || data.ownerRoot !== ownerRoot || !Array.isArray(data.bots) || data.bots.length > 128
    || !Array.isArray(data.allocated) || data.allocated.length > 4096 || !data.allocated.every(n => typeof n === 'string' && token(n))
    || new Set(data.allocated).size !== data.allocated.length || new Set(data.bots.map(b => b.publicKey)).size !== data.bots.length
    || typeof data.showNew !== 'boolean' || !stamp(data.preferenceUpdatedAt)) throw new Error('Invalid bot registry');
  const names = new Set<string>();
  for (const bot of data.bots) {
    if (!HEX.test(bot.publicKey) || !HEX.test(bot.ownerPersona) || bot.ownerPersona === ownerRoot || bot.ownerPersona === bot.publicKey
      || !['derived', 'generated', 'imported'].includes(bot.source) || typeof bot.label !== 'string' || !bot.label.trim() || bot.label.length > 100
      || typeof bot.hidden !== 'boolean' || !stamp(bot.createdAt) || !stamp(bot.updatedAt) || bot.updatedAt < bot.createdAt
      || (bot.removedAt !== undefined && (!stamp(bot.removedAt) || bot.removedAt < bot.createdAt))) throw new Error('Invalid bot record');
    if (bot.source === 'derived') {
      if (!bot.derivationName || !token(bot.derivationName) || !data.allocated.includes(bot.derivationName)
        || names.has(bot.derivationName) || bot.privateKey !== undefined) throw new Error('Invalid derived bot');
      names.add(bot.derivationName);
    } else if (bot.derivationName !== undefined) throw new Error('Standalone bot has a derivation path');
    if (bot.privateKey !== undefined) {
      if (!HEX.test(bot.privateKey)) throw new Error('Invalid bot signing key');
      const key = hexToBytes(bot.privateKey);
      try { if (getPublicKey(key) !== bot.publicKey) throw new Error('Bot signing key mismatch'); } finally { key.fill(0); }
    }
    if (bot.ownership) {
      const claim = bot.ownership, event = claim.event;
      if (!event || JSON.stringify(event).length > 8192 || event.kind !== 31000 || event.pubkey !== bot.ownerPersona
        || !Array.isArray(event.tags) || event.tags.length > 16 || !verifyEvent(event)
        || typeof claim.publishRequested !== 'boolean'
        || (claim.publishedEventId !== undefined && !HEX.test(claim.publishedEventId))
        || (claim.lastAttemptAt !== undefined && !stamp(claim.lastAttemptAt))) throw new Error('Invalid bot ownership record');
      for (const [tag, expected] of [['d', `bot-ownership:${bot.publicKey}`], ['type', 'bot-ownership'], ['p', bot.publicKey]]) {
        const values = event.tags.filter(row => row[0] === tag);
        if (values.length !== 1 || values[0][1] !== expected) throw new Error('Wrong bot ownership subject');
      }
    }
    bot.label = sanitizeDisplayName(bot.label, 100);
    if (!bot.label.trim()) throw new Error('Invalid bot label');
  }
  return data;
}
export async function loadBotRegistry(root: string, encryptionKey: string): Promise<BotRegistry> {
  const row = await (await getDb()).get('privateVaultState', recordId(root));
  return row ? parseBotRegistry(await decryptSecret(row.encrypted, encryptionKey), root) : empty(root);
}
export function updateBotRegistry(root: string, encryptionKey: string, change: (state: BotRegistry) => BotRegistry) {
  return privateVaultQueue.run(() => updateEncryptedPrivateState<BotRegistry>(recordId(root), encryptionKey, old =>
    parseBotRegistry(JSON.stringify(change(old ?? empty(root))), root)));
}
/** Public metadata only, for the encrypted profiles vault. Imported/generated
 * keys need their own backup and must never be described as words-recoverable. */
export function botRegistrySnapshot(registry: BotRegistry): BotRegistry {
  return { v: 1, ownerRoot: registry.ownerRoot, showNew: registry.showNew, preferenceUpdatedAt: registry.preferenceUpdatedAt,
    allocated: [...registry.allocated].sort(), bots: registry.bots.map(bot => ({
      publicKey: bot.publicKey, ownerPersona: bot.ownerPersona, label: bot.label, source: bot.source,
      ...(bot.derivationName ? { derivationName: bot.derivationName } : {}), hidden: bot.hidden,
      createdAt: bot.createdAt, updatedAt: bot.updatedAt,
      ...(bot.removedAt !== undefined ? { removedAt: bot.removedAt } : {}),
      ...(bot.ownership ? { ownership: {
        event: { id: bot.ownership.event.id, pubkey: bot.ownership.event.pubkey, created_at: bot.ownership.event.created_at,
          kind: bot.ownership.event.kind, tags: bot.ownership.event.tags.map(tag => [...tag]), content: bot.ownership.event.content, sig: bot.ownership.event.sig },
        publishRequested: bot.ownership.publishRequested,
        ...(bot.ownership.publishedEventId ? { publishedEventId: bot.ownership.publishedEventId } : {}),
        ...(bot.ownership.lastAttemptAt !== undefined ? { lastAttemptAt: bot.ownership.lastAttemptAt } : {}),
      } } : {}),
    })).sort((a, b) => a.publicKey.localeCompare(b.publicKey)) };

}
/** Immutable ownership and key-source conflicts fail closed. Removal wins every
 * later edit; re-adding requires an explicitly new bot instead of resurrection. */
export function mergeBotRegistry(local: BotRegistry, remote: BotRegistry): BotRegistry {
  if (local.ownerRoot !== remote.ownerRoot) throw new Error('Bot registry owner mismatch');
  const bots = new Map(local.bots.map(bot => [bot.publicKey, bot]));
  for (const incoming of remote.bots) {
    if (incoming.privateKey !== undefined) throw new Error('Profiles cannot import bot signing keys');
    const old = bots.get(incoming.publicKey);
    if (old && (old.ownerPersona !== incoming.ownerPersona || old.source !== incoming.source
      || old.derivationName !== incoming.derivationName || old.createdAt !== incoming.createdAt)) throw new Error('Conflicting bot identity');
    const selected = !old || incoming.updatedAt > old.updatedAt || (incoming.updatedAt === old.updatedAt
      && JSON.stringify([incoming.label, incoming.hidden]) < JSON.stringify([old.label, old.hidden])) ? incoming : old;
    bots.set(incoming.publicKey, { ...selected, ownership: mergeBotOwnership(old?.ownership, incoming.ownership),
      ...(old?.privateKey && old.removedAt === undefined && incoming.removedAt === undefined ? { privateKey: old.privateKey } : { privateKey: undefined }),
      ...((old?.removedAt !== undefined || incoming.removedAt !== undefined)
        ? { removedAt: Math.max(old?.removedAt ?? 0, incoming.removedAt ?? 0) } : {}) });
  }
  const newerPreference = remote.preferenceUpdatedAt > local.preferenceUpdatedAt
    || (remote.preferenceUpdatedAt === local.preferenceUpdatedAt && !remote.showNew);
  return parseBotRegistry(JSON.stringify({ ...local, bots: [...bots.values()].sort((a, b) => a.publicKey.localeCompare(b.publicKey)),
    allocated: [...new Set([...local.allocated, ...remote.allocated])].sort(),
    showNew: newerPreference ? remote.showNew : local.showNew,
    preferenceUpdatedAt: Math.max(local.preferenceUpdatedAt, remote.preferenceUpdatedAt) }), local.ownerRoot);
}
export function mergeBotOwnership(a?: BotOwnershipState, b?: BotOwnershipState): BotOwnershipState | undefined {
  if (!a) return b;
  if (!b) return a;
  const selected = b.event.created_at > a.event.created_at || (b.event.created_at === a.event.created_at && b.event.id < a.event.id) ? b : a;
  return { event: selected.event, publishRequested: a.publishRequested || b.publishRequested,
    ...([a.publishedEventId, b.publishedEventId].includes(selected.event.id) ? { publishedEventId: selected.event.id } : {}),
    ...((a.lastAttemptAt !== undefined || b.lastAttemptAt !== undefined) ? { lastAttemptAt: Math.max(a.lastAttemptAt ?? 0, b.lastAttemptAt ?? 0) } : {}) };
}
export async function createBot(args: {
  root: string; encryptionKey: string; ownerPersona: string; ownedPersonas: string[]; label: string; now: number;
  source: 'derived' | 'generated' | 'imported'; importedKey?: string;
  /** Hardware adapters MUST derive AND register, not merely look up a key. */
  deriveRegistered?: (name: string) => Promise<string>; occupiedKeys?: string[]; isCurrent(): boolean;
}): Promise<BotRecord> {
  const current = () => { if (!args.isCurrent()) throw new Error('Bot session changed'); };
  current();
  if (!args.ownedPersonas.includes(args.ownerPersona) || args.ownerPersona === args.root
    || !HEX.test(args.ownerPersona) || !stamp(args.now) || !args.label.trim() || args.label.length > 100) throw new Error('Choose an owned persona and a bot label');
  let derivationName: string | undefined, publicKey: string, privateKey: string | undefined;
  if (args.source === 'derived') {
    if (!args.deriveRegistered) throw new Error('Connect the signer to derive and register this bot');
    const reserved = await updateBotRegistry(args.root, args.encryptionKey, state => {
      current();
      const next = state.allocated.reduce((max, name) => Math.max(max, Number(name.slice(4))), -1) + 1;
      return { ...state, allocated: [...state.allocated, `bot-${next}`] };
    });
    // The reservation returned from the successful CAS owns this slot.
    derivationName = reserved.allocated[reserved.allocated.length - 1];
    current();
    publicKey = await args.deriveRegistered(derivationName);
  } else {
    if (args.source === 'imported' && (!args.importedKey || !HEX.test(args.importedKey))) throw new Error('Invalid bot private key');
    const key = args.source === 'imported' ? hexToBytes(args.importedKey!) : generateSecretKey();
    try { publicKey = getPublicKey(key); privateKey = bytesToHex(key); } finally { key.fill(0); }
  }
  current();
  let saved!: BotRecord;
  const updated = await updateBotRegistry(args.root, args.encryptionKey, state => {
    current();
    const existing = state.bots.find(b => b.publicKey === publicKey);
    if (existing && args.source === 'imported' && existing.source !== 'derived' && !existing.privateKey
      && existing.removedAt === undefined && existing.ownerPersona === args.ownerPersona) {
      saved = { ...existing, privateKey };
      return { ...state, bots: state.bots.map(bot => bot.publicKey === publicKey ? saved : bot) };
    }
    if (existing || args.ownedPersonas.includes(publicKey) || args.occupiedKeys?.includes(publicKey) || publicKey === args.root) throw new Error('This key already belongs to an identity');
    saved = { publicKey, ownerPersona: args.ownerPersona, label: args.label, source: args.source,
      ...(derivationName ? { derivationName } : {}), ...(privateKey ? { privateKey } : {}),
      hidden: !state.showNew, createdAt: args.now, updatedAt: args.now };
    return { ...state, bots: [...state.bots, saved] };
  });
  return updated.bots.find(bot => bot.publicKey === saved.publicKey)!;
}
