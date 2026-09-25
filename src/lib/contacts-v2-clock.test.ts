import { describe, it, expect } from 'vitest';
import { nextClock, frontierOf, mergeOps } from './contacts-v2-clock';
import type { ContactOperation } from '../types';

function op(overrides: Partial<ContactOperation> & { operationId: string }): ContactOperation {
  return {
    directoryId: 'owner',
    contactId: '0'.repeat(32),
    actorPubkey: 'a'.repeat(64),
    actorRole: 'owner',
    actorDeviceId: 'd'.repeat(32),
    logicalClock: 1,
    action: 'rename',
    value: { displayName: 'Dave' },
    createdAt: 1_000,
    ...overrides,
  };
}

describe('nextClock', () => {
  it('advances past the larger of local and observed', () => {
    expect(nextClock(1, 1)).toBe(2);
    expect(nextClock(1, 9)).toBe(10);
    expect(nextClock(9, 1)).toBe(10);
  });

  it('treats absent, negative and non-finite inputs as zero', () => {
    expect(nextClock(0, 0)).toBe(1);
    expect(nextClock(-5, 0)).toBe(1);
    expect(nextClock(Number.NaN, 3)).toBe(4);
    expect(nextClock(2, Number.POSITIVE_INFINITY)).toBe(3);
  });
});

describe('frontierOf', () => {
  it('reports the max clock and every operation id', () => {
    const f = frontierOf([
      op({ operationId: '1'.repeat(32), logicalClock: 4 }),
      op({ operationId: '2'.repeat(32), logicalClock: 7 }),
    ]);
    expect(f.maxClock).toBe(7);
    expect(f.opIds.has('1'.repeat(32))).toBe(true);
    expect(f.opIds.has('2'.repeat(32))).toBe(true);
    expect(f.opIds.size).toBe(2);
  });

  it('returns a zero frontier for an empty log', () => {
    const f = frontierOf([]);
    expect(f.maxClock).toBe(0);
    expect(f.opIds.size).toBe(0);
  });
});

describe('mergeOps — two devices that never observed each other', () => {
  it('unions by operationId and reports one frontier', () => {
    // Device A and device B both started at 0 and both wrote their first
    // operation at clock 1. Neither has ever seen the other's counter.
    const a = op({ operationId: 'a'.repeat(32), actorPubkey: '1'.repeat(64), logicalClock: 1 });
    const b = op({ operationId: 'b'.repeat(32), actorPubkey: '2'.repeat(64), logicalClock: 1 });
    const { ops, frontier } = mergeOps([a], [b]);
    expect(ops).toHaveLength(2);
    expect(frontier.maxClock).toBe(1);
    // Whoever merges next writes at 2 — strictly after BOTH concurrent ops.
    expect(nextClock(1, frontier.maxClock)).toBe(2);
  });

  it('keeps the local copy of a duplicated operationId', () => {
    const local = op({ operationId: 'c'.repeat(32), value: { displayName: 'Local' } });
    const remote = op({ operationId: 'c'.repeat(32), value: { displayName: 'Remote' } });
    const { ops } = mergeOps([local], [remote]);
    expect(ops).toHaveLength(1);
    expect(ops[0].value).toEqual({ displayName: 'Local' });
  });

  it('carries the higher remote clock into the frontier', () => {
    const { frontier } = mergeOps(
      [op({ operationId: 'd'.repeat(32), logicalClock: 2 })],
      [op({ operationId: 'e'.repeat(32), logicalClock: 11 })],
    );
    expect(frontier.maxClock).toBe(11);
    expect(nextClock(2, frontier.maxClock)).toBe(12);
  });
});
