import { verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'signet-protocol';
import { vaultContentHash } from 'signet-protocol/experimental';
import { loadBotAppGrants, signWithBotAppGrant } from './bot-app-grants';
import { loadBotRegistry } from './bot-registry';
import { buildResponseEvent, MAX_NIP46_CONTENT, parseInboundRequest, parseSignEventTemplate } from './nip46-server';
import type { DecryptingSigningBackend } from './signing-backend';

/** Bot-only NIP-46 dispatcher. A verified client needs fresh bot-scoped consent
 * before even identity decryption; no owner ConnectedClient path is available.
 * The caller owns the subscription and supplies its pinned relay URL. */
export function botAppRequestHandler(options: {
  root: string; encryptionKey: string; botPubkey: string; relayUrl: string;
  isCurrent(): boolean; now?(): number; signer(): Promise<DecryptingSigningBackend>;
  /** Synchronous send on an already-open socket; false if it is not ready.
   * Do not queue a reply for later delivery beyond the final consent check. */
  publish(event: NostrEvent): boolean;
}) {
  options = { ...options };
  const seen = new Map<string, number>(), rates = new Map<string, { start: number; count: number }>();
  let pending = 0;
  const now = () => options.now?.() ?? Math.floor(Date.now() / 1000);
  const current = () => { if (!options.isCurrent()) throw new Error('Bot app session changed'); };
  return async (input: NostrEvent): Promise<void> => {
    if (!options.isCurrent() || pending >= 4) return;
    // Reconstruct to exclude nostr-tools' cached verification symbol.
    let event: NostrEvent;
    try {
      if (!input || input.kind !== 24133 || typeof input.content !== 'string' || input.content.length > MAX_NIP46_CONTENT
        || !Array.isArray(input.tags) || input.tags.length > 16 || !Number.isSafeInteger(input.created_at)
        || input.created_at < now() - 300 || input.created_at > now() + 60) return;
      event = { id: input.id, sig: input.sig, pubkey: input.pubkey, kind: input.kind, created_at: input.created_at,
        content: input.content, tags: input.tags.map(tag => [...tag]) };
      const recipients = event.tags.filter(tag => tag[0] === 'p');
      if (recipients.length !== 1 || recipients[0].length !== 2 || recipients[0][1] !== options.botPubkey || !verifyEvent(event)) return;
    } catch { return; }
    for (const [id, timestamp] of seen) if (timestamp < now() - 300) seen.delete(id);
    if (seen.has(event.id) || seen.size >= 512) return;
    // Reserve before awaiting storage, so duplicate simultaneous deliveries drop.
    seen.set(event.id, event.created_at); pending++;
    let backend: DecryptingSigningBackend | undefined;
    try {
      const grants = await loadBotAppGrants(options.root, options.encryptionKey);
      current();
      const grant = grants.filter(g => g.botPubkey === options.botPubkey && g.clientPubkey === event.pubkey && g.relayUrl === options.relayUrl
        && g.revokedAt === undefined && g.createdAt <= now() && g.expiresAt > now())
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
      if (!grant) return;
      const rate = rates.get(event.pubkey);
      if (rate && now() - rate.start < 60 && rate.count >= 30) return;
      if (!rate || now() - rate.start >= 60) rates.set(event.pubkey, { start: now(), count: 1 }); else rate.count++;
      const binding = vaultContentHash(JSON.stringify(grant));
      const permitted = async () => {
        current();
        const fresh = (await loadBotAppGrants(options.root, options.encryptionKey)).find(g => g.id === grant.id);
        const bots = await loadBotRegistry(options.root, options.encryptionKey);
        current();
        if (!fresh || vaultContentHash(JSON.stringify(fresh)) !== binding || fresh.expiresAt <= now() || fresh.createdAt > now()
          || !bots.bots.some(bot => bot.publicKey === options.botPubkey && bot.removedAt === undefined)) throw new Error('Bot app grant changed');
      };
      await permitted();
      backend = await options.signer();
      if (backend.activePublicKeyHex !== options.botPubkey) return;
      await permitted();
      const request = await parseInboundRequest(event, backend);
      if (!request || request.clientPubkey !== grant.clientPubkey) return;
      await permitted();
      let result: string | undefined, error: string | undefined;
      if (request.method === 'get_public_key' && request.params.length === 0) result = options.botPubkey;
      else if (request.method === 'ping' && request.params.length === 0) result = 'pong';
      else if (request.method === 'connect' && request.params[0] === options.botPubkey) result = 'ack';
      else if (request.method === 'sign_event' && request.params.length === 1) {
        const template = parseSignEventTemplate(request.params[0]);
        if (!template || template.pubkey !== options.botPubkey || !grant.eventKinds.includes(template.kind)) error = 'event not authorised';
        else result = JSON.stringify(await signWithBotAppGrant({ ...options, now, grantId: grant.id, clientPubkey: grant.clientPubkey,
          event: template, signer: options.signer }));
      } else error = 'method not authorised';
      await permitted();
      const response = await buildResponseEvent({ id: request.id, ...(result !== undefined ? { result } : { error }) }, event.pubkey, backend);
      // Revocation/expiry/lock during response encryption must prevent delivery.
      await permitted();
      options.publish(response);
    } catch { /* A stale or revoked request produces no usable response. */ }
    finally { backend?.destroy(); pending--; }
  };
}
