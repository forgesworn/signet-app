import { describe, it, expect } from 'vitest';
import { validateOperation, validateRecord, applyOperations } from './contacts-v2-reducer';
import { resolveEffective } from './contacts-v2-effective';
import { contactVCard, type ContactShareFields } from './contact-share-fields';
import { planShare } from './contacts-v2-family-ops';
import { buildContactProjection, projectContact } from './contact-projection';
import { CAPABILITIES } from '@forgesworn/signet-contacts/wire';
import type { ContactOperation, ContactRecord, EffectiveContact } from '../types';

const DIR = 'owner';
const CID = '0'.repeat(32);
const OWNER = '1'.repeat(64);
const SERVER = 'https://nostr.download';
// Distinctive values so "never contains" assertions cannot pass by accident.
const HASH = 'ab12'.repeat(16);
const KEY = 'c0de'.repeat(16);
const PLAIN = '5eed'.repeat(16);
const POINTER = { server: SERVER, hash: HASH, key: KEY, plainHash: PLAIN };

function op(over: Partial<ContactOperation> & { operationId: string }): ContactOperation {
  return {
    directoryId: DIR, contactId: CID, actorPubkey: OWNER, actorRole: 'owner', actorDeviceId: 'd'.repeat(32),
    logicalClock: 1, action: 'add', value: { type: 'person', displayName: 'Dave', tier: 'kith' }, createdAt: 1_000,
    ...over,
  };
}
const addOp = op({ operationId: 'a'.repeat(32) });
const setOp = (id: string, clock: number, value: unknown = POINTER, extra: Partial<ContactOperation> = {}) =>
  op({ operationId: id.repeat(32), logicalClock: clock, action: 'set-picture', value, createdAt: 1_000 + clock, ...extra });
const clearOp = (id: string, clock: number) =>
  op({ operationId: id.repeat(32), logicalClock: clock, action: 'clear-picture', value: {}, createdAt: 1_000 + clock });

describe('set-picture / clear-picture validation', () => {
  it('accepts a valid set-picture and an empty clear-picture', () => {
    expect(validateOperation(setOp('b', 2))).toBe(true);
    expect(validateOperation(clearOp('c', 3))).toBe(true);
  });

  it('is allowed for owner and guardian authors', () => {
    expect(validateOperation(setOp('b', 2, POINTER, { actorRole: 'owner' }))).toBe(true);
    expect(validateOperation(setOp('b', 2, POINTER, { actorRole: 'guardian' }))).toBe(true);
  });

  it('is refused from a dependant or an app (a child-chosen server must never be fetched automatically)', () => {
    for (const actorRole of ['dependant', 'app'] as const) {
      expect(validateOperation(setOp('b', 2, POINTER, { actorRole }))).toBe(false);
      expect(validateOperation({ ...clearOp('c', 3), actorRole })).toBe(false);
    }
  });

  it('rejects uppercase hex in hash, key and plainHash', () => {
    for (const field of ['hash', 'key', 'plainHash'] as const) {
      expect(validateOperation(setOp('b', 2, { ...POINTER, [field]: POINTER[field].toUpperCase() }))).toBe(false);
    }
  });

  it('rejects wrong-length hex', () => {
    expect(validateOperation(setOp('b', 2, { ...POINTER, key: KEY.slice(1) }))).toBe(false);
    expect(validateOperation(setOp('b', 2, { ...POINTER, hash: HASH + 'a' }))).toBe(false);
  });

  it('rejects an extra field and a missing field', () => {
    expect(validateOperation(setOp('b', 2, { ...POINTER, extra: 1 }))).toBe(false);
    const { plainHash: _gone, ...missing } = POINTER;
    void _gone;
    expect(validateOperation(setOp('b', 2, missing))).toBe(false);
  });

  it('rejects a non-empty clear-picture value', () => {
    expect(validateOperation(op({ operationId: 'c'.repeat(32), logicalClock: 3, action: 'clear-picture', value: { x: 1 } }))).toBe(false);
  });

  it('rejects http://, other schemes, internal hosts, and >512 chars', () => {
    for (const server of [
      'http://nostr.download', 'http://localhost:3000', 'ftp://nostr.download', 'https://localhost', 'https://127.0.0.1',
      'https://192.168.1.5', 'https://10.0.0.1', 'https://169.254.169.254', 'not a url', '',
      'https://example.com/' + 'a'.repeat(512),
    ]) {
      expect(validateOperation(setOp('b', 2, { ...POINTER, server })), server).toBe(false);
    }
    const exactly512 = 'https://example.com/' + 'a'.repeat(512 - 'https://example.com/'.length);
    expect(exactly512.length).toBe(512);
    expect(validateOperation(setOp('b', 2, { ...POINTER, server: exactly512 }))).toBe(true);
  });

  it('is refused for an app actor (not in APP_ALLOWED_ACTIONS)', () => {
    expect(validateOperation(setOp('b', 2, POINTER, { actorRole: 'app' }))).toBe(false);
    expect(validateOperation({ ...clearOp('c', 3), actorRole: 'app' })).toBe(false);
  });
});

