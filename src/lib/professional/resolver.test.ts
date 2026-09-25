import { describe, it, expect, vi } from 'vitest';
import { createResolverDispatcher } from './resolver';
import type { ProfessionResolver, RegulatedEntityRecord } from './types';

function mockResolver(overrides: Partial<ProfessionResolver> = {}): ProfessionResolver {
  return {
    professionKind: 'school',
    jurisdictions: ['england-wales'],
    matches: (id: string) => /^\d{6}$/.test(id),
    resolve: vi.fn().mockResolvedValue({
      identifier: '100000',
      name: 'Springfield School',
      status: 'Active',
      professionKind: 'school',
      jurisdiction: 'england-wales',
      registry: 'GIAS',
      identifierKind: 'URN',
      website: 'springfield-school.example',
      inferredCandidateWebsite: null,
      postcode: 'ZZ1 1ZZ',
      locality: 'Springfield',
      tags: [],
      fetchedAt: new Date().toISOString(),
    } as RegulatedEntityRecord),
    ...overrides,
  };
}

describe('createResolverDispatcher', () => {
  it('returns null when no resolver is registered for the given professionKind', async () => {
    const dispatcher = createResolverDispatcher([]);
    const result = await dispatcher.resolve('school', '100000');
    expect(result).toBeNull();
  });

  it('calls the matching resolver and returns its record', async () => {
    const resolver = mockResolver();
    const dispatcher = createResolverDispatcher([resolver]);
    const result = await dispatcher.resolve('school', '100000');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Springfield School');
    expect(resolver.resolve).toHaveBeenCalledWith('100000');
  });

  it('returns null when the resolver returns null (not-found)', async () => {
    const resolver = mockResolver({
      resolve: vi.fn().mockResolvedValue(null),
    });
    const dispatcher = createResolverDispatcher([resolver]);
    const result = await dispatcher.resolve('school', '999999');
    expect(result).toBeNull();
  });

  it('throws when the resolver throws (transient failure)', async () => {
    const resolver = mockResolver({
      resolve: vi.fn().mockRejectedValue(new Error('Network error')),
    });
    const dispatcher = createResolverDispatcher([resolver]);
    // Use a different identifier to avoid hitting the fake-indexeddb cache
    // populated by earlier tests in this file.
    await expect(dispatcher.resolve('school', '000001')).rejects.toThrow('Network error');
  });

  it('dispatches to the right resolver among multiple registered resolvers', async () => {
    const schoolResolver = mockResolver({ professionKind: 'school', resolve: vi.fn().mockResolvedValue({ name: 'School', professionKind: 'school' } as RegulatedEntityRecord) });
    const gpResolver = mockResolver({ professionKind: 'gp-practice', matches: (id: string) => /^[A-Z]{3}\d{2}$/.test(id), resolve: vi.fn().mockResolvedValue({ name: 'Practice', professionKind: 'gp-practice' } as RegulatedEntityRecord) });
    const dispatcher = createResolverDispatcher([schoolResolver, gpResolver]);
    const result = await dispatcher.resolve('gp-practice', 'RXL01');
    expect(result!.name).toBe('Practice');
    expect(schoolResolver.resolve).not.toHaveBeenCalled();
  });
});
