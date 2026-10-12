/**
 * BunkerSigningBackend.acceptNostrConnect — the child-direct handshake
 * (spec §4 step 5). The signer must answer as the offered persona.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  pubkeyReply: '',
  fromUriCalls: [] as { uri: string; params: Record<string, unknown> }[],
  fromUriKeys: [] as Uint8Array[],
  fromUriReject: false,
  closed: 0,
  pubkeyHang: false,
  fromBunkerCalls: [] as { pubkey: string; relays: string[]; secret: string | null }[],
  fromBunkerKeys: [] as Uint8Array[],
  pairedClosed: 0,
}));

vi.mock('nostr-tools/nip46', () => ({
  parseBunkerInput: async (uri: string) => {
    const u = new URL(uri.replace('bunker://', 'https://'));
    return { pubkey: u.hostname, relays: u.searchParams.getAll('relay'), secret: u.searchParams.get('secret') };
  },
  BunkerSigner: {
    fromBunker: (sk: Uint8Array, bp: { pubkey: string; relays: string[]; secret: string | null }) => {
      m.fromBunkerCalls.push(bp);
      m.fromBunkerKeys.push(sk);
      return {
        getPublicKey: async () => (m.pubkeyHang ? new Promise<string>(() => {}) : m.pubkeyReply),
        sendRequest: async () => 'ack',
        close: async () => { m.pairedClosed += 1; },
      };
    },
    fromURI: async (sk: Uint8Array, uri: string, params: Record<string, unknown>) => {
      m.fromUriCalls.push({ uri, params });
      m.fromUriKeys.push(sk);
      if (m.fromUriReject) throw new Error('subscription closed before connection was established.');
      return {
        sendRequest: async (method: string) => {
          // The real BunkerSigner keeps `sk` by reference and encrypts every
          // request with it — an all-zero key is nostr-tools' "invalid scalar".
          if (sk.every((b) => b === 0)) throw new Error('invalid scalar: out of range');
          if (method === 'get_public_key') return m.pubkeyHang ? new Promise<string>(() => {}) : m.pubkeyReply;
          return 'ok';
        },
        close: async () => { m.closed += 1; },
      };
    },
  },
}));

vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    destroy() { /* no sockets */ }
    subscribe(_r: string[], _f: unknown, h: { oneose?: () => void }) { queueMicrotask(() => h.oneose?.()); return { close() { /* nothing */ } }; }
  },
}));

import { BunkerSigningBackend, BunkerPubkeyMismatchError } from './signing-backend';

const PERSONA = 'ab'.repeat(32);
const NC = `nostrconnect://${'a1'.repeat(32)}?relay=wss%3A%2F%2Fhw1.example&relay=wss%3A%2F%2Fhw2.example&secret=${'cc'.repeat(16)}`;

describe('BunkerSigningBackend.acceptNostrConnect', () => {
  beforeEach(() => { m.pubkeyReply = ''; m.fromUriCalls = []; m.fromUriKeys = []; m.fromUriReject = false; m.closed = 0; m.pubkeyHang = false; m.fromBunkerCalls = []; m.fromBunkerKeys = []; m.pairedClosed = 0; });

  it('pins get_public_key to the persona and stores a secret-free bunker URI for reconnects', async () => {
    m.pubkeyReply = PERSONA;
    const b = new BunkerSigningBackend('11'.repeat(32));
    const uri = await b.acceptNostrConnect(NC, PERSONA, 5_000);
    expect(b.activePublicKeyHex).toBe(PERSONA);
    expect(uri).toBe(b.bunkerUri);
    expect(uri.startsWith(`bunker://${PERSONA}?`)).toBe(true);
    expect(uri).not.toContain('secret');
    expect(new URL(uri.replace('bunker://', 'https://')).searchParams.getAll('relay')).toEqual(['wss://hw1.example', 'wss://hw2.example']);
    expect(m.fromUriCalls[0].uri).toBe(NC);
    expect(m.fromUriCalls[0].params.skipSwitchRelays).toBe(true);
  });

  it('keeps the client key intact while the signer lives and wipes it when the transport is dropped', async () => {
    m.pubkeyReply = PERSONA;
    const b = new BunkerSigningBackend('11'.repeat(32));
    await b.acceptNostrConnect(NC, PERSONA, 5_000);
    const key = m.fromUriKeys[0];
    expect(Array.from(key).every((x) => x === 0x11)).toBe(true);
    b.destroy();
    expect(key.every((x) => x === 0)).toBe(true);
  });

  it('wipes the client key when the handshake fails after the signer arrived', async () => {
    m.pubkeyReply = 'cd'.repeat(32);
    const b = new BunkerSigningBackend('11'.repeat(32));
    await expect(b.acceptNostrConnect(NC, PERSONA, 5_000)).rejects.toThrow(/mismatch/);
    expect(m.fromUriKeys[0].every((x) => x === 0)).toBe(true);
  });

  it('a signer answering as a different pubkey is refused and torn down', async () => {
    m.pubkeyReply = 'cd'.repeat(32);
    const b = new BunkerSigningBackend('11'.repeat(32));
    await expect(b.acceptNostrConnect(NC, PERSONA, 5_000)).rejects.toBeInstanceOf(BunkerPubkeyMismatchError);
    expect(b.activePublicKeyHex).toBe('');
    expect(m.closed).toBe(1);
    await expect(b.signEvent({ kind: 1, created_at: 1, tags: [], content: '', pubkey: PERSONA })).rejects.toThrow(/Not connected/);
  });

  it('propagates a handshake that never completes', async () => {
    m.fromUriReject = true;
    const b = new BunkerSigningBackend('11'.repeat(32));
    await expect(b.acceptNostrConnect(NC, PERSONA, 5_000)).rejects.toThrow();
  });

  it('A29: an abort while get_public_key is pending rejects at once and tears the backend down', async () => {
    m.pubkeyHang = true;
    const b = new BunkerSigningBackend('11'.repeat(32));
    const ac = new AbortController();
    const p = b.acceptNostrConnect(NC, PERSONA, 60_000, ac.signal);
    await new Promise(r => setTimeout(r, 0));
    ac.abort();
    await expect(p).rejects.toThrow(/cancelled/i);
    expect(m.closed).toBe(1);
    expect(b.activePublicKeyHex).toBe('');
    await expect(b.signEvent({ kind: 1, created_at: 1, tags: [], content: '', pubkey: PERSONA })).rejects.toThrow(/Not connected/);
  });

  it('A29: an abort before the handshake starts rejects without connecting', async () => {
    const b = new BunkerSigningBackend('11'.repeat(32));
    const ac = new AbortController();
    ac.abort();
    await expect(b.acceptNostrConnect(NC, PERSONA, 60_000, ac.signal)).rejects.toThrow(/cancelled/i);
  });
});

