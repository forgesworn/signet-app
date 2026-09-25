import { describe, it, expect, vi, beforeEach } from 'vitest';

// The decrypt-cache test below drives the real `fetchContactsSync` — mock the
// relay transport so it resolves without a live relay. Same pattern as
// `companion-rail.test.ts` / `personas-sync.test.ts`, upgraded to per-URL so
// the relay-pool tests below can seed different relays differently.
// `events` is a single-URL convenience default the decrypt-cache tests
// still use — it's consulted only when `fetchReturns` has no entry for
// that URL.
const relayMock = vi.hoisted(() => ({
  events: [] as unknown[],
  fetchReturns: {} as Record<string, Array<{ id: string; created_at: number; content: string }>>,
  fetchThrows: new Set<string>(),
  fetchFailUrls: new Set<string>(),
  published: [] as Array<{ url: string; id: string }>,
  publishOk: {} as Record<string, boolean>,
}));
vi.mock('signet-protocol', async () => {
  const actual = await vi.importActual<typeof import('signet-protocol')>('signet-protocol');
  return {
    ...actual,
    RelayClient: class MockRelayClient {
      url: string;
      constructor(url: string) { this.url = url; }
      async connect(): Promise<void> {
        if (relayMock.fetchThrows.has(this.url)) throw new Error('connect failed');
      }
      // The pool fetch pins events to the requested author (sync-relays.ts)
      // — real relay events always carry `pubkey`, so default each seeded
      // event to the author the filter asked for unless a test sets one
      // explicitly (the foreign-author cases do).
      async fetch(filters: Array<{ authors?: string[] }>): Promise<unknown[]> {
        if (relayMock.fetchFailUrls.has(this.url)) throw new Error('fetch failed');
        const author = filters?.[0]?.authors?.[0];
        const events = relayMock.fetchReturns[this.url] ?? relayMock.events;
        return (events as Array<Record<string, unknown>>).map((e) => ({ pubkey: author, ...e }));
      }
      async publish(ev: { id: string }): Promise<{ ok: boolean }> {
        relayMock.published.push({ url: this.url, id: ev.id });
        return { ok: relayMock.publishOk[this.url] ?? true };
      }
      disconnect(): void {}
    },
  };
});

beforeEach(() => {
  relayMock.events = [];
  relayMock.fetchReturns = {};
  relayMock.fetchThrows = new Set();
  relayMock.fetchFailUrls = new Set();
  relayMock.published = [];
  relayMock.publishOk = {};
});

import type { Contact } from '../types';
import { mergeContactLists, identityKeypairs, fetchContactsSync, publishContactsSync } from './contacts-sync';
import { createSyncDecryptCache, forgetSyncCacheKeys } from './sync-decrypt-cache';

function makeContact(overrides: Partial<Contact>): Contact {
  return {
    pubkey: 'a'.repeat(64),
    ownerPubkey: 'b'.repeat(64),
    displayName: 'Test',
    sharedSecret: 'secret',
    verifiedAt: 1000,
    ...overrides,
  };
}

describe('mergeContactLists', () => {
  it('keeps local-only contacts', () => {
    const local = [makeContact({ pubkey: 'a'.repeat(64) })];
    const { merged, toSave } = mergeContactLists(local, []);
    expect(merged).toHaveLength(1);
    expect(toSave).toEqual([]);
  });

  it('adds remote-only contacts and flags them for save', () => {
    const remote = [makeContact({ pubkey: 'c'.repeat(64), displayName: 'Remote' })];
    const { merged, toSave } = mergeContactLists([], remote);
    expect(merged).toHaveLength(1);
    expect(toSave).toHaveLength(1);
    expect(toSave[0].pubkey).toBe('c'.repeat(64));
  });

  it('replaces local with remote when remote verifiedAt is newer (LWW)', () => {
    const local = [makeContact({ pubkey: 'a'.repeat(64), displayName: 'Old', verifiedAt: 1000 })];
    const remote = [makeContact({ pubkey: 'a'.repeat(64), displayName: 'New', verifiedAt: 2000 })];
    const { merged, toSave } = mergeContactLists(local, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].displayName).toBe('New');
    expect(toSave).toHaveLength(1);
  });

  it('keeps local when local verifiedAt is newer than remote', () => {
    const local = [makeContact({ pubkey: 'a'.repeat(64), displayName: 'Local-new', verifiedAt: 2000 })];
    const remote = [makeContact({ pubkey: 'a'.repeat(64), displayName: 'Remote-old', verifiedAt: 1000 })];
    const { merged, toSave } = mergeContactLists(local, remote);
    expect(merged[0].displayName).toBe('Local-new');
    expect(toSave).toEqual([]);
  });

  it('keeps local when verifiedAt is equal (stable, no save)', () => {
    const local = [makeContact({ pubkey: 'a'.repeat(64), displayName: 'Local', verifiedAt: 1000 })];
    const remote = [makeContact({ pubkey: 'a'.repeat(64), displayName: 'Remote', verifiedAt: 1000 })];
    const { merged, toSave } = mergeContactLists(local, remote);
    expect(merged[0].displayName).toBe('Local');
    expect(toSave).toEqual([]);
  });

  it('does not delete local contacts missing from remote (no-deletion policy)', () => {
    const local = [
      makeContact({ pubkey: 'a'.repeat(64), displayName: 'Local only' }),
      makeContact({ pubkey: 'b'.repeat(64), displayName: 'Both' }),
    ];
    const remote = [makeContact({ pubkey: 'b'.repeat(64), displayName: 'Both' })];
    const { merged } = mergeContactLists(local, remote);
    expect(merged).toHaveLength(2);
    expect(merged.map(c => c.displayName).sort()).toEqual(['Both', 'Local only']);
  });

  it('handles both lists empty', () => {
    const { merged, toSave } = mergeContactLists([], []);
    expect(merged).toEqual([]);
    expect(toSave).toEqual([]);
  });

  it('preserves all optional fields when saving a remote record', () => {
    const remote = [makeContact({
      pubkey: 'c'.repeat(64),
      relationship: 'parent',
      isChild: false,
      groupId: 'group-1',
      label: 'Main',
      isDefaultForGroup: true,
    })];
    const { toSave } = mergeContactLists([], remote);
    expect(toSave[0].relationship).toBe('parent');
    expect(toSave[0].groupId).toBe('group-1');
    expect(toSave[0].label).toBe('Main');
    expect(toSave[0].isDefaultForGroup).toBe(true);
  });
});

