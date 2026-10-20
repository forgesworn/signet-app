import { describe, expect, it } from 'vitest';
import { keepPreviewEnabled, keepPreviewKeeps } from './keep-preview';
import { presenceOf } from './keep';

describe('keepPreviewEnabled', () => {
  it('is off outside a dev build, even with the flag', () => {
    expect(keepPreviewEnabled(false, '?keep-preview')).toBe(false);
  });
  it('is off in a dev build without the flag', () => {
    expect(keepPreviewEnabled(true, '')).toBe(false);
    expect(keepPreviewEnabled(true, '?other=1')).toBe(false);
  });
  it('is on in a dev build with the flag', () => {
    expect(keepPreviewEnabled(true, '?keep-preview')).toBe(true);
    expect(keepPreviewEnabled(true, '?a=1&keep-preview')).toBe(true);
  });
});

describe('keepPreviewKeeps', () => {
  it('gives an online Keep and one last heard from about three days ago, owned by the identity', () => {
    const now = 1_800_000_000;
    const [a, b] = keepPreviewKeeps('ee'.repeat(32), now);
    expect(a.claim.author).toBe('ee'.repeat(32));
    expect(b.claim.author).toBe('ee'.repeat(32));
    expect(presenceOf(a.status, now).state).toBe('online');
    expect(presenceOf(b.status, now)).toEqual({ state: 'last-seen', ageSeconds: 3 * 86400 });
    for (const k of [a, b]) {
      expect(k.status?.freeBytes).toBeGreaterThan(0);
      expect(k.status?.software).toMatch(/\//);
    }
  });
});
