/**
 * Stamped NIP-46 requests (child-direct §9.2 join): the child forces the
 * kind-24133 request envelope's `created_at`, which the Heartwood echoes in
 * its C5 audit rumor. nostr-tools' BunkerSigner stamps Date.now() with no
 * hook, so BunkerSigningBackend builds that one envelope itself from the
 * signer's runtime state and lets the signer's own subscription resolve it.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { getConversationKey, decrypt } from 'nostr-tools/nip44';
import { bytesToHex } from '@noble/hashes/utils.js';
import { BunkerSigningBackend, withRequestCreatedAt } from './signing-backend';
import { RoutedBunkerSigningBackend } from './bunker-router';

const clientSk = generateSecretKey();
const remoteSk = generateSecretKey();
const remotePub = getPublicKey(remoteSk);

function fakeSigner() {
  const published: { relays: string[]; ev: { created_at: number; content: string; tags: string[][]; pubkey: string } }[] = [];
  const signer = {
    isOpen: true,
    subCloser: {},
    setupSubscription: vi.fn(),
    serial: 0,
    idPrefix: 'abc',
    conversationKey: getConversationKey(clientSk, remotePub),
    secretKey: clientSk,
    bp: { pubkey: remotePub, relays: ['wss://hw.example'] },
    listeners: {} as Record<string, { resolve(v: string): void; reject(e: unknown): void }>,
    waitingForAuth: {} as Record<string, boolean>,
    pool: { publish: (relays: string[], ev: never) => { published.push({ relays, ev }); return [Promise.resolve('ok')]; } },
    sendRequest: vi.fn(async () => 'unstamped'),
    close: async () => {},
  };
  return { signer, published };
}

function attach(b: BunkerSigningBackend, signer: unknown, pubkey: string) {
  (b as unknown as { signer: unknown }).signer = signer;
  b.activePublicKeyHex = pubkey;
}

/** Answer the most recent request the way the remote signer would. */
function answer(f: ReturnType<typeof fakeSigner>, result: (req: { method: string; params: string[] }) => string) {
  const last = f.published[f.published.length - 1].ev;
  const req = JSON.parse(decrypt(last.content, getConversationKey(remoteSk, getPublicKey(clientSk))));
  f.signer.listeners[req.id].resolve(result(req));
  return req as { id: string; method: string; params: string[] };
}

describe('BunkerSigningBackend stamped requests', () => {
  it('nip44_encrypt goes out with the forced created_at and resolves through the signer listeners', async () => {
    const f = fakeSigner();
    const b = new BunkerSigningBackend(bytesToHex(clientSk));
    attach(b, f.signer, remotePub);
    const p = withRequestCreatedAt(b, 1_900_000_123).nip44Encrypt('aa'.repeat(32), 'hello');
    await Promise.resolve();
    expect(f.published[0].ev.created_at).toBe(1_900_000_123);
    expect(f.published[0].ev.tags).toEqual([['p', remotePub]]);
    const req = answer(f, () => 'cipher');
    expect(req.method).toBe('nip44_encrypt');
    expect(req.params).toEqual(['aa'.repeat(32), 'hello']);
    await expect(p).resolves.toBe('cipher');
    expect(f.signer.sendRequest).not.toHaveBeenCalled();
  });

  it('sign_event carries the stamp on the envelope, not on the signed template', async () => {
    const f = fakeSigner();
    const b = new BunkerSigningBackend(bytesToHex(clientSk));
    attach(b, f.signer, remotePub);
    const p = withRequestCreatedAt(b, 1_900_000_200).signEvent({ kind: 1, created_at: 42, tags: [], content: 'hi', pubkey: remotePub });
    await Promise.resolve();
    expect(f.published[0].ev.created_at).toBe(1_900_000_200);
    answer(f, (req) => {
      const t = JSON.parse(req.params[0]);
      expect(t.created_at).toBe(42);
      return JSON.stringify(finalizeEvent(t, remoteSk));
    });
    await expect(p).resolves.toMatchObject({ created_at: 42, pubkey: remotePub });
  });

  it('falls back to the plain request when the signer shape is unknown', async () => {
    const b = new BunkerSigningBackend(bytesToHex(clientSk));
    const sendRequest = vi.fn(async () => 'plain');
    attach(b, { sendRequest, close: async () => {} }, remotePub);
    await expect(withRequestCreatedAt(b, 5).nip44Decrypt('aa'.repeat(32), 'x')).resolves.toBe('plain');
    expect(sendRequest).toHaveBeenCalledWith('nip44_decrypt', ['aa'.repeat(32), 'x']);
  });

  it('a backend without stamping support is used as is', async () => {
    const plain = { signEvent: vi.fn(), nip44Encrypt: vi.fn(async () => 'c'), nip44Decrypt: vi.fn(), activePublicKeyHex: 'x', type: 'local' } as never;
    await expect(withRequestCreatedAt(plain, 5).nip44Encrypt('p', 'q')).resolves.toBe('c');
  });

  it('a routed backend passes the stamp to its inner connection', async () => {
    const f = fakeSigner();
    const inner = new BunkerSigningBackend(bytesToHex(clientSk));
    const make = () => {
      inner.reconnect = async () => { attach(inner, f.signer, remotePub); };
      return inner;
    };
    const routed = new RoutedBunkerSigningBackend(bytesToHex(clientSk), `bunker://${remotePub}?relay=wss%3A%2F%2Fhw.example`, remotePub, make);
    const p = withRequestCreatedAt(routed, 1_900_000_300).nip44Encrypt('bb'.repeat(32), 'x');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(f.published[0].ev.created_at).toBe(1_900_000_300);
    answer(f, () => 'ok');
    await expect(p).resolves.toBe('ok');
  });

});
