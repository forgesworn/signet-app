import { describe, it, expect } from 'vitest';
import { searchEntries, toWire, parseEntry } from '@forgesworn/kenspeckle';
import { pinKen, buildKeyControlChallenge } from '@forgesworn/kenspeckle/ken';
import { buildMembershipFilter } from '@forgesworn/tessera-kit';

describe('kindred + tessera-kit resolve and import', () => {
  it('exposes the functions the integration relies on', () => {
    expect(typeof searchEntries).toBe('function');
    expect(typeof toWire).toBe('function');
    expect(typeof parseEntry).toBe('function');
    expect(typeof pinKen).toBe('function');
    expect(typeof buildKeyControlChallenge).toBe('function');
    expect(typeof buildMembershipFilter).toBe('function');
  });
});
