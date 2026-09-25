import { describe, it, expect } from 'vitest';
import { applyOperations, recordKey } from './contacts-v2-reducer';
import type { ContactOperation } from '../types';

const DIR = `dependant:${'b'.repeat(64)}`;
const CID = '0'.repeat(32);
const GUARDIAN_A = '1'.repeat(64);
const GUARDIAN_B = '2'.repeat(64);
const ITEM = '9'.repeat(32);
const PEER = 'ab'.repeat(32);

// Fixture operationIds must be valid 32-char lowercase hex (HEX32 = /^[0-9a-f]{32}$/).
// Single letters a-f and single digits are hex-safe on their own; beyond 'f' the
// alphabet stops being hex, so those ids use a two-digit numeric code instead.
const OID = {
  g: '10'.repeat(16), h: '11'.repeat(16), i: '12'.repeat(16), j: '13'.repeat(16),
  k: '14'.repeat(16), l: '15'.repeat(16), m: '16'.repeat(16), n: '17'.repeat(16),
  o: '18'.repeat(16), p: '19'.repeat(16), q: '20'.repeat(16), r: '21'.repeat(16),
  s: '22'.repeat(16), t: '23'.repeat(16), u: '24'.repeat(16), v: '25'.repeat(16),
  w: '26'.repeat(16), x: '27'.repeat(16), y: '28'.repeat(16), z: '29'.repeat(16),
};

function op(overrides: Partial<ContactOperation> & { operationId: string }): ContactOperation {
  return {
    directoryId: DIR,
    contactId: CID,
    actorPubkey: GUARDIAN_A,
    actorRole: 'guardian',
    actorDeviceId: 'd'.repeat(32),
    logicalClock: 1,
    action: 'add',
    value: { type: 'person', displayName: 'Dave', tier: 'kith' },
    createdAt: 1_000,
    ...overrides,
  };
}
const addOp = op({ operationId: 'a'.repeat(32), logicalClock: 1 });
const rec = (ops: ContactOperation[]) => applyOperations(ops).get(recordKey(DIR, CID))!;

describe('identities and methods', () => {
  it('adds an identity with its direct evidence and preserves legacy annotations', () => {
    const r = rec([addOp, op({
      operationId: 'b'.repeat(32), logicalClock: 2, action: 'add-identity', itemId: ITEM,
      value: {
        itemId: ITEM, pubkey: PEER, label: 'Gaming', provenance: 'legacy-import', verification: 'mutual',
        direct: { ownerPubkey: GUARDIAN_A, sharedSecret: 'deadbeef', verifiedAt: 500, groupId: 'g1', isDefaultForGroup: true },
      },
    })]);
    expect(r.identities).toHaveLength(1);
    expect(r.identities[0].pubkey).toBe(PEER);
    expect(r.identities[0].verification).toBe('mutual');
    expect(r.identities[0].direct?.sharedSecret).toBe('deadbeef');
    expect(r.identities[0].direct?.groupId).toBe('g1');
    expect(r.identities[0].addedAt).toBe(1_000);
  });

  it('is idempotent on a repeated itemId and patches through evidence', () => {
    const add = op({ operationId: 'c'.repeat(32), logicalClock: 2, action: 'add-identity', itemId: ITEM, value: { itemId: ITEM, pubkey: PEER, provenance: 'direct', verification: 'unverified' } });
    const again = op({ operationId: 'd'.repeat(32), logicalClock: 3, action: 'add-identity', itemId: ITEM, value: { itemId: ITEM, pubkey: PEER, provenance: 'direct', verification: 'unverified' } });
    const evidence = op({ operationId: 'e'.repeat(32), logicalClock: 4, action: 'evidence', itemId: ITEM, value: { itemId: ITEM, verification: 'proven' } });
    const r = rec([addOp, add, again, evidence]);
    expect(r.identities).toHaveLength(1);
    expect(r.identities[0].verification).toBe('proven');
  });

  it('adds, updates and removes a contact method', () => {
    const methodItem = '8'.repeat(32);
    const add = op({ operationId: 'f'.repeat(32), logicalClock: 2, action: 'add-method', itemId: methodItem, value: { itemId: methodItem, kind: 'phone', value: '07700 900000', verification: 'unverified', sharingPolicy: 'private' } });
    const update = op({ operationId: OID.g, logicalClock: 3, action: 'update-method', itemId: methodItem, value: { itemId: methodItem, label: 'Mobile', sharingPolicy: 'grantable' } });
    const afterUpdate = rec([addOp, add, update]);
    expect(afterUpdate.contactMethods[0].label).toBe('Mobile');
    expect(afterUpdate.contactMethods[0].sharingPolicy).toBe('grantable');
    expect(afterUpdate.contactMethods[0].value).toBe('07700 900000');

    const remove = op({ operationId: OID.h, logicalClock: 4, action: 'remove-item', itemId: methodItem, value: { itemId: methodItem } });
    expect(rec([addOp, add, update, remove]).contactMethods).toHaveLength(0);
  });

  it('records a proven key link as a new identity pointing at the old item', () => {
    const newItem = '7'.repeat(32);
    const link = op({ operationId: OID.i, logicalClock: 2, action: 'key-link', itemId: newItem, value: { itemId: newItem, pubkey: 'cd'.repeat(32), linkedFromItemId: ITEM } });
    const r = rec([addOp, link]);
    expect(r.identities[0].provenance).toBe('key-link');
    expect(r.identities[0].verification).toBe('proven');
    expect(r.identities[0].linkedFromItemId).toBe(ITEM);
  });
});

