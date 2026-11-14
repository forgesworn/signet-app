import { describe, expect, it } from 'vitest';
import { PHONE_APP_RECENT_SECONDS, phoneDependence, type PhoneDependenceInput } from './phone-dependence';

const NOW = 1_800_000_000;
const DAY = 86_400;
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function input(over: Partial<PhoneDependenceInput> = {}): PhoneDependenceInput {
  return {
    install: 'owner', nowS: NOW, connectedClients: [], handedOffClientPubkeys: [], nip55Grants: {}, dependants: [], ...over,
  };
}
const client = (name: string, ageDays: number, pk = A) => ({ clientPubkey: pk, appName: name, lastSeenAt: NOW - ageDays * DAY });
const grant = (over: Record<string, unknown> = {}) => ({ pubkey: A, allowAlways: true, denyAlways: false, grantedAt: (NOW - 90 * DAY) * 1000, ...over });

describe('phoneDependence', () => {
  it('says nothing needs the phone on an empty install', () => {
    expect(phoneDependence(input())).toEqual({
      needed: false, names: [], title: '', text: '', bunkerLine: 'Nothing needs this phone to stay open right now.',
    });
  });

  it('a child install always needs it, without names', () => {
    expect(phoneDependence(input({ install: 'child' }))).toEqual({
      needed: true, names: [], title: 'Signet stopped signing',
      text: "Your apps and games can't reach Signet until you open and unlock it.", bunkerLine: '',
    });
  });

  it('counts a direct-paired child, and a phone-paired child only once something is paired', () => {
    const r = phoneDependence(input({
      dependants: [
        { displayName: 'Direct', childDevice: { mode: 'heartwood-direct' } as never },
        { displayName: 'Bare', bunkerEndpoint: {} as never },
        { displayName: 'Unpaired app slot', appBunkerEndpoint: { pairings: [] } as never },
        { displayName: 'Phone', bunkerEndpoint: { authorizedClientPubkey: A } as never },
        { displayName: 'AppPaired', appBunkerEndpoint: { pairings: [{}] } as never },
      ],
    }));
    expect(r.names).toEqual(['Direct', 'Phone', 'AppPaired']);
    expect(r.title).toBe('Signet stopped signing');
    expect(r.text).toBe("Direct, Phone and AppPaired can't reach Signet until you open and unlock it.");
    expect(r.bunkerLine).toBe('Needed by Direct, Phone and AppPaired.');
  });

  it('children come first, then apps most recently used first', () => {
    const r = phoneDependence(input({
      dependants: [{ displayName: 'Kid', childDevice: { mode: 'heartwood-direct' } as never }],
      connectedClients: [client('Old', 20, A), client('  ', 1, B)],
      nip55Grants: { 'app.amethyst': grant({ lastUsedAt: (NOW - 5 * DAY) * 1000, label: ' Amethyst ' }) },
    }));
    expect(r.names).toEqual(['Kid', 'Unnamed app', 'Amethyst', 'Old']);
  });

  it('ignores Nostr Connect apps handed to the Heartwood (case-insensitive) and stale ones', () => {
    const r = phoneDependence(input({
      connectedClients: [client('Handed', 1, A.toUpperCase()), client('Stale', 31, B)],
      handedOffClientPubkeys: [A],
    }));
    expect(r.needed).toBe(false);
  });

  it('keeps an app seen exactly at the recency edge', () => {
    const r = phoneDependence(input({ connectedClients: [{ clientPubkey: A, appName: 'Edge', lastSeenAt: NOW - PHONE_APP_RECENT_SECONDS }] }));
    expect(r.names).toEqual(['Edge']);
  });

  it('counts only allow-always phone-app grants that were used recently', () => {
    const r = phoneDependence(input({
      nip55Grants: {
        'ask.each.time': grant({ allowAlways: false, lastUsedAt: NOW * 1000 }),
        'denied': grant({ denyAlways: true, lastUsedAt: NOW * 1000 }),
        'old.grant': grant(),
        'unused.since.upgrade': grant({ grantedAt: 0 }),
        'used.recently': grant({ lastUsedAt: (NOW - 2 * DAY) * 1000 }),
        'fresh.grant': grant({ grantedAt: (NOW - DAY) * 1000 }),
      },
    }));
    expect(r.names).toEqual(['fresh.grant', 'used.recently']);
  });

  it('de-duplicates names case-insensitively, keeping the first', () => {
    const r = phoneDependence(input({
      dependants: [{ displayName: 'Amy', childDevice: { mode: 'heartwood-direct' } as never }],
      connectedClients: [client('amy', 1), client('Zed', 2, B)],
    }));
    expect(r.names).toEqual(['Amy', 'Zed']);
  });

  it('formats one, two, three and many names', () => {
    const many = (n: number) => phoneDependence(input({
      connectedClients: Array.from({ length: n }, (_, k) => ({ clientPubkey: String(k).padStart(64, '0'), appName: `App${k}`, lastSeenAt: NOW - k })),
    }));
    expect(many(1).bunkerLine).toBe('Needed by App0.');
    expect(many(2).bunkerLine).toBe('Needed by App0 and App1.');
    expect(many(3).bunkerLine).toBe('Needed by App0, App1 and App2.');
    expect(many(4).bunkerLine).toBe('Needed by App0, App1 and 2 more.');
    expect(many(6).text).toBe("App0, App1 and 4 more can't reach Signet until you open and unlock it.");
  });
});
