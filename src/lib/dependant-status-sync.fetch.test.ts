import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from 'signet-protocol';

// The relay's own `authors` / `#d` filtering is not trusted: whatever it
// returns is checked here for author, `d` tag and signature.
const relayMock = vi.hoisted(() => ({ events: [] as NostrEvent[] }));
vi.mock('signet-protocol', async () => ({
  ...await vi.importActual<typeof import('signet-protocol')>('signet-protocol'),
  RelayClient: class {
    async connect() {}
    async fetch() { return relayMock.events.map(e => ({ ...e, tags: e.tags.map(t => [...t]) })); }
    disconnect() {}
  },
}));

import { LocalSigningBackend } from './signing-backend';
import { fetchDependantStatus } from './dependant-status-sync';

const endpoint = new LocalSigningBackend('04'.repeat(32));
const child = new LocalSigningBackend('05'.repeat(32));
const stranger = new LocalSigningBackend('06'.repeat(32));
const RELAY = 'wss://relay.example';

async function statusEvent(signer: LocalSigningBackend, stage: string, createdAt: number, d = 'signet:dependant-status'): Promise<NostrEvent> {
  const content = await signer.nip44Encrypt(child.activePublicKeyHex, JSON.stringify({ v: 1, stage, updatedAt: createdAt }));
  return signer.signEvent({ kind: 30078, pubkey: signer.activePublicKeyHex, created_at: createdAt,
    tags: [['d', d], ['p', child.activePublicKeyHex]], content });
}
const fetchStatus = () => fetchDependantStatus(endpoint.activePublicKeyHex, child, RELAY);

beforeEach(() => { relayMock.events = []; });

describe('fetchDependantStatus checks what the relay returns', () => {
  it('reads a genuine status event', async () => {
    relayMock.events = [await statusEvent(endpoint, 'request-approve', 100)];
    expect((await fetchStatus())?.payload.stage).toBe('request-approve');
  });

  it('a newer event from another author is ignored, not allowed to hide the genuine one', async () => {
    relayMock.events = [await statusEvent(endpoint, 'request-approve', 100), await statusEvent(stranger, 'full-autonomy', 200)];
    expect(await fetchStatus()).toMatchObject({ payload: { stage: 'request-approve' }, createdAt: 100 });
  });

  it('a newer event of the endpoint under another d tag is ignored', async () => {
    relayMock.events = [await statusEvent(endpoint, 'request-approve', 100), await statusEvent(endpoint, 'full-autonomy', 200, 'signet:persona-inventory')];
    expect(await fetchStatus()).toMatchObject({ payload: { stage: 'request-approve' }, createdAt: 100 });
  });

  it('a re-dated replay of an older status (signature no longer valid) is ignored', async () => {
    const old = await statusEvent(endpoint, 'full-autonomy', 50);
    relayMock.events = [await statusEvent(endpoint, 'full-control', 100), { ...old, created_at: 300 }];
    expect(await fetchStatus()).toMatchObject({ payload: { stage: 'full-control' }, createdAt: 100 });
  });

  it('nothing genuine ⇒ null', async () => {
    relayMock.events = [await statusEvent(stranger, 'full-autonomy', 200)];
    expect(await fetchStatus()).toBeNull();
  });
});
