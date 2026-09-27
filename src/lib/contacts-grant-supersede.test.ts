import { describe, it, expect } from 'vitest';
import { grantOptionKey, supersededGrantIds } from './contacts-grant-supersede';
import type { AppGrantV2 } from '../types';

const APP = 'a'.repeat(64);
const OTHER_APP = 'b'.repeat(64);

function grant(overrides: Partial<AppGrantV2> = {}): AppGrantV2 {
  return {
    grantId: 'g1',
    directoryId: 'owner',
    appPubkey: APP,
    createdAt: 1,
    updatedAt: 1,
    appName: 'Some App',
    capabilities: [],
    railPubkey: 'r'.repeat(64),
    railPrivateKey: 's'.repeat(64),
    relay: 'wss://relay.example',
    maxStalenessSeconds: 3600,
    appLabels: {},
    seenOperationIds: [],
    ...overrides,
  };
}

describe('supersededGrantIds', () => {
  it('matches an active grant for the same app and directory', () => {
    const grants = [grant({ grantId: 'old' })];
    expect(supersededGrantIds(grants, APP, { directoryId: 'owner' })).toEqual(['old']);
  });

  it('excludes a revoked grant', () => {
    const grants = [grant({ grantId: 'old', revokedAt: 123 })];
    expect(supersededGrantIds(grants, APP, { directoryId: 'owner' })).toEqual([]);
  });

  it('excludes a grant on a different directory', () => {
    const grants = [grant({ grantId: 'old', directoryId: 'quarantine' })];
    expect(supersededGrantIds(grants, APP, { directoryId: 'owner' })).toEqual([]);
  });

  it('excludes a grant for a different app', () => {
    const grants = [grant({ grantId: 'old', appPubkey: OTHER_APP })];
    expect(supersededGrantIds(grants, APP, { directoryId: 'owner' })).toEqual([]);
  });

  it('matches the app pubkey case-insensitively', () => {
    const grants = [grant({ grantId: 'old', appPubkey: APP.toUpperCase() })];
    expect(supersededGrantIds(grants, APP, { directoryId: 'owner' })).toEqual(['old']);
  });

  it('excludes the given excludeGrantId', () => {
    const grants = [grant({ grantId: 'old' }), grant({ grantId: 'new' })];
    expect(supersededGrantIds(grants, APP, { directoryId: 'owner' }, 'new')).toEqual(['old']);
  });

  it('returns multiple ids when more than one active grant matches', () => {
    const grants = [grant({ grantId: 'old1' }), grant({ grantId: 'old2' })];
    expect(supersededGrantIds(grants, APP, { directoryId: 'owner' }).sort()).toEqual(['old1', 'old2']);
  });

  it('never supersedes a grant owned by a different identity on the same directory', () => {
    const grants = [grant({ grantId: 'a', ownerIdentityPubkey: 'c'.repeat(64) })];
    expect(supersededGrantIds(grants, APP, { directoryId: 'owner', ownerIdentityPubkey: 'd'.repeat(64) })).toEqual([]);
    expect(supersededGrantIds(grants, APP, { directoryId: 'owner', ownerIdentityPubkey: 'C'.repeat(64) })).toEqual(['a']);
  });

  it('keys an option by directory and lower-cased owner identity', () => {
    expect(grantOptionKey({ directoryId: 'owner', ownerIdentityPubkey: 'AB' })).toBe('owner/ab');
    expect(grantOptionKey({ directoryId: 'owner' })).toBe('owner/');
  });
});
