// Tests for badge-fetch.ts
// Relay network calls are not unit-testable without a live relay; this suite
// covers all input-validation paths and the entity-type extraction logic that
// runs on mocked relay responses.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// Use vi.hoisted so these references are available inside the vi.mock factory,
// which is hoisted to the top of the compiled module by Vitest.
const {
  mockComputeBadge,
  mockBuildBadgeFilters,
  mockComputeTrustScore,
} = vi.hoisted(() => ({
  mockComputeBadge: vi.fn(),
  mockBuildBadgeFilters: vi.fn(),
  mockComputeTrustScore: vi.fn().mockReturnValue({ score: 0, signals: [] }),
}));

vi.mock('signet-protocol', () => {
  return {
    computeBadge: mockComputeBadge,
    buildBadgeFilters: mockBuildBadgeFilters,
    computeTrustScore: mockComputeTrustScore,
    ATTESTATION_KIND: 31000,
    ATTESTATION_TYPES: { CREDENTIAL: 'credential', VOUCH: 'vouch', IDENTITY_BRIDGE: 'identity-bridge' },
  };
});

vi.mock('./relay-service', () => ({
  fetchEvents: vi.fn(),
}));
import { fetchEvents } from './relay-service';
const mockFetch = vi.mocked(fetchEvents);

import { fetchBadge, fetchBadges } from './badge-fetch';

const VALID_PUBKEY = 'a'.repeat(64);
const VALID_RELAY = 'wss://relay.example.com';

const DEFAULT_BADGE = {
  tier: 1 as const,
  tierLabel: 'Unverified',
  score: 0,
  isVerified: false,
  credentialCount: 0,
  vouchCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue([]);
  mockComputeBadge.mockResolvedValue(DEFAULT_BADGE);
  mockBuildBadgeFilters.mockReturnValue([{}]);
});

// -------------------------------------------------------------------------
describe('fetchBadge — relay URL validation', () => {
  it('returns null for http:// URL (non-localhost)', async () => {
    const result = await fetchBadge(VALID_PUBKEY, 'http://relay.example.com');
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null for ftp:// URL', async () => {
    const result = await fetchBadge(VALID_PUBKEY, 'ftp://relay.example.com');
    expect(result).toBeNull();
  });

  it('accepts wss:// relay URL', async () => {
    const result = await fetchBadge(VALID_PUBKEY, VALID_RELAY);
    expect(result).not.toBeNull();
  });

  it('accepts ws://localhost relay URL', async () => {
    const result = await fetchBadge(VALID_PUBKEY, 'ws://localhost:4869');
    expect(result).not.toBeNull();
  });

  it('accepts ws://127.0.0.1 relay URL', async () => {
    const result = await fetchBadge(VALID_PUBKEY, 'ws://127.0.0.1:4869');
    expect(result).not.toBeNull();
  });

  it('rejects ws://evil.com (non-local ws)', async () => {
    const result = await fetchBadge(VALID_PUBKEY, 'ws://evil.com');
    expect(result).toBeNull();
  });
});

describe('fetchBadge — pubkey validation', () => {
  it('returns null for pubkey shorter than 64 chars', async () => {
    const result = await fetchBadge('abc', VALID_RELAY);
    expect(result).toBeNull();
  });

  it('returns null for pubkey longer than 64 chars', async () => {
    const result = await fetchBadge('a'.repeat(65), VALID_RELAY);
    expect(result).toBeNull();
  });

  it('returns null for pubkey with non-hex characters', async () => {
    const result = await fetchBadge('z'.repeat(64), VALID_RELAY);
    expect(result).toBeNull();
  });

  it('accepts lowercase hex pubkey', async () => {
    const result = await fetchBadge('a'.repeat(64), VALID_RELAY);
    expect(result).not.toBeNull();
  });

  it('accepts uppercase hex pubkey', async () => {
    const result = await fetchBadge('A'.repeat(64), VALID_RELAY);
    expect(result).not.toBeNull();
  });
});

describe('fetchBadge — relay errors', () => {
  it('returns null when fetchEvents throws', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));
    const result = await fetchBadge(VALID_PUBKEY, VALID_RELAY);
    expect(result).toBeNull();
  });

  it('returns null when fetchEvents rejects with a timeout', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));
    const result = await fetchBadge(VALID_PUBKEY, VALID_RELAY);
    expect(result).toBeNull();
  });

  it('returns null when fetchEvents throws a subscription error', async () => {
    mockFetch.mockRejectedValue(new Error('Subscription error'));
    const result = await fetchBadge(VALID_PUBKEY, VALID_RELAY);
    expect(result).toBeNull();
  });
});

describe('fetchBadge — relay scoping', () => {
  it('scopes fetchEvents to the validated relayUrl, not the whole pool', async () => {
    await fetchBadge(VALID_PUBKEY, VALID_RELAY);
    expect(mockFetch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ relays: [VALID_RELAY] }));
  });
});

