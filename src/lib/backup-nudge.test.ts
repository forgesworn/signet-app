import { describe, it, expect } from 'vitest';
import { shouldShowBackupNudge, BACKUP_NUDGE_SNOOZE_MS } from './backup-nudge';

const NOW = 1_800_000_000_000; // ms
const DAY_AGO_SECONDS = Math.floor(NOW / 1000) - 25 * 3600;
const HOUR_AGO_SECONDS = Math.floor(NOW / 1000) - 3600;

function input(o: Partial<Parameters<typeof shouldShowBackupNudge>[0]> = {}) {
  return {
    backedUp: false,
    hasMnemonic: true,
    isPairedChild: false,
    createdAtSeconds: DAY_AGO_SECONDS,
    authorizedSiteCount: 0,
    snoozedUntilMs: undefined,
    nowMs: NOW,
    ...o,
  };
}

describe('shouldShowBackupNudge', () => {
  it('shows once the identity is older than 24 hours', () => {
    expect(shouldShowBackupNudge(input())).toBe(true);
  });

  it('shows on a fresh identity once three sites have been authorized', () => {
    expect(shouldShowBackupNudge(input({ createdAtSeconds: HOUR_AGO_SECONDS, authorizedSiteCount: 3 }))).toBe(true);
  });

  it('stays quiet on a fresh identity with fewer than three sites', () => {
    expect(shouldShowBackupNudge(input({ createdAtSeconds: HOUR_AGO_SECONDS, authorizedSiteCount: 2 }))).toBe(false);
  });

  it('never shows once the words are written down', () => {
    expect(shouldShowBackupNudge(input({ backedUp: true }))).toBe(false);
  });

  it('never shows when there is nothing to back up (nsec import)', () => {
    expect(shouldShowBackupNudge(input({ hasMnemonic: false }))).toBe(false);
  });

  it('never shows on a paired child', () => {
    expect(shouldShowBackupNudge(input({ isPairedChild: true }))).toBe(false);
  });

  it('respects an unexpired snooze', () => {
    expect(shouldShowBackupNudge(input({ snoozedUntilMs: NOW + 1000 }))).toBe(false);
  });

  it('returns once the snooze expires', () => {
    expect(shouldShowBackupNudge(input({ snoozedUntilMs: NOW - 1 }))).toBe(true);
  });

  it('snoozes for seven days', () => {
    expect(BACKUP_NUDGE_SNOOZE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
