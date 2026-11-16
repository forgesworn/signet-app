import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from 'signet-protocol';

const relayMock = vi.hoisted(() => ({ refuse: new Set<string>(), down: new Set<string>(), published: [] as string[] }));
vi.mock('signet-protocol', async () => ({
  ...await vi.importActual<typeof import('signet-protocol')>('signet-protocol'),
  RelayClient: class {
    constructor(public url: string) {}
    async connect() { if (relayMock.down.has(this.url)) throw new Error('down'); }
    async publish() { relayMock.published.push(this.url); return { ok: !relayMock.refuse.has(this.url) }; }
    disconnect() {}
  },
}));

import { publishToEveryRelay, publishToRelaysRequiring } from './sync-relays';

const EV = { id: 'e'.repeat(64) } as NostrEvent;
beforeEach(() => { relayMock.refuse.clear(); relayMock.down.clear(); relayMock.published = []; });

describe('publishToEveryRelay', () => {
  it('true only when every relay accepted', async () => {
    expect(await publishToEveryRelay(EV, ['wss://a.example', 'wss://b.example'])).toBe(true);
    relayMock.refuse.add('wss://b.example');
    expect(await publishToEveryRelay(EV, ['wss://a.example', 'wss://b.example'])).toBe(false);
    relayMock.refuse.clear(); relayMock.down.add('wss://a.example');
    expect(await publishToEveryRelay(EV, ['wss://a.example', 'wss://b.example'])).toBe(false);
  });
  it('dedupes, and an empty list is not a publication', async () => {
    expect(await publishToEveryRelay(EV, ['wss://a.example', 'wss://a.example'])).toBe(true);
    expect(relayMock.published).toEqual(['wss://a.example']);
    expect(await publishToEveryRelay(EV, [])).toBe(false);
  });
});

describe('publishToRelaysRequiring (A56: the child reads only its rail relay)', () => {
  it('the required relay refusing fails the publication even when another accepted', async () => {
    relayMock.refuse.add('wss://rail.example');
    expect(await publishToRelaysRequiring(EV, ['wss://a.example', 'wss://rail.example'], 'wss://rail.example')).toBe(false);
  });
  it('the required relay accepting is enough; it is published to even when the stored list lacks it', async () => {
    relayMock.down.add('wss://a.example');
    expect(await publishToRelaysRequiring(EV, ['wss://a.example'], 'wss://rail.example')).toBe(true);
    expect(relayMock.published).toContain('wss://rail.example');
  });
  it('no required relay: any acceptance, as publishToRelays', async () => {
    relayMock.refuse.add('wss://b.example');
    expect(await publishToRelaysRequiring(EV, ['wss://a.example', 'wss://b.example'], null)).toBe(true);
  });
});
