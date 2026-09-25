import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import { vaultContentHash } from 'signet-protocol/experimental';
import { getDb } from './db';
import { decryptSecret } from './crypto-store';
import { updateEncryptedPrivateState } from './private-vault-store';
import { privateVaultQueue } from './private-vault-queue';
import { loadBotRegistry } from './bot-registry';
import { sanitizeDisplayName } from './text-sanitize';
import type { DecryptingSigningBackend } from './signing-backend';
import { verifyEvent } from 'nostr-tools/pure';
import { isValidRelayUrl } from './relay-url';

/** Device-local consent, separate from owner ConnectedClient.allowAlways.
 * Restoring a bot's identity never restores ongoing app signing authority. */
export interface BotAppGrant {
  id: string; botPubkey: string; clientPubkey: string; appName: string; relayUrl: string;
  eventKinds: number[]; createdAt: number; expiresAt: number; revokedAt?: number;
}
interface GrantStore { v: 1; ownerRoot: string; grants: BotAppGrant[] }
const HEX = /^[0-9a-f]{64}$/, ID = /^[0-9a-f]{32}$/;
const MAX_LIFETIME = 30 * 24 * 60 * 60;
const stamp = (value: number) => Number.isSafeInteger(value) && value >= 0;
const storageId = (root: string) => {
  if (!HEX.test(root)) throw new Error('Invalid bot grant owner');
  return `bot-app-grants:${root}`;
};
function parse(value: unknown, root: string): GrantStore {
  const store = value as GrantStore;
  if (!store || store.v !== 1 || store.ownerRoot !== root || !Array.isArray(store.grants) || store.grants.length > 256
    || new Set(store.grants.map(g => g?.id)).size !== store.grants.length) throw new Error('Invalid bot app grants');
  for (const grant of store.grants) {
    if (!grant || !ID.test(grant.id) || !HEX.test(grant.botPubkey) || !HEX.test(grant.clientPubkey)
      || grant.botPubkey === root || grant.botPubkey === grant.clientPubkey
      || typeof grant.appName !== 'string' || !grant.appName.trim() || grant.appName.length > 100
      || typeof grant.relayUrl !== 'string' || grant.relayUrl.length > 1024 || !isValidRelayUrl(grant.relayUrl)
      || !Array.isArray(grant.eventKinds) || grant.eventKinds.length < 1 || grant.eventKinds.length > 32
      || !grant.eventKinds.every(kind => Number.isInteger(kind) && kind >= 0 && kind <= 65535)
      || new Set(grant.eventKinds).size !== grant.eventKinds.length
      || !stamp(grant.createdAt) || !stamp(grant.expiresAt) || grant.expiresAt <= grant.createdAt
      || grant.expiresAt - grant.createdAt > MAX_LIFETIME
      || (grant.revokedAt !== undefined && (!stamp(grant.revokedAt) || grant.revokedAt < grant.createdAt))) throw new Error('Invalid bot app grant');
  }
  return { v: 1, ownerRoot: root, grants: store.grants.map(g => ({ id: g.id, botPubkey: g.botPubkey, clientPubkey: g.clientPubkey,
    appName: g.appName, relayUrl: g.relayUrl, eventKinds: [...g.eventKinds], createdAt: g.createdAt, expiresAt: g.expiresAt,
    ...(g.revokedAt !== undefined ? { revokedAt: g.revokedAt } : {}) })) };
}
export async function loadBotAppGrants(root: string, encryptionKey: string): Promise<BotAppGrant[]> {
  const row = await (await getDb()).get('privateVaultState', storageId(root));
  if (!row) return [];
  const raw = await decryptSecret(row.encrypted, encryptionKey);
  if (raw.length > 256 * 1024) throw new Error('Bot app grants exceed limit');
  return parse(JSON.parse(raw), root).grants;
}
interface Session { root: string; encryptionKey: string; isCurrent(): boolean; now?(): number }
function current(options: Session) { if (!options.isCurrent()) throw new Error('Bot grant session changed'); }