describe('guardian vouches and ceilings', () => {
  it('appends a vouch and lets its own guardian revoke it', () => {
    const vouch = op({ operationId: OID.j, logicalClock: 2, action: 'vouch', value: { guardianPubkey: GUARDIAN_A, tier: 'kin', role: 'Uncle Dave' } });
    const revoke = op({ operationId: OID.k, logicalClock: 3, action: 'revoke-vouch', targetOperationId: OID.j, value: {} });
    expect(rec([addOp, vouch]).vouches[0].tier).toBe('kin');
    expect(rec([addOp, vouch]).vouches[0].vouchId).toBe(OID.j);
    expect(rec([addOp, vouch, revoke]).vouches[0].revokedByOperationId).toBe(OID.k);
  });

  it('refuses a revoke from a different guardian', () => {
    const vouch = op({ operationId: OID.l, logicalClock: 2, action: 'vouch', value: { guardianPubkey: GUARDIAN_A, tier: 'kin' } });
    const foreign = op({ operationId: OID.m, logicalClock: 3, action: 'revoke-vouch', actorPubkey: GUARDIAN_B, targetOperationId: OID.l, value: {} });
    expect(rec([addOp, vouch, foreign]).vouches[0].revokedByOperationId).toBeUndefined();
  });

  it('supersedes a guardian own earlier vouch and earlier ceiling', () => {
    const v1 = op({ operationId: OID.n, logicalClock: 2, action: 'vouch', value: { guardianPubkey: GUARDIAN_A, tier: 'kin' } });
    const v2 = op({ operationId: OID.o, logicalClock: 3, action: 'vouch', value: { guardianPubkey: GUARDIAN_A, tier: 'kith' } });
    const r1 = rec([addOp, v1, v2]);
    expect(r1.vouches).toHaveLength(2);
    expect(r1.vouches.filter(v => !v.revokedByOperationId)).toHaveLength(1);
    expect(r1.vouches.find(v => !v.revokedByOperationId)!.tier).toBe('kith');

    const c1 = op({ operationId: OID.p, logicalClock: 4, action: 'ceiling', value: { guardianPubkey: GUARDIAN_A, maxTier: 'ken' } });
    const c2 = op({ operationId: OID.q, logicalClock: 5, action: 'ceiling', value: { guardianPubkey: GUARDIAN_A, maxTier: 'kith' } });
    const r2 = rec([addOp, c1, c2]);
    expect(r2.ceilings.filter(c => !c.revokedByOperationId).map(c => c.maxTier)).toEqual(['kith']);
  });

  it('ignores a ceiling or revoke naming a guardian other than the actor', () => {
    const foreignCeiling = op({ operationId: OID.r, logicalClock: 2, action: 'ceiling', actorPubkey: GUARDIAN_A, value: { guardianPubkey: GUARDIAN_B, maxTier: 'ken' } });
    expect(rec([addOp, foreignCeiling]).ceilings).toHaveLength(0);

    const own = op({ operationId: OID.s, logicalClock: 3, action: 'ceiling', value: { guardianPubkey: GUARDIAN_A, maxTier: 'ken' } });
    const foreignRevoke = op({ operationId: OID.t, logicalClock: 4, action: 'revoke-ceiling', actorPubkey: GUARDIAN_B, value: { guardianPubkey: GUARDIAN_A } });
    expect(rec([addOp, own, foreignRevoke]).ceilings[0].revokedByOperationId).toBeUndefined();
  });

  it('lets a guardian revoke their own ceiling', () => {
    const own = op({ operationId: OID.u, logicalClock: 2, action: 'ceiling', value: { guardianPubkey: GUARDIAN_A, maxTier: 'ken' } });
    const revoke = op({ operationId: OID.v, logicalClock: 3, action: 'revoke-ceiling', value: { guardianPubkey: GUARDIAN_A } });
    expect(rec([addOp, own, revoke]).ceilings[0].revokedByOperationId).toBe(OID.v);
  });
});

describe('blocks', () => {
  const block = op({ operationId: OID.w, logicalClock: 2, action: 'block', value: { scope: { kind: 'contact' }, reason: 'bullying' } });

  it('appends a block with its author and reason', () => {
    const r = rec([addOp, block]);
    expect(r.blocks[0].blockedBy).toBe(GUARDIAN_A);
    expect(r.blocks[0].scope).toEqual({ kind: 'contact' });
    expect(r.blocks[0].reason).toBe('bullying');
    expect(r.blocks[0].liftedByOperationId).toBeUndefined();
  });

  it('lets only the blocking authority unblock', () => {
    const foreign = op({ operationId: OID.x, logicalClock: 3, action: 'unblock', actorPubkey: GUARDIAN_B, targetOperationId: OID.w, value: {} });
    expect(rec([addOp, block, foreign]).blocks[0].liftedByOperationId).toBeUndefined();

    const own = op({ operationId: OID.y, logicalClock: 4, action: 'unblock', targetOperationId: OID.w, value: {} });
    expect(rec([addOp, block, foreign, own]).blocks[0].liftedByOperationId).toBe(OID.y);
  });

  it('ignores an unblock naming an operation that is not a block on this record', () => {
    const stray = op({ operationId: OID.z, logicalClock: 3, action: 'unblock', targetOperationId: '5'.repeat(32), value: {} });
    expect(rec([addOp, block, stray]).blocks[0].liftedByOperationId).toBeUndefined();
  });

  it('omits the reason field when it cleans to an empty string', () => {
    const blockWithEmptyReason = op({
      operationId: '30'.repeat(16),
      logicalClock: 2,
      action: 'block',
      value: { scope: { kind: 'contact' }, reason: ' ‮' }, // all control chars
    });
    const r = rec([addOp, blockWithEmptyReason]);
    expect(r.blocks[0].reason).toBeUndefined();
    expect(r.blocks[0].blockedBy).toBe(GUARDIAN_A);
    expect(r.blocks[0].scope).toEqual({ kind: 'contact' });
  });
});