describe('fetchBadge — happy path', () => {
  it('returns a CachedBadge with correct shape', async () => {
    mockComputeBadge.mockResolvedValue({
      tier: 3,
      tierLabel: 'Verified',
      score: 42,
      isVerified: true,
      credentialCount: 2,
      vouchCount: 5,
    });

    const result = await fetchBadge(VALID_PUBKEY, VALID_RELAY);
    expect(result).toMatchObject({
      tier: 3,
      tierLabel: 'Verified',
      score: 42,
      isVerified: true,
      credentialCount: 2,
      vouchCount: 5,
    });
    expect(typeof result!.fetchedAt).toBe('number');
  });

  it('sets fetchedAt close to current unix time', async () => {
    const before = Math.floor(Date.now() / 1000) - 2;
    const result = await fetchBadge(VALID_PUBKEY, VALID_RELAY);
    const after = Math.floor(Date.now() / 1000) + 2;
    expect(result!.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(result!.fetchedAt).toBeLessThanOrEqual(after);
  });
});

describe('fetchBadge — entity type extraction', () => {
  function makeCredEvent(pubkey: string, entityType: string) {
    return {
      kind: 30470,
      tags: [
        ['d', pubkey],
        ['entity-type', entityType],
      ],
    };
  }

  it('passes through natural-person entity type from computeBadge', async () => {
    mockComputeBadge.mockResolvedValue({ ...DEFAULT_BADGE, entityType: 'natural-person' });
    mockFetch.mockResolvedValue([makeCredEvent(VALID_PUBKEY, 'natural-person')] as never);
    const result = await fetchBadge(VALID_PUBKEY, VALID_RELAY);
    expect(result!.entityType).toBe('natural-person');
  });

  it('passes through organization entity type from computeBadge', async () => {
    mockComputeBadge.mockResolvedValue({ ...DEFAULT_BADGE, entityType: 'organization' });
    mockFetch.mockResolvedValue([makeCredEvent(VALID_PUBKEY, 'organization')] as never);
    const result = await fetchBadge(VALID_PUBKEY, VALID_RELAY);
    expect(result!.entityType).toBe('organization');
  });

  it('passes through ai-agent entity type from computeBadge', async () => {
    mockComputeBadge.mockResolvedValue({ ...DEFAULT_BADGE, entityType: 'ai-agent' });
    mockFetch.mockResolvedValue([makeCredEvent(VALID_PUBKEY, 'ai-agent')] as never);
    const result = await fetchBadge(VALID_PUBKEY, VALID_RELAY);
    expect(result!.entityType).toBe('ai-agent');
  });

  it('returns undefined entityType when computeBadge has none', async () => {
    mockComputeBadge.mockResolvedValue({ ...DEFAULT_BADGE, entityType: undefined });
    mockFetch.mockResolvedValue([makeCredEvent(VALID_PUBKEY, 'robot')] as never);
    const result = await fetchBadge(VALID_PUBKEY, VALID_RELAY);
    expect(result!.entityType).toBeUndefined();
  });

  it('returns undefined entityType for mismatched events', async () => {
    mockComputeBadge.mockResolvedValue({ ...DEFAULT_BADGE, entityType: undefined });
    mockFetch.mockResolvedValue([makeCredEvent('b'.repeat(64), 'natural-person')] as never);
    const result = await fetchBadge(VALID_PUBKEY, VALID_RELAY);
    expect(result!.entityType).toBeUndefined();
  });

  it('returns undefined entityType for non-credential events', async () => {
    mockComputeBadge.mockResolvedValue({ ...DEFAULT_BADGE, entityType: undefined });
    mockFetch.mockResolvedValue([{
      kind: 1,
      tags: [['entity-type', 'natural-person']],
    }] as never);
    const result = await fetchBadge(VALID_PUBKEY, VALID_RELAY);
    expect(result!.entityType).toBeUndefined();
  });
});

// -------------------------------------------------------------------------
describe('fetchBadges — relay URL validation', () => {
  it('returns empty map for invalid relay URL', async () => {
    const result = await fetchBadges([VALID_PUBKEY], 'http://relay.example.com');
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty map when all pubkeys are invalid', async () => {
    const result = await fetchBadges(['not-a-pubkey', 'z'.repeat(64)], VALID_RELAY);
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty map for empty pubkey array', async () => {
    const result = await fetchBadges([], VALID_RELAY);
    expect(result.size).toBe(0);
  });
});

describe('fetchBadges — valid pubkeys', () => {
  it('filters out invalid pubkeys and only queries valid ones', async () => {
    const validB = 'b'.repeat(64);
    await fetchBadges([VALID_PUBKEY, 'bad', validB], VALID_RELAY);
    expect(mockBuildBadgeFilters as Mock).toHaveBeenCalledWith([VALID_PUBKEY, validB]);
  });

  it('returns a badge entry per valid pubkey', async () => {
    const validB = 'b'.repeat(64);
    const result = await fetchBadges([VALID_PUBKEY, validB], VALID_RELAY);
    expect(result.has(VALID_PUBKEY)).toBe(true);
    expect(result.has(validB)).toBe(true);
    expect(result.size).toBe(2);
  });

  it('returns empty map when fetchEvents throws', async () => {
    mockFetch.mockRejectedValue(new Error('down'));
    const result = await fetchBadges([VALID_PUBKEY], VALID_RELAY);
    expect(result.size).toBe(0);
  });

  it('scopes fetchEvents to the validated relayUrl, not the whole pool', async () => {
    await fetchBadges([VALID_PUBKEY], VALID_RELAY);
    expect(mockFetch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ relays: [VALID_RELAY] }));
  });
});
