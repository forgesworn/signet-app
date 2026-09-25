import { describe, it, expect } from 'vitest';
import type { KenEntry } from '@forgesworn/kenspeckle';
import { mergeKenLists } from './ken-sync';

function makeKen(o: Partial<KenEntry> = {}): KenEntry {
  return {
    pubkey: 'a'.repeat(64), ownerPubkey: 'b'.repeat(64), tier: 'ken',
    displayName: 'Pub', addedAt: 1000,
    provenance: { source: 'manual', locator: 'x', confirmedAt: 1000 },
    ...o,
  } as KenEntry;
}

describe('mergeKenLists', () => {
  it('adds remote-only kens and flags them for save', () => {
    const { merged, toSave } = mergeKenLists([], [makeKen({ pubkey: 'c'.repeat(64) })]);
    expect(merged).toHaveLength(1);
    expect(toSave).toHaveLength(1);
  });
  it('LWW: newer lastResolvedAt wins over addedAt', () => {
    const local = [makeKen({ pubkey: 'a'.repeat(64), displayName: 'Old', addedAt: 1000 })];
    const remote = [makeKen({ pubkey: 'a'.repeat(64), displayName: 'New', addedAt: 1000, lastResolvedAt: 2000 })];
    const { merged, toSave } = mergeKenLists(local, remote);
    expect(merged[0].displayName).toBe('New');
    expect(toSave).toHaveLength(1);
  });
  it('a revoke (later lastResolvedAt) wins', () => {
    const local = [makeKen({ pubkey: 'a'.repeat(64), addedAt: 1000, lastResolvedAt: 1000 })];
    const remote = [makeKen({ pubkey: 'a'.repeat(64), addedAt: 1000, lastResolvedAt: 3000, revoked: true })];
    const { merged } = mergeKenLists(local, remote);
    expect(merged[0].revoked).toBe(true);
  });
  it('keeps local kens missing from remote (no-deletion policy)', () => {
    const local = [makeKen({ pubkey: 'a'.repeat(64) }), makeKen({ pubkey: 'b'.repeat(64) })];
    const { merged } = mergeKenLists(local, [makeKen({ pubkey: 'b'.repeat(64) })]);
    expect(merged).toHaveLength(2);
  });
});
