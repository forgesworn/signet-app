import { describe, expect, it } from 'vitest';
import type { ContactOperation } from '../types';
import { applyOperations, validateOperation, validateRecord } from './contacts-v2-reducer';
import { contactBelongsToList } from './contacts-v2-membership';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
function op(clock: number, action: ContactOperation['action'], value: unknown): ContactOperation {
  return { operationId: clock.toString(16).padStart(32, '0'), directoryId: 'owner',
    contactId: 'd'.repeat(32), actorPubkey: C, actorRole: 'owner', actorDeviceId: 'e'.repeat(32),
    logicalClock: clock, createdAt: clock * 100, action, value };
}
const add = op(1, 'add', { type: 'person', displayName: 'Alice', tier: 'ken', ownerIdentityPubkey: A });
const link = op(2, 'link-list', { ownerIdentityPubkey: B });
const block = op(3, 'block', { scope: { kind: 'contact' } });
const fold = (ops: ContactOperation[]) => [...applyOperations(ops).values()][0];

describe('owning identity list membership', () => {
  it('keeps one shared record, with explicit list ownership rather than the signer', () => {
    const record = fold([add, link, op(3, 'rename', { displayName: 'Shared name' })]);
    expect(record.primaryIdentityPubkey).toBe(A);
    expect(record.displayName).toBe('Shared name');
    expect(contactBelongsToList(record, A)).toBe(true);
    expect(contactBelongsToList(record, B)).toBe(true);
    expect(contactBelongsToList(record, C)).toBe(false);
    expect(validateRecord(record)).toBe(true);
  });

  it('promotes the oldest remaining link and leaves block facts untouched', () => {
    const record = fold([add, link, block, op(4, 'link-list', { ownerIdentityPubkey: C }),
      op(5, 'unlink-list', { ownerIdentityPubkey: A })]);
    expect(record.primaryIdentityPubkey).toBe(B);
    expect(record.lifecycle).toBe('active');
    expect(contactBelongsToList(record, A)).toBe(false);
    expect(record.blocks).toHaveLength(1);
    expect(record.blocks[0].liftedByOperationId).toBeUndefined();
  });

  it('removes the contact on its last unlink and does not revive it on a late link', () => {
    const record = fold([add, block, op(4, 'unlink-list', { ownerIdentityPubkey: A }), link,
      op(5, 'unlink-list', { ownerIdentityPubkey: B }), op(6, 'link-list', { ownerIdentityPubkey: C })]);
    expect(record.lifecycle).toBe('removed');
    expect(record.primaryIdentityPubkey).toBeUndefined();
    expect(contactBelongsToList(record, C)).toBe(false);
    expect(record.blocks).toHaveLength(1);
    expect(validateRecord(record)).toBe(true);
  });

  it('removes everywhere without unblocking; explicit re-add revives only its selected list', () => {
    const removed = [add, link, block, op(4, 'remove', {})];
    const record = fold(removed);
    expect(record.listMemberships?.every(m => m.removedAt === 400)).toBe(true);
    const revived = fold([...removed, op(5, 'add', add.value)]);
    expect(contactBelongsToList(revived, A)).toBe(true);
    expect(contactBelongsToList(revived, B)).toBe(false);
    expect(revived.blocks).toEqual(record.blocks);
    expect(validateRecord(revived)).toBe(true);
  });

  it('converges across arrival order and duplicate links; re-link starts a new membership age', () => {
    const ops = [add, link, op(3, 'link-list', { ownerIdentityPubkey: C }),
      op(4, 'unlink-list', { ownerIdentityPubkey: B }), op(5, 'link-list', { ownerIdentityPubkey: B }),
      op(6, 'link-list', { ownerIdentityPubkey: B }), op(7, 'unlink-list', { ownerIdentityPubkey: A })];
    expect(fold([...ops].reverse())).toEqual(fold(ops));
    expect(fold(ops).primaryIdentityPubkey).toBe(C);
    expect(fold(ops).listMemberships?.find(m => m.ownerIdentityPubkey === B)?.addedAt).toBe(500);
  });

  it('keeps identical contact ids in separate vaults', () => {
    const records = applyOperations([add, { ...add, directoryId: `dependant:${C}` }, link]);
    expect(records.size).toBe(2);
    expect(contactBelongsToList(records.get(`dependant:${C}/${add.contactId}`)!, B)).toBe(false);
  });

  it('does not assign old records to any list without an explicit operation', () => {
    const record = fold([op(1, 'add', { type: 'person', displayName: 'Old', tier: 'ken' })]);
    expect(validateRecord(record)).toBe(true);
    expect(contactBelongsToList(record, C)).toBe(false);
  });

  it('rejects app-authored membership and malformed membership metadata', () => {
    for (const operation of [add, link, op(3, 'unlink-list', { ownerIdentityPubkey: A })]) {
      expect(validateOperation({ ...operation, actorRole: 'app' })).toBe(false);
    }
    expect(validateOperation(op(2, 'link-list', { ownerIdentityPubkey: 'invalid' }))).toBe(false);
    const record = fold([add]);
    for (const listMemberships of [[null], [{ ownerIdentityPubkey: A, addedAt: '100' }],
      [...record.listMemberships!, ...record.listMemberships!]]) {
      expect(validateRecord({ ...record, listMemberships })).toBe(false);
    }
    expect(validateRecord({ ...record, primaryIdentityPubkey: B })).toBe(false);
  });
});

