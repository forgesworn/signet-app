/**
 * BunkerSigningBackend.acceptNostrConnect — the child-direct handshake
 * (spec §4 step 5). The signer must answer as the offered persona.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  pubkeyReply: '',
  fromUriCalls: [] as { uri: string; params: Record<string, unknown> }[],
  fromUriReject: false,
  closed: 0,
}));

vi.mock('nostr-tools/nip46', () => ({
  parseBunkerInput: async () => null,
  BunkerSigner: {
    fromBunker: () => { throw new Error('not used'); },
    fromURI: async (_sk: Uint8Array, uri: string, params: Record<string, unknown>) => {
      m.fromUriCalls.push({ uri, params });
      if (m.fromUriReject) throw new Error('subscription closed before connection was established.');
      return {
        sendRequest: async (method: string) => {
          if (method === 'get_public_key') return m.pubkeyReply;
          return 'ok';
        },
        close: async () => { m.closed += 1; },
      };
    },
  },
}));

vi.mock('nostr-tools/pool', () => ({
  SimplePool: class { destroy() { /* no sockets */ } },
}));

import { BunkerSigningBackend } from './signing-backend';

const PERSONA = 'ab'.repeat(32);
const NC = `nostrconnect://${'a1'.repeat(32)}?relay=wss%3A%2F%2Fhw1.example&relay=wss%3A%2F%2Fhw2.example&secret=${'cc'.repeat(16)}`;

describe('BunkerSigningBackend.acceptNostrConnect', () => {
  beforeEach(() => { m.pubkeyReply = ''; m.fromUriCalls = []; m.fromUriReject = false; m.closed = 0; });

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

  it('a signer answering as a different pubkey is refused and torn down', async () => {
    m.pubkeyReply = 'cd'.repeat(32);
    const b = new BunkerSigningBackend('11'.repeat(32));
    await expect(b.acceptNostrConnect(NC, PERSONA, 5_000)).rejects.toThrow(/mismatch/);
    expect(b.activePublicKeyHex).toBe('');
    expect(m.closed).toBe(1);
    await expect(b.signEvent({ kind: 1, created_at: 1, tags: [], content: '', pubkey: PERSONA })).rejects.toThrow(/Not connected/);
  });

  it('propagates a handshake that never completes', async () => {
    m.fromUriReject = true;
    const b = new BunkerSigningBackend('11'.repeat(32));
    await expect(b.acceptNostrConnect(NC, PERSONA, 5_000)).rejects.toThrow();
  });
});
