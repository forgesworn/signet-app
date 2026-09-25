import { describe, it, expect, vi } from 'vitest';
import { resolveLegacyGuestKey, nextLegacyMigrationState, isLegacyUnprotectedInstall } from './legacy-guest';

describe('resolveLegacyGuestKey', () => {
  it('uses the key already in memory without prompting', async () => {
    const authenticateGrace = vi.fn();
    await expect(resolveLegacyGuestKey('a'.repeat(64), 'grace', authenticateGrace)).resolves.toBe('a'.repeat(64));
    expect(authenticateGrace).not.toHaveBeenCalled();
  });

  it('recovers the key from the stored grace handle when memory is empty', async () => {
    const authenticateGrace = vi.fn().mockResolvedValue('b'.repeat(64));
    await expect(resolveLegacyGuestKey(null, 'grace', authenticateGrace)).resolves.toBe('b'.repeat(64));
  });

  it('throws rather than resolving null when the handle cannot be read', async () => {
    const authenticateGrace = vi.fn().mockResolvedValue(null);
    await expect(resolveLegacyGuestKey(null, 'grace', authenticateGrace)).rejects.toThrow(/could not/i);
  });

  it('throws for a non-grace auth method with no key in memory', async () => {
    const authenticateGrace = vi.fn();
    await expect(resolveLegacyGuestKey(null, 'pin', authenticateGrace)).rejects.toThrow(/could not/i);
    expect(authenticateGrace).not.toHaveBeenCalled();
  });
});

describe('nextLegacyMigrationState', () => {
  it('raises the notice on the first probe that finds a legacy row', () => {
    expect(nextLegacyMigrationState(null, true)).toBe('notice');
  });

  it('stays out of the way when there is no legacy row', () => {
    expect(nextLegacyMigrationState(null, false)).toBe(null);
  });

  it('never knocks an in-progress setup back to the notice', () => {
    expect(nextLegacyMigrationState('setup', true)).toBe('setup');
  });

  it('leaves an already-raised notice alone', () => {
    expect(nextLegacyMigrationState('notice', true)).toBe('notice');
  });
});

describe('isLegacyUnprotectedInstall', () => {
  it('treats a stored grace method as legacy on its own — no marker row needed', () => {
    expect(isLegacyUnprotectedInstall('grace')).toBe(true);
  });

  it('is not legacy for an install that can actually unlock', () => {
    expect(isLegacyUnprotectedInstall('pin')).toBe(false);
    expect(isLegacyUnprotectedInstall('biometric')).toBe(false);
    expect(isLegacyUnprotectedInstall(null)).toBe(false);
  });
});
