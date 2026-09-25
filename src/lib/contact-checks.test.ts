import { expect, it } from 'vitest';
import { applyOperations, validateOperation } from './contacts-v2-reducer';
import type { ContactOperation } from '../types';
const owner = '1'.repeat(64), peer = '2'.repeat(64), contactId = '3'.repeat(32);
const base = { directoryId: 'owner', contactId, actorPubkey: owner, actorRole: 'owner' as const,
  actorDeviceId: '4'.repeat(32), ownerIdentityPubkey: owner, createdAt: 1000 };
const check = { id: '5'.repeat(32), identityPubkey: peer, ownerIdentityPubkey: owner, method: 'in-person', checkedAt: 1000,
  source: 'website', evidence: 'Private\u0000 evidence' };
const ops: ContactOperation[] = [
  { ...base, operationId: '6'.repeat(32), logicalClock: 1, action: 'add', value: { type: 'person', displayName: 'Friend', tier: 'ken' } },
  { ...base, operationId: '7'.repeat(32), logicalClock: 2, action: 'add-identity', value: { itemId: '8'.repeat(32), pubkey: peer, provenance: 'direct', verification: 'unverified' } },
  { ...base, operationId: '9'.repeat(32), logicalClock: 3, action: 'record-check', value: check },
];
it('records a private check without changing tier or asserting stronger key verification', () => {
  const record = applyOperations(ops).get(`owner/${contactId}`)!;
  expect(record.checks?.[0]).toMatchObject({ method: 'in-person', source: 'website', evidence: 'Private evidence' });
  expect(record.tier).toBe('ken');
  expect(record.identities[0].verification).toBe('unverified');
  expect(applyOperations([...ops, { ...base, operationId: 'a'.repeat(32), logicalClock: 4, action: 'remove-check', value: { id: check.id } }]).get(`owner/${contactId}`)!.checks).toEqual([]);
});
it('rejects app-authored checks, malformed dates and misattributed owner identities', () => {
  expect(validateOperation({ ...ops[2], actorRole: 'app' })).toBe(false);
  expect(validateOperation({ ...ops[2], ownerIdentityPubkey: peer })).toBe(false);
  expect(validateOperation({ ...ops[2], value: { ...check, checkedAt: -1 } })).toBe(false);
  expect(validateOperation({ ...ops[2], value: { ...check, source: 'unknown-source' } })).toBe(false);
});
