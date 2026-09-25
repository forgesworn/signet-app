import { describe, it, expect } from 'vitest';
import { missingBackupRailsFor } from './sync-banner';
import { CONTACTS_BACKUP_TOO_LARGE_COPY, CONTACTS_BACKUP_STALLED_COPY } from './contacts-v2-copy';
import type { SyncRemoteState } from './sync-seen';

const NONE: SyncRemoteState | null = null;
const GONE: SyncRemoteState = 'missing-after-seen';

const base = {
  personas: NONE, dependants: NONE, contacts: NONE, contactsV2: NONE,
  credentials: NONE, grants: NONE,
  extraPersonaCount: 0, dependantCount: 0, grantCount: 0, isPairedChild: false,
};

describe('missingBackupRailsFor', () => {
  it('is empty when every rail is fine', () => {
    expect(missingBackupRailsFor(base)).toEqual([]);
  });

  it('names the contact rail once when EITHER contacts rail is missing', () => {
    expect(missingBackupRailsFor({ ...base, contacts: GONE })).toEqual(['contact']);
    expect(missingBackupRailsFor({ ...base, contactsV2: GONE })).toEqual(['contact']);
    expect(missingBackupRailsFor({ ...base, contacts: GONE, contactsV2: GONE })).toEqual(['contact']);
  });

  it('never names contacts on a paired-child install (R8)', () => {
    // The kid's own directory is not backed up this phase, and the owner rail
    // being empty there is normal rather than a lost backup.
    expect(missingBackupRailsFor({ ...base, contactsV2: GONE, isPairedChild: true })).toEqual([]);
  });

  it('gates personas, dependants and grants on there being something to lose', () => {
    expect(missingBackupRailsFor({ ...base, personas: GONE })).toEqual([]);
    expect(missingBackupRailsFor({ ...base, personas: GONE, extraPersonaCount: 1 })).toEqual(['persona']);
    expect(missingBackupRailsFor({ ...base, dependants: GONE, dependantCount: 2 })).toEqual(['dependant']);
    expect(missingBackupRailsFor({ ...base, grants: GONE, grantCount: 1 })).toEqual(['grant']);
  });

  it('keeps the rails in a stable, readable order', () => {
    expect(missingBackupRailsFor({
      ...base, personas: GONE, extraPersonaCount: 1, dependants: GONE, dependantCount: 1,
      contactsV2: GONE, credentials: GONE, grants: GONE, grantCount: 1,
    })).toEqual(['persona', 'dependant', 'contact', 'credential', 'grant']);
  });

  it('never fires on unreachable or never-seen', () => {
    expect(missingBackupRailsFor({ ...base, contactsV2: 'unreachable', credentials: 'never-seen' })).toEqual([]);
  });

  it('never fires on a checkpoint that exists but could not be read (R9)', () => {
    // `useContactsV2Sync` maps `'unusable'` to `'present'`, so this rail can
    // never arrive here as `'missing-after-seen'` for a decrypt failure. The
    // assertion pins the contract at the banner's own boundary.
    expect(missingBackupRailsFor({ ...base, contactsV2: 'present' })).toEqual([]);
  });
});

describe('CONTACTS_BACKUP_TOO_LARGE_COPY', () => {
  it('says the backup stopped and that nothing local was lost (R6)', () => {
    expect(CONTACTS_BACKUP_TOO_LARGE_COPY).toContain('too large');
    expect(CONTACTS_BACKUP_TOO_LARGE_COPY).toContain('Nothing is lost on this device');
  });
});

describe('CONTACTS_BACKUP_STALLED_COPY', () => {
  it('says the backup on the relay could not be read and that local changes are not yet backed up (R6, useContactsV2Sync "stalled")', () => {
    expect(CONTACTS_BACKUP_STALLED_COPY).toContain('not read the contact backup');
    expect(CONTACTS_BACKUP_STALLED_COPY).toContain('not backed up until it is readable');
  });
});
