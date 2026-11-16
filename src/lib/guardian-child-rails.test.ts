import { beforeEach, describe, expect, it, vi } from 'vitest';

// A56: the persona inventory and dependant status reach a direct child on its
// rail relay as well as the guardian's own relay; a publication only counts
// once every relay accepted it.
const relayMock = vi.hoisted(() => ({ refuse: new Set<string>(), published: [] as Array<{ url: string; id: string }> }));
vi.mock('signet-protocol', async () => ({
  ...await vi.importActual<typeof import('signet-protocol')>('signet-protocol'),
  RelayClient: class {
    constructor(public url: string) {}
    async connect() {}
    async publish(ev: { id: string }) { relayMock.published.push({ url: this.url, id: ev.id }); return { ok: !relayMock.refuse.has(this.url) }; }
    disconnect() {}
  },
}));

import { LocalSigningBackend } from './signing-backend';
import { publishPersonaInventory } from './persona-inventory-sync';
import { publishDependantStatus } from './dependant-status-sync';

const CHILD = new LocalSigningBackend('05'.repeat(32)).activePublicKeyHex;
const A = 'wss://guardian.example', RAIL = 'wss://rail.example';
const inventory = () => publishPersonaInventory({ childTransportPubkey: CHILD, persona: { publicKey: 'b'.repeat(64), displayName: 'P' },
  extraPersonas: [], revision: 5 }, new LocalSigningBackend('04'.repeat(32)), [A, RAIL]);
const status = () => publishDependantStatus({ childTransportPubkey: CHILD, stage: 'request-approve', updatedAt: 5 },
  new LocalSigningBackend('04'.repeat(32)), [A, RAIL]);

beforeEach(() => { relayMock.refuse.clear(); relayMock.published = []; });

describe.each([['persona inventory', inventory], ['dependant status', status]])('%s', (_name, publish) => {
  it('signs once and publishes the same event to every relay', async () => {
    expect(await publish()).toBe(true);
    expect(relayMock.published.map(p => p.url).sort()).toEqual([A, RAIL].sort());
    expect(new Set(relayMock.published.map(p => p.id)).size).toBe(1);
  });
  it('the rail relay refusing is not a success (the hash must not be stored)', async () => {
    relayMock.refuse.add(RAIL);
    expect(await publish()).toBe(false);
  });
});
