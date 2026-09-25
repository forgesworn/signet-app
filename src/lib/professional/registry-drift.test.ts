import { describe, it, expect } from 'vitest';
import { detectRegistryDrift } from './verify-chain';
import type { RegulatedEntityRecord } from './types';

function baseRecord(): RegulatedEntityRecord {
  return {
    professionKind: 'school',
    jurisdiction: 'england-wales',
    registry: 'GIAS',
    identifier: '100000',
    identifierKind: 'URN',
    name: 'Springfield School',
    status: 'Active',
    website: 'https://www.springfield-school.example',
    inferredCandidateWebsite: null,
    postcode: 'ZZ1 1ZZ',
    locality: 'Springfield',
    tags: [],
    fetchedAt: '2026-04-01T00:00:00Z',
  };
}

describe('detectRegistryDrift', () => {
  it('returns { drifted: false } when records match', () => {
    const live = baseRecord();
    const cached = baseRecord();
    expect(detectRegistryDrift(live, cached)).toEqual({ drifted: false });
  });

  it('returns { drifted: true, reason } when name changes', () => {
    const live = { ...baseRecord(), name: 'Springfield Academy' };
    const cached = baseRecord();
    const result = detectRegistryDrift(live, cached);
    expect(result.drifted).toBe(true);
    if (result.drifted) expect(result.reason).toMatch(/name/i);
  });

  it('returns { drifted: true, reason } when website changes', () => {
    const live = { ...baseRecord(), website: 'https://www.newdomain.co.uk' };
    const cached = baseRecord();
    const result = detectRegistryDrift(live, cached);
    expect(result.drifted).toBe(true);
    if (result.drifted) expect(result.reason).toMatch(/website/i);
  });

  it('returns { drifted: true, reason } when status changes to Inactive', () => {
    const live = { ...baseRecord(), status: 'Closed' };
    const cached = baseRecord();
    const result = detectRegistryDrift(live, cached);
    expect(result.drifted).toBe(true);
    if (result.drifted) expect(result.reason).toMatch(/status/i);
  });

  it('returns { drifted: false } when live has bare hostname and cached has https:// prefix', () => {
    // Resolvers return bare hostnames (e.g. springfield-school.example).
    // ProDashboard builds the cached record with `https://` prefix.
    // Both should compare equal after normalisation.
    const live = { ...baseRecord(), website: 'springfield-school.example' };
    const cached = { ...baseRecord(), website: 'https://springfield-school.example' };
    expect(detectRegistryDrift(live, cached)).toEqual({ drifted: false });
  });

  it('returns { drifted: false } when live has https://www. and cached has bare hostname', () => {
    const live = { ...baseRecord(), website: 'https://www.springfield-school.example' };
    const cached = { ...baseRecord(), website: 'springfield-school.example' };
    expect(detectRegistryDrift(live, cached)).toEqual({ drifted: false });
  });
});
