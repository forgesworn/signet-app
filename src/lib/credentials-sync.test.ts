import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the relay transport so publish/fetch resolve without a live relay —
// same vi.hoisted per-URL pattern as personas-sync.test.ts.
const relayMock = vi.hoisted(() => ({
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
      async fetch(filters: Array<{ authors?: string[] }>): Promise<Array<{ id: string; created_at: number; content: string; pubkey?: string }>> {
        if (relayMock.fetchFailUrls.has(this.url)) throw new Error('fetch failed');
        const author = filters?.[0]?.authors?.[0];
        return (relayMock.fetchReturns[this.url] ?? []).map((e) => ({ pubkey: author, ...e }));
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
  relayMock.fetchReturns = {};
  relayMock.fetchThrows = new Set();
  relayMock.fetchFailUrls = new Set();
  relayMock.published = [];
  relayMock.publishOk = {};
});

import type { StoredCredential } from '../types';
import { mergeCredentialLists, parsePayload, publishCredentialsSync, fetchCredentialsSync } from './credentials-sync';

function makeCred(overrides: Partial<StoredCredential> = {}): StoredCredential {
  return {
    id: 'a'.repeat(64),
    documentId: 'doc-1',
    keypairType: 'persona',
    event: '{"id":"...","sig":"..."}',
    verifierPubkey: 'b'.repeat(64),
    verifiedAt: 1000,
    verifierStatus: 'confirmed',
    ...overrides,
  };
}

describe('mergeCredentialLists', () => {
  it('keeps local-only credentials', () => {
    const local = [makeCred()];
    const { merged, toSave } = mergeCredentialLists(local, []);
    expect(merged).toHaveLength(1);
    expect(toSave).toEqual([]);
  });

  it('adds remote-only credentials', () => {
    const remote = [makeCred({ id: 'c'.repeat(64) })];
    const { merged, toSave } = mergeCredentialLists([], remote);
    expect(merged).toHaveLength(1);
    expect(toSave).toHaveLength(1);
  });

  it('LWW: remote wins when verifiedAt is newer', () => {
    const local = [makeCred({ verifiedAt: 1000, verifierStatus: 'pending' })];
    const remote = [makeCred({ verifiedAt: 2000, verifierStatus: 'confirmed' })];
    const { merged, toSave } = mergeCredentialLists(local, remote);
    expect(merged[0].verifierStatus).toBe('confirmed');
    expect(toSave).toHaveLength(1);
  });

  it('LWW: local wins when verifiedAt is newer', () => {
    const local = [makeCred({ verifiedAt: 2000 })];
    const remote = [makeCred({ verifiedAt: 1000 })];
    const { merged, toSave } = mergeCredentialLists(local, remote);
    expect(merged[0].verifiedAt).toBe(2000);
    expect(toSave).toEqual([]);
  });

  it('no-deletion: local credentials missing from remote stay', () => {
    const local = [
      makeCred({ id: 'a'.repeat(64) }),
      makeCred({ id: 'b'.repeat(64) }),
    ];
    const remote = [makeCred({ id: 'a'.repeat(64) })];
    const { merged } = mergeCredentialLists(local, remote);
    expect(merged).toHaveLength(2);
  });

  it('preserves merkleLeaves / merkleProofs when saving from remote', () => {
    const remote = [makeCred({
      id: 'c'.repeat(64),
      merkleLeaves: { dateOfBirth: '2010-05-01', name: 'Test' },
      merkleProofs: 'proof-blob',
    })];
    const { toSave } = mergeCredentialLists([], remote);
    expect(toSave[0].merkleLeaves).toEqual({ dateOfBirth: '2010-05-01', name: 'Test' });
    expect(toSave[0].merkleProofs).toBe('proof-blob');
  });

  // M11 (2026-07-02 audit): status-transition tiebreak on a verifiedAt tie.
  // verifiedAt is stamped once at initial verification and doesn't change
  // on a later status transition, so two devices can genuinely disagree on
  // status while sharing the same verifiedAt.
  describe('status-transition tiebreak on verifiedAt tie', () => {
    it('a genuinely newer confirmed status is not lost to a stale pending record on the same verifiedAt', () => {
      const local = [makeCred({ verifiedAt: 1000, verifierStatus: 'confirmed', confirmationAt: 1500 })];
      const remote = [makeCred({ verifiedAt: 1000, verifierStatus: 'pending' })];
      const { merged, toSave } = mergeCredentialLists(local, remote);
      expect(merged[0].verifierStatus).toBe('confirmed');
      expect(toSave).toEqual([]); // remote's stale pending must not overwrite
    });

    it('remote confirmed status DOES win over local stale pending on the same verifiedAt', () => {
      const local = [makeCred({ verifiedAt: 1000, verifierStatus: 'pending' })];
      const remote = [makeCred({ verifiedAt: 1000, verifierStatus: 'confirmed', confirmationAt: 1500 })];
      const { merged, toSave } = mergeCredentialLists(local, remote);
      expect(merged[0].verifierStatus).toBe('confirmed');
      expect(toSave).toHaveLength(1);
    });

    it('prefers the later confirmationAt when both sides are confirmed with the same verifiedAt', () => {
      const local = [makeCred({ verifiedAt: 1000, verifierStatus: 'confirmed', confirmationAt: 1500 })];
      const remote = [makeCred({ verifiedAt: 1000, verifierStatus: 'confirmed', confirmationAt: 2000 })];
      const { merged, toSave } = mergeCredentialLists(local, remote);
      expect(merged[0].confirmationAt).toBe(2000);
      expect(toSave).toHaveLength(1);
    });

    it('a revocation is authoritative — remote can never un-revoke a locally-revoked credential on a verifiedAt tie', () => {
      const local = [makeCred({ verifiedAt: 1000, verifierStatus: 'confirmed', revokedAt: 1200 })];
      const remote = [makeCred({ verifiedAt: 1000, verifierStatus: 'confirmed' })]; // no revokedAt — stale
      const { merged, toSave } = mergeCredentialLists(local, remote);
      expect(merged[0].revokedAt).toBe(1200);
      expect(toSave).toEqual([]);
    });

    it('a remote revocation DOES apply over a local unrevoked record on a verifiedAt tie', () => {
      const local = [makeCred({ verifiedAt: 1000, verifierStatus: 'confirmed' })];
      const remote = [makeCred({ verifiedAt: 1000, verifierStatus: 'confirmed', revokedAt: 1200 })];
      const { merged, toSave } = mergeCredentialLists(local, remote);
      expect(merged[0].revokedAt).toBe(1200);
      expect(toSave).toHaveLength(1);
    });

    it('when both sides revoked, the later revokedAt wins', () => {
      const local = [makeCred({ verifiedAt: 1000, revokedAt: 1200 })];
      const remote = [makeCred({ verifiedAt: 1000, revokedAt: 1400 })];
      const { merged, toSave } = mergeCredentialLists(local, remote);
      expect(merged[0].revokedAt).toBe(1400);
      expect(toSave).toHaveLength(1);
    });

    it('is a stable no-op (keeps local) when genuinely indistinguishable', () => {
      const local = [makeCred({ verifiedAt: 1000, verifierStatus: 'pending' })];
      const remote = [makeCred({ verifiedAt: 1000, verifierStatus: 'pending' })];
      const { toSave } = mergeCredentialLists(local, remote);
      expect(toSave).toEqual([]);
    });

    it('expired-pending ranks with pending, not below confirmed', () => {
      const local = [makeCred({ verifiedAt: 1000, verifierStatus: 'confirmed', confirmationAt: 500 })];
      const remote = [makeCred({ verifiedAt: 1000, verifierStatus: 'expired-pending' })];
      const { merged, toSave } = mergeCredentialLists(local, remote);
      expect(merged[0].verifierStatus).toBe('confirmed');
      expect(toSave).toEqual([]);
    });
  });
});

describe('parsePayload (M11 field round-trip)', () => {
  function payloadWith(cred: Record<string, unknown>): string {
    return JSON.stringify({ v: 1, credentials: [cred] });
  }

  const BASE = {
    id: 'a'.repeat(64),
    documentId: 'doc-1',
    keypairType: 'persona',
    event: '{"id":"..."}',
    verifierPubkey: 'b'.repeat(64),
    verifiedAt: 1000,
    verifierStatus: 'confirmed',
  };

  it('round-trips pendingIssuedAt, confirmationAt, expiresAt, and revokedAt', () => {
    const raw = payloadWith({
      ...BASE,
      pendingIssuedAt: 100,
      confirmationAt: 200,
      expiresAt: 300,
      revokedAt: 400,
    });
    const parsed = parsePayload(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.[0].pendingIssuedAt).toBe(100);
    expect(parsed?.[0].confirmationAt).toBe(200);
    expect(parsed?.[0].expiresAt).toBe(300);
    expect(parsed?.[0].revokedAt).toBe(400);
  });

  it('omits the four fields entirely when absent from the wire payload (no false zeros)', () => {
    const raw = payloadWith({ ...BASE });
    const parsed = parsePayload(raw);
    expect(parsed?.[0].pendingIssuedAt).toBeUndefined();
    expect(parsed?.[0].confirmationAt).toBeUndefined();
    expect(parsed?.[0].expiresAt).toBeUndefined();
    expect(parsed?.[0].revokedAt).toBeUndefined();
  });

  it('accepts expired-pending as a valid verifierStatus', () => {
    const raw = payloadWith({ ...BASE, verifierStatus: 'expired-pending' });
    const parsed = parsePayload(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0].verifierStatus).toBe('expired-pending');
  });

  it('drops a credential with a non-numeric field value rather than accepting garbage', () => {
    const raw = payloadWith({ ...BASE, revokedAt: 'not-a-number' });
    const parsed = parsePayload(raw);
    // The credential itself is still valid — just the malformed field is dropped.
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0].revokedAt).toBeUndefined();
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

describe('publishCredentialsSync — relay pool', () => {
  it('returns true when one of two relays accepts the publish', async () => {
    relayMock.publishOk = { 'wss://a.example': false, 'wss://b.example': true };
    const backend = makeSyncBackend();
    const ok = await publishCredentialsSync([makeCred()], backend, ['wss://a.example', 'wss://b.example']);
    expect(ok).toBe(true);
    expect(relayMock.published.map(p => p.url).sort()).toEqual(['wss://a.example', 'wss://b.example']);
  });

  it('never publishes an information-free record (empty payload)', async () => {
    relayMock.published = [];
    const backend = makeSyncBackend();
    const ok = await publishCredentialsSync([], backend, ['wss://a.example', 'wss://b.example']);
    expect(ok).toBe(false);
    expect(relayMock.published).toEqual([]);
  });
});

describe('fetchCredentialsSync — relay pool', () => {
  const AUTHOR = 'a'.repeat(64);

  it('dedupes events across two relays and picks the newest', async () => {
    const payload = JSON.stringify({ v: 1, credentials: [] });
    relayMock.fetchReturns = {
      'wss://a.example': [{ id: '1'.repeat(64), created_at: 1000, content: fakeNip44(payload) }],
      'wss://b.example': [{ id: '2'.repeat(64), created_at: 2000, content: fakeNip44(payload) }],
    };
    const backend = makeSyncBackend({ activePublicKeyHex: AUTHOR });
    const result = await fetchCredentialsSync(AUTHOR, backend, ['wss://a.example', 'wss://b.example']);
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
    const result = await fetchCredentialsSync(AUTHOR, backend, ['wss://a.example', 'wss://b.example']);
    expect(result).toBe('unreachable');
  });
});

it('preserves professional credentials in the recovery payload', () => {
  const credential = makeCred({ keypairType: 'professional' });
  expect(parsePayload(JSON.stringify({ v: 1, credentials: [credential] }))).toEqual([credential]);
});
