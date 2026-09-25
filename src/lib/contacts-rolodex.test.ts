import { describe, it, expect } from 'vitest';
import type { KindredEntry } from '@forgesworn/kenspeckle';
import { arrangeRolodex, sharePolicyFor } from './contacts-rolodex';

function e(displayName: string, tier: KindredEntry['tier'], pubkey = 'a'.repeat(64)): KindredEntry {
  return { pubkey, ownerPubkey: 'b'.repeat(64), tier, displayName, addedAt: 0,
    ...(tier === 'ken' ? { provenance: { source: 'manual', locator: 'x', confirmedAt: 0 } } : { sharedSecret: 's', verifiedAt: 0 }),
    ...(tier === 'kin' ? { relationship: 'other' } : {}) } as KindredEntry;
}

describe('arrangeRolodex', () => {
  it('sorts A→Z by displayName, case-insensitively', () => {
    const out = arrangeRolodex([e('zoe', 'kith', 'a'.repeat(64)), e('Amy', 'kith', 'c'.repeat(64))], {});
    expect(out.map(x => x.displayName)).toEqual(['Amy', 'zoe']);
  });
  it('filters by tier', () => {
    const out = arrangeRolodex([e('Amy', 'kith', 'a'.repeat(64)), e('Bea', 'ken', 'c'.repeat(64))], { tier: 'ken' });
    expect(out.map(x => x.displayName)).toEqual(['Bea']);
  });
  it("tier 'all' returns everything", () => {
    const out = arrangeRolodex([e('Amy', 'kith', 'a'.repeat(64)), e('Bea', 'ken', 'c'.repeat(64))], { tier: 'all' });
    expect(out).toHaveLength(2);
  });
  it('optional query filters by name substring (case-insensitive)', () => {
    const out = arrangeRolodex([e('Amy', 'kith', 'a'.repeat(64)), e('Bob', 'kith', 'c'.repeat(64))], { query: 'bo' });
    expect(out.map(x => x.displayName)).toEqual(['Bob']);
  });
});

describe('sharePolicyFor', () => {
  it('ken is one-tap shareable (public key)', () => {
    expect(sharePolicyFor({ tier: 'ken' } as KindredEntry).needsConfirm).toBe(false);
  });
  it('kith needs a confirm (you are disclosing their key)', () => {
    expect(sharePolicyFor({ tier: 'kith' } as KindredEntry).needsConfirm).toBe(true);
  });
  it('kin needs a confirm', () => {
    expect(sharePolicyFor({ tier: 'kin' } as KindredEntry).needsConfirm).toBe(true);
  });
});
