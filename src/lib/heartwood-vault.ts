/** Raw-purpose requests through MySignet's existing paired client identity. */
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { parseVaultPurpose, vaultKeyContext } from 'signet-protocol/experimental';
import type { VaultDataset } from 'signet-protocol/experimental';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import type { DecryptingSigningBackend } from './signing-backend';
import { isValidRelayUrl } from './relay-url';
import { waitForReplySubscription, RELAY_READY_CAP_MS } from './relay-ready';

type Context = { purpose: string; index: number };
export type VaultRpc = (method: string, params: string[], context: Context) => Promise<string>;

export async function heartwoodVaultRequest(args: {
  clientSecret: string; bunkerUri: string; method: string; params: string[]; context: Context; timeoutMs?: number;
}): Promise<string> {
  if (!['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt'].includes(args.method)
    || !parseVaultPurpose(args.context.purpose) || !Number.isInteger(args.context.index)
    || args.context.index < 0 || args.context.index > 0xffffffff) throw new Error('Invalid vault request');
  const uri = new URL(args.bunkerUri);
  if (uri.protocol !== 'bunker:' || !/^[a-f0-9]{64}$/.test(uri.hostname)) throw new Error('Invalid vault signer');
  const relays = [...new Set(uri.searchParams.getAll('relay').filter(isValidRelayUrl))].slice(0, 8);
  if (!relays.length) throw new Error('No valid signer relays');
  const secret = hexToBytes(args.clientSecret);
  let conversation: Uint8Array;
  try { conversation = getConversationKey(secret, uri.hostname); }
  catch { secret.fill(0); throw new Error('Invalid vault signer key'); }
  const pool = new SimplePool();
  const id = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  let close: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const content = encrypt(JSON.stringify({ id, method: args.method, params: args.params, heartwood: args.context }), conversation);
    const request = finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', uri.hostname]], content }, secret);
    const replyFilter = { kinds: [24133], authors: [uri.hostname], '#p': [getPublicKey(secret)] };
    return await new Promise<string>((resolve, reject) => {
      let done = false;
      const finish = (result?: string, error?: Error) => {
        if (done) return;
        done = true;
        if (error) reject(error); else resolve(result!);
      };
      // Covers the whole call, including the reply-subscription wait below —
      // started first, exactly as before this change.
      timer = setTimeout(() => finish(undefined, new Error('Vault signer did not respond')), args.timeoutMs ?? 60000);
      const sub = pool.subscribeMany(relays, replyFilter, {
        onevent: event => {
          if (event.pubkey !== uri.hostname || event.content.length > 100000 || !verifyEvent(event)) return;
          try {
            const reply = JSON.parse(decrypt(event.content, conversation));
            if (reply?.id !== id) return;
            if (reply.error) finish(undefined, new Error('The signer refused the vault request'));
            else if (typeof reply.result === 'string' && reply.result !== 'auth_url') finish(reply.result);
            else finish(undefined, new Error('The signer requires approval for this vault request'));
          } catch { /* Ignore malformed/foreign replies; timeout remains armed. */ }
        },
      });
      close = () => sub.close();
      // The reply subscription above must be live on every relay before the
      // request goes out, or a fast reply can arrive before the REQ and be
      // missed — the same race BunkerSigningBackend.initSigner closes for its
      // own reply subscription. Publish only once the probe settles.
      void waitForReplySubscription(pool, relays, { ...replyFilter, limit: 0 }, RELAY_READY_CAP_MS).then(() => {
        if (done) return;
        void Promise.any(pool.publish(relays, request)).catch(() => finish(undefined, new Error('Could not reach the vault signer')));
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    close?.(); pool.destroy(); secret.fill(0); conversation.fill(0);
  }
}

/** No persona fallback. A signer that ignores the context must be rejected. */
export class HeartwoodVaultBackend implements DecryptingSigningBackend {
  readonly type = 'bunker' as const;
  private destroyed = false;
  private constructor(readonly activePublicKeyHex: string, private readonly context: Context, private readonly rpc: VaultRpc) {}

  static async create(dataset: VaultDataset, rotation: number, rpc: VaultRpc, identityPubkeys: readonly string[]): Promise<HeartwoodVaultBackend> {
    const context = vaultKeyContext(dataset, rotation);
    const pubkey = await rpc('get_public_key', [], context);
    return HeartwoodVaultBackend.fromResolvedPubkey(pubkey, context, rpc, identityPubkeys);
  }

  /**
   * Build an instance from an ALREADY-RESOLVED vault pubkey — no RPC. Runs
   * the same validation and identityPubkeys exclusion check `create()` does,
   * against the identityPubkeys passed to THIS call: a cache that shares the
   * resolved pubkey across calls (BunkerSigningBackend.vaultBackend) must
   * still re-check exclusion on every call, hit or miss, since an identity
   * added after the pubkey was first resolved would otherwise go unchecked.
   */
  static fromResolvedPubkey(pubkey: string, context: Context, rpc: VaultRpc, identityPubkeys: readonly string[]): HeartwoodVaultBackend {
    if (!/^[0-9a-f]{64}$/.test(pubkey) || identityPubkeys.includes(pubkey)) throw new Error('Signer did not resolve a dedicated vault key');
    return new HeartwoodVaultBackend(pubkey, context, rpc);
  }
  private request(method: string, params: string[]): Promise<string> {
    if (this.destroyed) return Promise.reject(new Error('Vault backend destroyed'));
    return this.rpc(method, params, this.context);
  }
  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    if (event.pubkey !== this.activePublicKeyHex || event.kind !== 30078
      || new TextEncoder().encode(event.content).length > 12288) throw new Error('Invalid vault control event');
    const signed = JSON.parse(await this.request('sign_event', [JSON.stringify(event)])) as NostrEvent;
    if (signed.pubkey !== event.pubkey || signed.kind !== event.kind || signed.content !== event.content
      || signed.created_at !== event.created_at || JSON.stringify(signed.tags) !== JSON.stringify(event.tags)
      || !verifyEvent(signed)) throw new Error('Invalid vault control signature');
    return signed;
  }
  nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    if (peer !== this.activePublicKeyHex) return Promise.reject(new Error('Vault keys wrap only to themselves'));
    return this.request('nip44_encrypt', [peer, plaintext]);
  }
  nip44Decrypt(peer: string, ciphertext: string): Promise<string> {
    if (peer !== this.activePublicKeyHex) return Promise.reject(new Error('Vault keys unwrap only their own backups'));
    return this.request('nip44_decrypt', [peer, ciphertext]);
  }
  destroy(): void { this.destroyed = true; }
}