describe('same-npub records from independent devices', () => {
  const peer = 'f'.repeat(64), otherId = '9'.repeat(32);
  const identity = (n: number, cid: string, item: string) => ({ ...op(n, 'add-identity', {
    itemId: item, pubkey: peer, provenance: 'direct', verification: 'unverified',
  }), contactId: cid });
  const originals = [add, identity(2, add.contactId, '8'.repeat(32)),
    { ...op(3, 'add', { type: 'person', displayName: 'Elsewhere', tier: 'kith', ownerIdentityPubkey: B }), contactId: otherId },
    identity(4, otherId, '7'.repeat(32))];

  it('converges on one record with both lists, and later edits through either id reach it', () => {
    const ops = [...originals, { ...op(5, 'note', { note: 'Alias edit' }), contactId: otherId }];
    const records = [...applyOperations(ops).values()];
    expect(records).toHaveLength(1);
    expect(records[0].listMemberships?.map(m => m.ownerIdentityPubkey)).toEqual([A, B]);
    expect(records[0].tier).toBe('kith');
    expect(records[0].notes).toBe('Alias edit');
    expect(records[0].mergedContactIds).toEqual([otherId]);
    expect([...applyOperations([...ops].reverse()).values()]).toEqual(records);
    expect(validateRecord(records[0])).toBe(true);
  });

  it('removing the key or contact does not resurrect the other id', () => {
    const withoutKey = [...originals, { ...op(5, 'remove-item', { itemId: '7'.repeat(32) }), contactId: otherId }];
    expect(applyOperations(withoutKey).size).toBe(1);
    expect(fold(withoutKey).identities).toEqual([]);
    const removed = [...originals, { ...op(6, 'remove', {}), contactId: otherId }];
    expect(applyOperations(removed).size).toBe(1);
    expect(fold(removed).lifecycle).toBe('removed');
  });

  it('does not auto-confirm an offline app-created link discovered to exist elsewhere', () => {
    const appAdd = { ...op(1, 'add', { type: 'person', displayName: 'App label', tier: 'ken', appIntroduction: {
      grantId: '6'.repeat(32), ownerIdentityPubkey: C, pubkey: peer, displayName: 'App label',
    } }), actorRole: 'app' as const };
    const ops = [appAdd, identity(2, add.contactId, '8'.repeat(32)), ...originals.slice(2)];
    const record = fold(ops);
    expect(applyOperations(ops).size).toBe(1);
    expect(record.appIntroductions?.[0].status).toBe('pending');
    expect(contactBelongsToList(record, C)).toBe(false);
    expect(contactBelongsToList(record, B)).toBe(true);
  });
});

it('preserves a concurrent safety block arriving after contact removal', () => {
  const record = fold([add, op(2, 'remove', {}), op(3, 'block', { scope: { kind: 'contact' } })]);
  expect(record.lifecycle).toBe('removed');
  expect(record.blocks).toHaveLength(1);
  expect(record.blocks[0].liftedByOperationId).toBeUndefined();
});