describe('reducer: picture', () => {
  it('set-picture sets record.picture; clear-picture removes it; last op wins', () => {
    const set1 = setOp('b', 2);
    const other = { ...POINTER, hash: 'de'.repeat(32) };
    const set2 = setOp('d', 4, other);
    const rec = (ops: ContactOperation[]) => applyOperations(ops).get(`${DIR}/${CID}`)!;
    expect(rec([addOp]).picture).toBeUndefined();
    expect(rec([addOp, set1]).picture).toEqual(POINTER);
    expect(rec([addOp, set1, clearOp('c', 3)]).picture).toBeUndefined();
    expect('picture' in rec([addOp, set1, clearOp('c', 3)])).toBe(false);
    // Last wins by order, not by arrival.
    expect(rec([addOp, set2, set1]).picture).toEqual(other);
    expect(rec([addOp, set1, clearOp('c', 3), set2]).picture).toEqual(other);
    expect(rec([addOp, set2, clearOp('c', 5)]).picture).toBeUndefined();
  });

  it('a picture set after the record was removed is ignored, and the earlier one stays', () => {
    const removed = applyOperations([addOp, setOp('b', 2), op({ operationId: 'e'.repeat(32), logicalClock: 3, action: 'remove', value: {} }), setOp('d', 4, { ...POINTER, hash: 'de'.repeat(32) })])
      .get(`${DIR}/${CID}`)!;
    expect(removed.lifecycle).toBe('removed');
    expect(removed.picture).toEqual(POINTER);
  });
});

describe('validateRecord: picture', () => {
  const base = applyOperations([addOp]).get(`${DIR}/${CID}`)!;
  it('accepts a record without and with a good picture', () => {
    expect(validateRecord(base)).toBe(true);
    expect(validateRecord({ ...base, picture: POINTER })).toBe(true);
  });
  it('rejects a bad picture', () => {
    expect(validateRecord({ ...base, picture: { ...POINTER, key: KEY.toUpperCase() } })).toBe(false);
    expect(validateRecord({ ...base, picture: { ...POINTER, extra: 1 } })).toBe(false);
    expect(validateRecord({ ...base, picture: { ...POINTER, server: 'http://x.example' } })).toBe(false);
    expect(validateRecord({ ...base, picture: 'nope' })).toBe(false);
    expect(validateRecord({ ...base, picture: null })).toBe(false);
  });
});

// --- The key is a secret: it never leaves the record. ---

function recordWithPicture(): ContactRecord {
  return {
    directoryId: 'owner', contactId: 'a'.repeat(32), type: 'person', displayName: 'Ada', tier: 'kith', roles: ['coach'],
    identities: [{ itemId: '1'.repeat(32), pubkey: 'c'.repeat(64), provenance: 'direct', verification: 'proven', addedAt: 1 }],
    contactMethods: [
      { itemId: '2'.repeat(32), kind: 'email', value: 'ada@example.com', verification: 'unverified', sharingPolicy: 'grantable', addedAt: 1 },
      { itemId: '3'.repeat(32), kind: 'phone', value: '+441234567890', verification: 'proven', sharingPolicy: 'grantable', addedAt: 1 },
    ],
    accessGrants: [], lifecycle: 'active', createdAt: 1, updatedAt: 1,
    createdByActorRole: 'owner', createdByOperationId: '0'.repeat(32),
    vouches: [], ceilings: [], blocks: [], notes: 'a note',
    picture: { ...POINTER },
  } as ContactRecord;
}

function expectNoPictureValues(output: string): void {
  expect(output).not.toContain(KEY);
  expect(output).not.toContain(HASH);
  expect(output).not.toContain(PLAIN);
  expect(output).not.toContain('nostr.download');
  expect(output).not.toContain('picture');
}

describe('picture is excluded from everything that leaves the record', () => {
  const ctx = { activeGuardianPubkeys: [OWNER], defaultChildCeiling: 'ken' as const, directoryIsDependant: false };

  it('the effective view drops it', () => {
    const effective = resolveEffective(recordWithPicture(), ctx);
    expect('picture' in effective).toBe(false);
    expectNoPictureValues(JSON.stringify(effective));
  });

  it('the vCard export, with every field ticked', () => {
    const rec = recordWithPicture();
    const fields: ContactShareFields = {
      name: true, identities: rec.identities.map(i => i.itemId), methods: rec.contactMethods.map(m => m.itemId),
      tier: true, roles: true, notes: true, type: true, checks: true, blocked: true,
    };
    expectNoPictureValues(contactVCard(rec, fields));
  });

  it('family-manager Share, with every field ticked', () => {
    const rec = recordWithPicture();
    const source = { ...rec, effectiveTier: 'kith', tierSource: 'direct', blocked: false, blockedBy: [] } as EffectiveContact;
    const fields: ContactShareFields = {
      name: true, identities: rec.identities.map(i => i.itemId), methods: rec.contactMethods.map(m => m.itemId),
      tier: true, roles: true, notes: true, type: true, checks: true, blocked: true,
    };
    const plan = planShare({
      source, fields, guardianPubkey: OWNER,
      targets: [
        { directoryId: 'dependant:' + '4'.repeat(64), contactId: null, label: 'Kid', ownerIdentityPubkey: '5'.repeat(64) },
        { directoryId: 'dependant:' + '6'.repeat(64), contactId: '7'.repeat(32), label: 'Kid 2' },
      ] as never,
    });
    expectNoPictureValues(JSON.stringify(plan));
  });

  it('app projections, at full scope (even when handed a record that still carries one)', () => {
    const source = { ...recordWithPicture(), effectiveTier: 'kith', tierSource: 'direct', blocked: false, blockedBy: [] } as EffectiveContact;
    expectNoPictureValues(JSON.stringify(projectContact(source, 'f'.repeat(32), new Set(CAPABILITIES), {})));
    const projection = buildContactProjection({
      grantId: 'f'.repeat(32), capabilities: [...CAPABILITIES], contacts: [source],
      frontier: { maxClock: 1, opCount: 1, publishedAt: 1_700_000_000, deviceId: '2'.repeat(32) },
      appLabels: {}, issuedAt: 1_700_000_000, maxStalenessSeconds: 3600,
    });
    expectNoPictureValues(JSON.stringify(projection));
  });
});