describe('identityKeypairs', () => {
  it('returns NP + persona when both are set', () => {
    const id = {
      naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'NP' },
      persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'P' },
    } as never;
    expect(identityKeypairs(id)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  });

  it('includes extra personas', () => {
    const id = {
      naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'NP' },
      persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'P' },
      extraPersonas: [
        { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Extra1', derivationName: 'persona-1' },
        { publicKey: 'd'.repeat(64), privateKey: '', displayName: 'Extra2', derivationName: 'persona-2' },
      ],
    } as never;
    expect(identityKeypairs(id)).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
    ]);
  });

  it('skips empty pubkeys', () => {
    const id = {
      naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'NP' },
      persona: { publicKey: '', privateKey: '', displayName: '' },
      extraPersonas: [],
    } as never;
    expect(identityKeypairs(id)).toEqual(['a'.repeat(64)]);
  });
});

describe('fetchContactsSync — decrypt cache', () => {
  const AUTHOR = 'b'.repeat(64);

  it('decrypts once, then serves the same event from the cache without calling the backend', async () => {
    forgetSyncCacheKeys();
    const event = {
      id: 'e'.repeat(64),
      kind: 30078,
      pubkey: AUTHOR,
      created_at: 1000,
      tags: [['d', 'signet:contacts']],
      content: fakeNip44('CT'),
      sig: '',
    };
    relayMock.events = [event];
    const nip44Decrypt = vi.fn(async () => JSON.stringify({ v: 1, contacts: [] }));
    const backend = {
      activePublicKeyHex: AUTHOR,
      nip44Decrypt,
      nip44Encrypt: vi.fn(),
      signEvent: vi.fn(),
      type: 'local',
    } as never;
    const cache = createSyncDecryptCache({
      dTag: 'signet:contacts',
      authorPubkey: AUTHOR,
      encryptionKey: 'a'.repeat(64),
    });

    const first = await fetchContactsSync(AUTHOR, backend, 'wss://relay.example', undefined, cache);
    const second = await fetchContactsSync(AUTHOR, backend, 'wss://relay.example', undefined, cache);

    expect(first).not.toBe('unreachable');
    expect(second).not.toBe('unreachable');
    expect(first && first !== 'unreachable' ? first.createdAt : undefined).toBe(1000);
    expect(second && second !== 'unreachable' ? second.createdAt : undefined).toBe(1000);
    expect(nip44Decrypt).toHaveBeenCalledTimes(1);
  });

  it('re-decrypts when the relay serves a different event id', async () => {
    forgetSyncCacheKeys();
    const base = {
      kind: 30078,
      pubkey: AUTHOR,
      tags: [['d', 'signet:contacts']],
      content: fakeNip44('CT'),
      sig: '',
    };
    const nip44Decrypt = vi.fn(async () => JSON.stringify({ v: 1, contacts: [] }));
    const backend = {
      activePublicKeyHex: AUTHOR,
      nip44Decrypt,
      nip44Encrypt: vi.fn(),
      signEvent: vi.fn(),
      type: 'local',
    } as never;
    const cache = createSyncDecryptCache({
      dTag: 'signet:contacts',
      authorPubkey: AUTHOR,
      encryptionKey: 'a'.repeat(64),
    });

    relayMock.events = [{ ...base, id: '1'.repeat(64), created_at: 1000 }];
    await fetchContactsSync(AUTHOR, backend, 'wss://relay.example', undefined, cache);
    relayMock.events = [{ ...base, id: '2'.repeat(64), created_at: 2000 }];
    const second = await fetchContactsSync(AUTHOR, backend, 'wss://relay.example', undefined, cache);

    expect(second).not.toBe('unreachable');
    expect(second && second !== 'unreachable' ? second.createdAt : undefined).toBe(2000);
    expect(nip44Decrypt).toHaveBeenCalledTimes(2);
  });
});

