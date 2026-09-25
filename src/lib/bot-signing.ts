import { vaultContentHash } from 'signet-protocol/experimental';
import { verifyEvent } from 'nostr-tools/pure';
import { loadIdentityDecrypted } from './db';
import { loadBotRegistry, type BotRecord } from './bot-registry';
import { deriveExtraPersona } from './signet';
import { assertSigningIdentity } from './guardian-signing';
import { LocalSigningBackend, type DecryptingSigningBackend, type SigningMode } from './signing-backend';

/** Dedicated bot route. Callers still obtain user/grant consent for each action;
 * neither owning a bot nor having an ownership attestation supplies that consent.
 * Every operation reloads encrypted records, including after a hardware wait. */
export async function createBotSigningBackend(options: {
  identityId: string; ownerRoot: string; botPubkey: string; encryptionKey: string; mode: SigningMode;
  isCurrent(): boolean; routed(pubkey: string): DecryptingSigningBackend | null;
}): Promise<DecryptingSigningBackend> {
  options = { ...options };
  let destroyed = false;
  const current = () => {
    if (destroyed || !options.isCurrent()) throw new Error('Bot signing session changed');
  };
  const read = async () => {
    current();
    const identity = await loadIdentityDecrypted(options.identityId, options.encryptionKey);
    current();
    if (!identity || identity.naturalPerson.publicKey !== options.ownerRoot) throw new Error('Bot owner identity is unavailable');
    const registry = await loadBotRegistry(options.ownerRoot, options.encryptionKey);
    current();
    const bot = registry.bots.find(row => row.publicKey === options.botPubkey && row.removedAt === undefined);
    const personas = [identity.persona, ...(identity.professionalPersona ? [identity.professionalPersona] : []), ...(identity.extraPersonas ?? [])];
    if (registry.ownerRoot !== options.ownerRoot || !bot || bot.ownerPersona === options.ownerRoot
      || !personas.some(persona => persona.publicKey === bot.ownerPersona)) throw new Error('This bot is not owned by an available persona');
    return { identity, bot };
  };
  // Labels and carousel visibility are presentation preferences, not revocation.
  const binding = (bot: BotRecord) => vaultContentHash(JSON.stringify([bot.publicKey, bot.ownerPersona, bot.source, bot.derivationName, bot.privateKey]));
  const initial = await read(), pinned = binding(initial.bot);
  const type: SigningMode = initial.bot.source === 'derived' ? options.mode : 'local';
  const invoke = async <T>(run: (backend: DecryptingSigningBackend) => Promise<T>): Promise<T> => {
    const { identity, bot } = await read();
    if (binding(bot) !== pinned) throw new Error('Bot signing record changed');
    let backend: DecryptingSigningBackend | null, local = false;
    if (bot.source !== 'derived') {
      if (!bot.privateKey) throw new Error('This standalone bot key is not stored on this device');
      backend = new LocalSigningBackend(bot.privateKey); local = true;
    } else if (options.mode === 'local') {
      if (!identity.mnemonic || !bot.derivationName || !/^bot-(0|[1-9]\d*)$/.test(bot.derivationName)) throw new Error('Bot recovery path is unavailable');
      backend = new LocalSigningBackend(deriveExtraPersona(identity.mnemonic, bot.derivationName).privateKey); local = true;
    } else backend = options.routed(bot.publicKey);
    if (!backend) throw new Error('Connect the signer for this bot');
    try {
      current(); assertSigningIdentity(backend, bot.publicKey);
      const result = await run(backend);
      current(); assertSigningIdentity(backend, bot.publicKey);
      const fresh = await read();
      if (binding(fresh.bot) !== pinned) throw new Error('Bot signing record changed');
      return result;
    } finally { if (local) backend.destroy(); }
  };
  return {
    type, activePublicKeyHex: options.botPubkey,
    signEvent: event => {
      const template = structuredClone(event);
      if (template.pubkey !== options.botPubkey) return Promise.reject(new Error('Event names a different bot identity'));
      return invoke(async backend => {
        const signed = await backend.signEvent(structuredClone(template));
        const fresh = { id: signed.id, sig: signed.sig, pubkey: signed.pubkey, kind: signed.kind,
          created_at: signed.created_at, content: signed.content, tags: signed.tags.map(tag => [...tag]) };
        if (fresh.pubkey !== options.botPubkey || fresh.kind !== template.kind || fresh.created_at !== template.created_at
          || fresh.content !== template.content || JSON.stringify(fresh.tags) !== JSON.stringify(template.tags)
          || !verifyEvent(fresh)) throw new Error('Bot signer returned a different or invalid event');
        return fresh;
      });
    },
    nip44Encrypt: (peer, text) => invoke(backend => backend.nip44Encrypt(peer, text)),
    nip44Decrypt: (peer, text) => invoke(backend => backend.nip44Decrypt(peer, text)),
    destroy: () => { destroyed = true; },
  };
}
