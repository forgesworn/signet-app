import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';
import type { SigningBackend } from './signing-backend';

const relayMock = vi.hoisted(() => ({
  published: [] as Array<{ relayUrl: string; event: { content: string; pubkey: string; tags: string[][] } }>,
}));

vi.mock('signet-protocol', async () => {
  const actual = await vi.importActual<typeof import('signet-protocol')>('signet-protocol');
  return {
    ...actual,
    RelayClient: class MockRelayClient {
      constructor(private readonly relayUrl: string) {}
      async connect(): Promise<void> {}
      async publish(event: { content: string; pubkey: string; tags: string[][] }): Promise<{ ok: boolean }> {
        relayMock.published.push({ relayUrl: this.relayUrl, event });
        return { ok: true };
      }
      disconnect(): void {}
    },
  };
});

describe('sendConnectResponse', () => {
  beforeEach(() => {
    relayMock.published = [];
  });

  it('echoes the nostrconnect secret so nostr-tools BunkerSigner.fromURI can complete pairing', async () => {
    const signerSk = generateSecretKey();
    const signerPubkey = getPublicKey(signerSk);
    const clientSk = generateSecretKey();
    const clientPubkey = getPublicKey(clientSk);
    const secret = 'pair-secret-123';

    const backend: SigningBackend = {
      type: 'local',
      activePublicKeyHex: signerPubkey,
      signEvent: async (event) => finalizeEvent(event, signerSk),
      nip44Encrypt: async (recipientPubkey, plaintext) =>
        encrypt(plaintext, getConversationKey(signerSk, recipientPubkey)),
      destroy: () => {},
    };

    const { sendConnectResponse } = await import('./nip46');
    const ok = await sendConnectResponse({
      clientPubkey,
      relayUrl: 'wss://relay.example.com',
      relayUrls: ['wss://relay.example.com'],
      secret,
      appName: 'CANARY',
      appUrl: 'https://canary.trotters.cc',
    }, backend);

    expect(ok).toBe(true);
    expect(relayMock.published).toHaveLength(1);
    expect(relayMock.published[0].relayUrl).toBe('wss://relay.example.com');

    const event = relayMock.published[0].event;
    expect(event.pubkey).toBe(signerPubkey);
    expect(event.tags).toEqual([['p', clientPubkey]]);

    const plaintext = decrypt(event.content, getConversationKey(clientSk, signerPubkey));
    expect(JSON.parse(plaintext)).toEqual(expect.objectContaining({ result: secret }));
  });

  it('can publish the connect response through a selected fallback relay', async () => {
    const signerSk = generateSecretKey();
    const signerPubkey = getPublicKey(signerSk);
    const clientSk = generateSecretKey();
    const clientPubkey = getPublicKey(clientSk);

    const backend: SigningBackend = {
      type: 'local',
      activePublicKeyHex: signerPubkey,
      signEvent: async (event) => finalizeEvent(event, signerSk),
      nip44Encrypt: async (recipientPubkey, plaintext) =>
        encrypt(plaintext, getConversationKey(signerSk, recipientPubkey)),
      destroy: () => {},
    };

    const { sendConnectResponse } = await import('./nip46');
    const ok = await sendConnectResponse({
      clientPubkey,
      relayUrl: 'wss://relay.primal.net',
      relayUrls: ['wss://relay.primal.net', 'wss://relay.trotters.cc'],
      secret: 'fallback-secret',
      appName: 'CANARY',
      appUrl: 'https://canary.trotters.cc',
    }, backend, 'wss://relay.trotters.cc');

    expect(ok).toBe(true);
    expect(relayMock.published).toHaveLength(1);
    expect(relayMock.published[0].relayUrl).toBe('wss://relay.trotters.cc');
  });
});
