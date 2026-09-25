import { describe, it, expect } from 'vitest';
import {
  CONTACT_TIER_RANK,
  OWNER_DIRECTORY_ID,
  QUARANTINE_DIRECTORY_ID,
  DEFAULT_CHILD_CEILING,
  type ContactRecord,
  type ContactOperation,
} from '../types/contacts-v2';

describe('contacts v2 tier rank', () => {
  it('ranks kin above kith above ken', () => {
    expect(CONTACT_TIER_RANK.kin).toBeGreaterThan(CONTACT_TIER_RANK.kith);
    expect(CONTACT_TIER_RANK.kith).toBeGreaterThan(CONTACT_TIER_RANK.ken);
    expect(CONTACT_TIER_RANK.ken).toBe(1);
  });

  it('names the reserved directories and the default child ceiling', () => {
    expect(OWNER_DIRECTORY_ID).toBe('owner');
    expect(QUARANTINE_DIRECTORY_ID).toBe('quarantine');
    expect(DEFAULT_CHILD_CEILING).toBe('ken');
  });
});

describe('contacts v2 record shape', () => {
  it('constructs a record and an operation with the documented fields', () => {
    const record: ContactRecord = {
      directoryId: OWNER_DIRECTORY_ID,
      contactId: '0'.repeat(32),
      type: 'person',
      displayName: 'Dave',
      tier: 'kin',
      roles: ['best friend'],
      identities: [],
      contactMethods: [],
      accessGrants: [],
      lifecycle: 'active',
      createdAt: 1,
      updatedAt: 1,
      createdByActorRole: 'owner',
      createdByOperationId: '1'.repeat(32),
      vouches: [],
      ceilings: [],
      blocks: [],
    };
    const op: ContactOperation = {
      operationId: '1'.repeat(32),
      directoryId: OWNER_DIRECTORY_ID,
      contactId: record.contactId,
      actorPubkey: 'a'.repeat(64),
      actorRole: 'owner',
      actorDeviceId: '2'.repeat(32),
      logicalClock: 1,
      action: 'add',
      value: { type: 'person', displayName: 'Dave', tier: 'kin' },
      createdAt: 1,
    };
    expect(record.tier).toBe('kin');
    expect(op.action).toBe('add');
  });
});
