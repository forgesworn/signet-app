import { describe, it, expect } from 'vitest';
import { supersededGrantIds } from './contacts-grant-supersede';
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
    expect(supersededGrantIds(grants, APP, 'owner')).toEqual(['old']);
  });

  it('excludes a revoked grant', () => {
    const grants = [grant({ grantId: 'old', revokedAt: 123 })];
    expect(supersededGrantIds(grants, APP, 'owner')).toEqual([]);
  });

  it('excludes a grant on a different directory', () => {
    const grants = [grant({ grantId: 'old', directoryId: 'quarantine' })];
    expect(supersededGrantIds(grants, APP, 'owner')).toEqual([]);
  });

  it('excludes a grant for a different app', () => {
    const grants = [grant({ grantId: 'old', appPubkey: OTHER_APP })];
    expect(supersededGrantIds(grants, APP, 'owner')).toEqual([]);
  });

  it('matches the app pubkey case-insensitively', () => {
    const grants = [grant({ grantId: 'old', appPubkey: APP.toUpperCase() })];
    expect(supersededGrantIds(grants, APP, 'owner')).toEqual(['old']);
  });

  it('excludes the given excludeGrantId', () => {
    const grants = [grant({ grantId: 'old' }), grant({ grantId: 'new' })];
    expect(supersededGrantIds(grants, APP, 'owner', 'new')).toEqual(['old']);
  });

  it('returns multiple ids when more than one active grant matches', () => {
    const grants = [grant({ grantId: 'old1' }), grant({ grantId: 'old2' })];
    expect(supersededGrantIds(grants, APP, 'owner').sort()).toEqual(['old1', 'old2']);
  });
});