/** Called only after an explicit review of this bot, client, kinds and expiry. */
export async function approveBotAppGrant(options: Session & { grant: BotAppGrant }): Promise<void> {
  options = { ...options };
  const grant = structuredClone(options.grant);
  grant.appName = sanitizeDisplayName(grant.appName, 100);
  parse({ v: 1, ownerRoot: options.root, grants: [grant] }, options.root);
  if (grant.revokedAt !== undefined) throw new Error('Cannot approve a revoked grant');
  await privateVaultQueue.run(() => updateEncryptedPrivateState<GrantStore>(storageId(options.root), options.encryptionKey, async previous => {
    current(options);
    const now = options.now?.() ?? Math.floor(Date.now() / 1000);
    if (grant.createdAt > now || grant.expiresAt <= now) throw new Error('Bot grant is not current');
    const registry = await loadBotRegistry(options.root, options.encryptionKey);
    current(options);
    if (!registry.bots.some(bot => bot.publicKey === grant.botPubkey && bot.removedAt === undefined)) throw new Error('Bot is unavailable');
    const store = parse(previous ?? { v: 1, ownerRoot: options.root, grants: [] }, options.root);
    // Grant IDs are never recycled, including after revocation or expiry.
    if (store.grants.some(existing => existing.id === grant.id)) throw new Error('Bot grant ID already exists');
    const older = store.grants.map(existing => existing.botPubkey === grant.botPubkey && existing.clientPubkey === grant.clientPubkey
      && existing.revokedAt === undefined ? { ...existing, revokedAt: Math.max(now, existing.createdAt) } : existing);
    return parse({ ...store, grants: [...older, grant] }, options.root);
  }, () => current(options)));
  current(options);
}
export async function revokeBotAppGrant(options: Session & { grantId: string }): Promise<void> {
  options = { ...options };
  await privateVaultQueue.run(() => updateEncryptedPrivateState<GrantStore>(storageId(options.root), options.encryptionKey, previous => {
    current(options);
    const store = parse(previous ?? { v: 1, ownerRoot: options.root, grants: [] }, options.root);
    const grant = store.grants.find(g => g.id === options.grantId);
    if (!grant) throw new Error('Bot grant not found');
    if (grant.revokedAt !== undefined) return store;
    const now = Math.max(grant.createdAt, options.now?.() ?? Math.floor(Date.now() / 1000));
    return { ...store, grants: store.grants.map(g => g.id === grant.id ? { ...g, revokedAt: now } : g) };
  }, () => current(options)));
  current(options);
}

/** Future transport adapters must bind clientPubkey to the verified envelope
 * author. No owner grant, ownership attestation or cached decision is consulted. */
export async function signWithBotAppGrant(options: Session & {
  grantId: string; botPubkey: string; clientPubkey: string; event: UnsignedEvent;
  signer(): Promise<DecryptingSigningBackend>;
}): Promise<NostrEvent> {
  options = { ...options };
  const event = structuredClone(options.event);
  const read = async () => {
    current(options);
    const grants = await loadBotAppGrants(options.root, options.encryptionKey);
    const registry = await loadBotRegistry(options.root, options.encryptionKey);
    current(options);
    const now = options.now?.() ?? Math.floor(Date.now() / 1000);
    const grant = grants.find(g => g.id === options.grantId && g.botPubkey === options.botPubkey && g.clientPubkey === options.clientPubkey);
    if (!grant || grant.revokedAt !== undefined || grant.createdAt > now || grant.expiresAt <= now
      || event.pubkey !== grant.botPubkey || !grant.eventKinds.includes(event.kind)
      || !registry.bots.some(bot => bot.publicKey === grant.botPubkey && bot.removedAt === undefined)) throw new Error('Bot app signing is not authorised');
    return vaultContentHash(JSON.stringify(grant));
  };
  const binding = await read();
  const backend = await options.signer();
  try {
    if (backend.activePublicKeyHex !== options.botPubkey || await read() !== binding) throw new Error('Bot app grant changed');
    const result = await backend.signEvent(structuredClone(event));
    const signed = { id: result.id, sig: result.sig, pubkey: result.pubkey, kind: result.kind, created_at: result.created_at,
      tags: result.tags.map(tag => [...tag]), content: result.content };
    if (await read() !== binding) throw new Error('Bot app grant changed');
    if (signed.pubkey !== event.pubkey || signed.kind !== event.kind || signed.created_at !== event.created_at
      || signed.content !== event.content || JSON.stringify(signed.tags) !== JSON.stringify(event.tags) || !verifyEvent(signed)) throw new Error('Invalid bot app signature');
    return signed;
  } finally { backend.destroy(); }
}
