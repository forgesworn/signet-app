/**
 * The persona-inventory subscription pins its author: only the guardian's
 * endpoint (on a child-direct pairing, the RAIL key) may author the rail. A
 * relay that ignores the `authors` filter must not get a foreign event merged.
 *
 * Real keys and real NIP-44 throughout. The wrong-author events carry the
 * GENUINE rail→client ciphertext, so decryption alone would accept them —
 * only the author pin keeps them out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NostrEvent } from 'signet-protocol';

const relayMock = vi.hoisted(() => ({
  filters: [] as unknown[],
  deliver: null as null | ((ev: NostrEvent) => void),
}));
vi.mock('signet-protocol', async () => {
  const actual = await vi.importActual<typeof import('signet-protocol')>('signet-protocol');
  return {
    ...actual,
    // Delivers whatever the test hands it — no `authors` filtering, like a
    // careless or hostile relay.
    RelayClient: class MockRelayClient {
      async connect(): Promise<void> {}
      subscribe(filters: unknown[], onEvent: (ev: NostrEvent) => void): string {
        relayMock.filters = filters;
        relayMock.deliver = onEvent;
        return 'sub';
      }
      closeSubscription(): void {}
      disconnect(): void {}
    },
  };
});

import { bytesToHex } from '@noble/hashes/utils.js';
import { generateSecretKey } from 'nostr-tools/pure';
import { LocalSigningBackend } from './signing-backend';
import { subscribePersonaInventory, type PersonaInventoryPayload } from './persona-inventory-sync';

const freshKey = () => bytesToHex(generateSecretKey());
const RELAY = 'wss://relay.example';

const payload: PersonaInventoryPayload = {
  v: 1,
  revision: 1_700_000_000,
  persona: { publicKey: 'b'.repeat(64), displayName: 'Lily' },
  extraPersonas: [{ publicKey: 'c'.repeat(64), displayName: 'Gamer' }],
};

async function authoredBy(author: LocalSigningBackend, content: string): Promise<NostrEvent> {
  return author.signEvent({
    kind: 30078,
    pubkey: author.activePublicKeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', 'signet:persona-inventory']],
    content,
  });
}

const flush = () => new Promise(r => setTimeout(r, 20));

describe('subscribePersonaInventory — author pin (child-direct rail key)', () => {
  let rail: LocalSigningBackend, persona: LocalSigningBackend, stranger: LocalSigningBackend, child: LocalSigningBackend;
  let ciphertext: string;

  beforeEach(async () => {
    relayMock.filters = [];
    relayMock.deliver = null;
    rail = new LocalSigningBackend(freshKey());
    persona = new LocalSigningBackend(freshKey());
    stranger = new LocalSigningBackend(freshKey());
    child = new LocalSigningBackend(freshKey());
    ciphertext = await rail.nip44Encrypt(child.activePublicKeyHex, JSON.stringify(payload));
  });

  async function subscribe() {
    const onPayload = vi.fn();
    const unsubscribe = subscribePersonaInventory(rail.activePublicKeyHex, child, RELAY, onPayload);
    await flush();
    expect(relayMock.deliver).toBeTypeOf('function');
    return { onPayload, unsubscribe };
  }

  it('filters on, and decrypts against, the rail key', async () => {
    const { onPayload, unsubscribe } = await subscribe();
    expect(relayMock.filters).toEqual([expect.objectContaining({ authors: [rail.activePublicKeyHex] })]);
    relayMock.deliver!(await authoredBy(rail, ciphertext));
    await flush();
    expect(onPayload).toHaveBeenCalledOnce();
    expect(onPayload.mock.calls[0][0].payload).toEqual(payload);
    unsubscribe();
  });

  it('rejects the same ciphertext authored by the bound persona key', async () => {
    const { onPayload, unsubscribe } = await subscribe();
    relayMock.deliver!(await authoredBy(persona, ciphertext));
    await flush();
    expect(onPayload).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('rejects the same ciphertext authored by a random key', async () => {
    const { onPayload, unsubscribe } = await subscribe();
    relayMock.deliver!(await authoredBy(stranger, ciphertext));
    await flush();
    expect(onPayload).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('a rail-authored event still lands after a foreign one was dropped', async () => {
    const { onPayload, unsubscribe } = await subscribe();
    relayMock.deliver!(await authoredBy(persona, ciphertext));
    relayMock.deliver!(await authoredBy(rail, ciphertext));
    await flush();
    expect(onPayload).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
