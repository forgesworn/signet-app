import { expect, it } from 'vitest';
import { applyOperations, validateOperation, validateRecord } from './contacts-v2-reducer';
import type { ContactOperation } from '../types';
const owner = '1'.repeat(64), contactId = '2'.repeat(32);
const base = { directoryId: 'owner', contactId, actorPubkey: owner, actorRole: 'owner' as const, actorDeviceId: '3'.repeat(32), ownerIdentityPubkey: owner, createdAt: 1000 };
const origin = { id: '4'.repeat(32), ownerIdentityPubkey: owner, method: 'accepted-request', addedAt: 1000, inviteId: '5'.repeat(32), inviteName: 'Private\u0000 conference' };
const ops: ContactOperation[] = [
  { ...base, operationId: '6'.repeat(32), logicalClock: 1, action: 'add', value: { type: 'person', displayName: 'Friend', tier: 'ken' } },
  { ...base, operationId: '7'.repeat(32), logicalClock: 2, action: 'record-origin', value: origin },
];
it('retains editable private invite history without changing trust and supports removal', () => {
  const record = applyOperations(ops).get(`owner/${contactId}`)!;
  expect(record.origins?.[0]).toMatchObject({ inviteName: 'Private conference', addedAt: 1000 });
  expect(record.tier).toBe('ken');
  expect(validateRecord(record)).toBe(true);
  const edited = { ...ops[1], operationId: '8'.repeat(32), logicalClock: 3, value: { ...origin, addedAt: 500 } };
  expect(applyOperations([...ops, edited]).get(`owner/${contactId}`)!.origins?.[0].addedAt).toBe(500);
  const removed = { ...ops[1], operationId: '9'.repeat(32), logicalClock: 4, action: 'remove-origin' as const, value: { id: origin.id } };
  expect(applyOperations([...ops, edited, removed]).get(`owner/${contactId}`)!.origins).toEqual([]);
});
it('rejects app-authored, misattributed and malformed origin records', () => {
  expect(validateOperation({ ...ops[1], actorRole: 'app' })).toBe(false);
  expect(validateOperation({ ...ops[1], ownerIdentityPubkey: 'a'.repeat(64) })).toBe(false);
  expect(validateOperation({ ...ops[1], value: { ...origin, addedAt: -1 } })).toBe(false);
  expect(validateOperation({ ...ops[1], value: { ...origin, inviteName: 'x'.repeat(201) } })).toBe(false);
});
