import { describe, it, expect } from 'vitest';
import {
  shouldShowBackupNudge, BACKUP_NUDGE_SNOOZE_MS, BACKUP_NUDGE_FAMILY_SNOOZE_MS,
  backupNudgeSnoozeMs, backupNudgeCopy,
} from './backup-nudge';

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
    dependantCount: 0,
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

  it('shows on a fresh identity with no sites once a dependant is held', () => {
    expect(shouldShowBackupNudge(input({ createdAtSeconds: HOUR_AGO_SECONDS, authorizedSiteCount: 0, dependantCount: 1 }))).toBe(true);
  });

  it('still stays quiet with a dependant once backed up', () => {
    expect(shouldShowBackupNudge(input({ dependantCount: 1, backedUp: true }))).toBe(false);
  });

  it('still stays quiet with a dependant when there is no mnemonic', () => {
    expect(shouldShowBackupNudge(input({ dependantCount: 1, hasMnemonic: false }))).toBe(false);
  });

  it('still stays quiet with a dependant on a paired child', () => {
    expect(shouldShowBackupNudge(input({ dependantCount: 1, isPairedChild: true }))).toBe(false);
  });

  it('still respects an unexpired snooze with a dependant', () => {
    expect(shouldShowBackupNudge(input({ dependantCount: 1, snoozedUntilMs: NOW + 1000 }))).toBe(false);
  });
});

describe('backupNudgeSnoozeMs', () => {
  it('is seven days with no dependants', () => {
    expect(backupNudgeSnoozeMs(0)).toBe(BACKUP_NUDGE_SNOOZE_MS);
    expect(backupNudgeSnoozeMs(0)).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('is 48 hours once a dependant is held', () => {
    expect(backupNudgeSnoozeMs(2)).toBe(BACKUP_NUDGE_FAMILY_SNOOZE_MS);
    expect(backupNudgeSnoozeMs(2)).toBe(48 * 60 * 60 * 1000);
  });
});

describe('backupNudgeCopy', () => {
  it('has generic copy for zero dependants', () => {
    expect(backupNudgeCopy([])).toEqual({
      title: 'Write down your recovery words',
      body: "They're the only way back in on a new phone.",
    });
  });

  it('names the one dependant held', () => {
    expect(backupNudgeCopy(['Lily'])).toEqual({
      title: 'Write down your recovery words',
      body: "They're the only way back in — for you and for Lily.",
    });
  });

  it('falls back to "your dependant" for an empty/blank name', () => {
    expect(backupNudgeCopy(['  '])).toEqual({
      title: 'Write down your recovery words',
      body: "They're the only way back in — for you and for your dependant.",
    });
  });

  it('counts multiple dependants rather than naming them', () => {
    expect(backupNudgeCopy(['Lily', 'Sam', 'Max'])).toEqual({
      title: 'Write down your recovery words',
      body: "They're the only way back in — for you and for the 3 people whose keys you hold.",
    });
  });
});
