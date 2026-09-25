import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../db', () => ({
  getProRegistryRecord: vi.fn(),
  setProRegistryRecord: vi.fn(),
  getProSignetJson: vi.fn(),
  setProSignetJson: vi.fn(),
  invalidateProRegistryRecord: vi.fn(),
  invalidateProSignetJson: vi.fn(),
}));

vi.mock('./resolver', () => ({ resolveIdentifier: vi.fn() }));
vi.mock('./signet-json', async (orig) => {
  const original = await orig<typeof import('./signet-json')>();
  return { ...original, fetchProSignetJson: vi.fn() };
});
vi.mock('signet-protocol', async (orig) => ({
  ...(await orig<typeof import('signet-protocol')>()),
  verifyEvent: vi.fn().mockResolvedValue(true),
}));

import {
  getProRegistryRecord,
  getProSignetJson,
  invalidateProRegistryRecord,
  invalidateProSignetJson,
  setProRegistryRecord,
} from '../db';
import { resolveIdentifier } from './resolver';
import { fetchProSignetJson } from './signet-json';
import { verifyProChain } from './verify-chain';

const TTL_MS = 24 * 60 * 60 * 1000;
const staleAt = Date.now() - TTL_MS - 5000;

const freshRecord = {
  professionKind: 'gp-practice' as const,
  jurisdiction: 'england' as const,
  registry: 'CQC' as const,
  identifier: 'RXL',
  identifierKind: 'CQC-ProviderID',
  name: 'Springfield Practice',
  status: 'Active',
  website: 'different-domain-now.co.uk',  // domain changed
  inferredCandidateWebsite: null,
  postcode: 'SP1 1AA',
  locality: 'Springfield',
  tags: [],
  fetchedAt: new Date().toISOString(),
};

const cachedJson = {
  schemaVersion: 1,
  kind: 'gp-practice',
  name: 'Springfield Practice',
  identifier: { kind: 'CQC-ProviderID', value: 'RXL' },
  jurisdiction: 'england',
  leadPubkey: 'aa'.repeat(32),
  relays: [],
  entities: null,
  _fetchedFromHost: 'springfield.gp.nhs.uk',  // original host — now mismatched
  fetchedAt: new Date(staleAt).toISOString(),
};

const fakeCred = {
  id: 'aa'.repeat(32),
  pubkey: 'bb'.repeat(32),
  kind: 29999,
  content: '',
  tags: [['identifier', 'RXL'], ['profession', 'gp-practice'], ['jurisdiction', 'england']],
  created_at: Math.floor(Date.now() / 1000),
  sig: 'cc'.repeat(64),
} as never;

const rosterEvent = {
  id: 'dd'.repeat(32),
  pubkey: 'aa'.repeat(32),
  created_at: Math.floor(Date.now() / 1000) - 60,
  kind: 30202,
  tags: [['p', 'bb'.repeat(32), 'gp']],
  content: '',
  sig: 'ee'.repeat(64),
} as never;

beforeEach(() => vi.clearAllMocks());

describe('verifyProChain — stale cache paths', () => {
  it('re-fetches registry when cached record is stale, and fails closed on domain change', async () => {
    // Cache miss (stale) → resolver returns freshRecord with changed domain.
    (getProRegistryRecord as Mock).mockResolvedValue({
      record: { ...freshRecord, website: 'springfield.gp.nhs.uk' },
      cachedAt: staleAt,
    });
    (resolveIdentifier as Mock).mockResolvedValue(freshRecord);
    // setProRegistryRecord is called after resolver returns the fresh record.
    (setProRegistryRecord as Mock).mockResolvedValue(undefined);
    // Cached signet.json is warm (recent cachedAt) but points to old host.
    (getProSignetJson as Mock).mockResolvedValue({ json: cachedJson, cachedAt: Date.now() });

    const result = await verifyProChain(fakeCred, rosterEvent, 'gp-practice', 'england');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('domain-mismatch');
    expect(invalidateProRegistryRecord).toHaveBeenCalledWith('RXL', 'gp-practice');
    expect(invalidateProSignetJson).toHaveBeenCalled();
  });

  it('re-fetches signet.json when cache is stale and fails closed on domain change', async () => {
    // Registry cache is warm with the changed domain.
    (getProRegistryRecord as Mock).mockResolvedValue({
      record: freshRecord,
      cachedAt: Date.now(),
    });
    // signet.json cache is stale → fetchProSignetJson returns json with old host.
    (getProSignetJson as Mock).mockResolvedValue({ json: cachedJson, cachedAt: staleAt });
    (fetchProSignetJson as Mock).mockResolvedValue({
      ...cachedJson,
      _fetchedFromHost: 'springfield.gp.nhs.uk',
      fetchedAt: new Date().toISOString(),
    });

    const result = await verifyProChain(fakeCred, rosterEvent, 'gp-practice', 'england');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('domain-mismatch');
    expect(invalidateProRegistryRecord).toHaveBeenCalled();
    expect(invalidateProSignetJson).toHaveBeenCalled();
  });
});