/**
 * A fake NIP-44 v2 ciphertext: the version byte 2, then the plaintext,
 * space-padded to the 96-byte body a real v2 payload's floor implies, then
 * base64. `openVaultPayload` pre-filters the legacy fallback on exactly that
 * shape (S5). Trailing spaces are harmless: every rail parses its plaintext
 * with `JSON.parse`, which ignores trailing whitespace.
 */
function fakeNip44(plaintext: string): string {
  const body = new TextEncoder().encode(plaintext.padEnd(96, ' '));
  const bytes = new Uint8Array(1 + body.length);
  bytes[0] = 2;
  bytes.set(body, 1);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Reverse `fakeNip44`. Throws for anything that is not one, as a real signer would. */
function openFakeNip44(ciphertext: string): string {
  const bytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  if (bytes[0] !== 2) throw new Error('not our ciphertext');
  return new TextDecoder().decode(bytes.subarray(1));
}

function makeSyncBackend(overrides: Partial<{
  activePublicKeyHex: string;
  nip44Encrypt: ReturnType<typeof vi.fn>;
  nip44Decrypt: ReturnType<typeof vi.fn>;
  signEvent: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    activePublicKeyHex: 'a'.repeat(64),
    nip44Encrypt: vi.fn(async (_pub: string, plaintext: string) => fakeNip44(plaintext)),
    nip44Decrypt: vi.fn(async (_pub: string, ciphertext: string) => openFakeNip44(ciphertext)),
    signEvent: vi.fn(async (ev: Record<string, unknown>) => ({ ...ev, id: 'sig'.padEnd(64, '0'), sig: 's'.repeat(128) })),
    type: 'local',
    ...overrides,
  } as never;
}

describe('publishContactsSync — relay pool', () => {
  it('returns true when one of two relays accepts the publish', async () => {
    relayMock.publishOk = { 'wss://a.example': false, 'wss://b.example': true };
    const backend = makeSyncBackend();
    const ok = await publishContactsSync([makeContact({})], backend, ['wss://a.example', 'wss://b.example']);
    expect(ok).toBe(true);
    expect(relayMock.published.map(p => p.url).sort()).toEqual(['wss://a.example', 'wss://b.example']);
  });

  it('never publishes an information-free record (empty payload)', async () => {
    relayMock.published = [];
    const backend = makeSyncBackend();
    const ok = await publishContactsSync([], backend, ['wss://a.example', 'wss://b.example']);
    expect(ok).toBe(false);
    expect(relayMock.published).toEqual([]);
  });
});

describe('fetchContactsSync — relay pool', () => {
  const AUTHOR = 'a'.repeat(64);

  it('dedupes events across two relays and picks the newest', async () => {
    forgetSyncCacheKeys();
    const payload = JSON.stringify({ v: 1, contacts: [] });
    relayMock.fetchReturns = {
      'wss://a.example': [{ id: '1'.repeat(64), created_at: 1000, content: fakeNip44(payload) }],
      'wss://b.example': [{ id: '2'.repeat(64), created_at: 2000, content: fakeNip44(payload) }],
    };
    const backend = makeSyncBackend({ activePublicKeyHex: AUTHOR });
    const result = await fetchContactsSync(AUTHOR, backend, ['wss://a.example', 'wss://b.example']);
    expect(result).not.toBe('unreachable');
    expect(result).not.toBeNull();
    if (result && result !== 'unreachable') {
      expect(result.eventId).toBe('2'.repeat(64));
      expect(result.createdAt).toBe(2000);
      expect(result.reachableRelays).toBe(2);
    }
  });

  it('returns "unreachable" when every relay fails to connect', async () => {
    relayMock.fetchThrows = new Set(['wss://a.example', 'wss://b.example']);
    const backend = makeSyncBackend({ activePublicKeyHex: AUTHOR });
    const result = await fetchContactsSync(AUTHOR, backend, ['wss://a.example', 'wss://b.example']);
    expect(result).toBe('unreachable');
  });
});