describe('BunkerSigningBackend.connectAsPairedClient (missed-ACK fallback)', () => {
  const RELAYS = ['wss://hw1.example', 'wss://hw2.example'];
  beforeEach(() => { m.pubkeyReply = ''; m.fromBunkerCalls = []; m.fromBunkerKeys = []; m.pairedClosed = 0; m.pubkeyHang = false; });

  it('connects as an ordinary bunker client to the persona, pins get_public_key, and returns a secret-free URI', async () => {
    m.pubkeyReply = PERSONA;
    const b = new BunkerSigningBackend('11'.repeat(32));
    const uri = await b.connectAsPairedClient(PERSONA, RELAYS, 5_000);
    expect(m.fromBunkerCalls).toHaveLength(1);
    expect(m.fromBunkerCalls[0].pubkey).toBe(PERSONA);
    expect(m.fromBunkerCalls[0].relays).toEqual(RELAYS);
    expect(m.fromBunkerCalls[0].secret).toBeNull();
    expect(Array.from(m.fromBunkerKeys[0]).every((x) => x === 0x11)).toBe(true);
    expect(uri).toBe(b.bunkerUri);
    expect(uri.startsWith(`bunker://${PERSONA}?`)).toBe(true);
    expect(uri).not.toContain('secret');
    expect(new URL(uri.replace('bunker://', 'https://')).searchParams.getAll('relay')).toEqual(RELAYS);
    expect(b.activePublicKeyHex).toBe(PERSONA);
  });

  it('a different pubkey is a typed mismatch and is torn down', async () => {
    m.pubkeyReply = 'cd'.repeat(32);
    const b = new BunkerSigningBackend('11'.repeat(32));
    await expect(b.connectAsPairedClient(PERSONA, RELAYS, 5_000)).rejects.toBeInstanceOf(BunkerPubkeyMismatchError);
    expect(b.activePublicKeyHex).toBe('');
    expect(m.pairedClosed).toBe(1);
  });

  it('an abort while get_public_key is pending rejects at once and tears the backend down', async () => {
    m.pubkeyHang = true;
    const b = new BunkerSigningBackend('11'.repeat(32));
    const ac = new AbortController();
    const p = b.connectAsPairedClient(PERSONA, RELAYS, 60_000, ac.signal);
    await new Promise(r => setTimeout(r, 0));
    ac.abort();
    await expect(p).rejects.toThrow(/cancelled/i);
    expect(m.pairedClosed).toBe(1);
    expect(b.activePublicKeyHex).toBe('');
    await expect(b.signEvent({ kind: 1, created_at: 1, tags: [], content: '', pubkey: PERSONA })).rejects.toThrow(/Not connected/);
  });

  it('an abort before it starts rejects without connecting', async () => {
    const b = new BunkerSigningBackend('11'.repeat(32));
    const ac = new AbortController();
    ac.abort();
    await expect(b.connectAsPairedClient(PERSONA, RELAYS, 5_000, ac.signal)).rejects.toThrow(/cancelled/i);
    expect(m.fromBunkerCalls).toHaveLength(0);
  });

  it('a get_public_key that never answers times out and tears down', async () => {
    m.pubkeyHang = true;
    const b = new BunkerSigningBackend('11'.repeat(32));
    await expect(b.connectAsPairedClient(PERSONA, RELAYS, 50)).rejects.toThrow(/timed out/i);
    expect(m.pairedClosed).toBe(1);
  });
});
