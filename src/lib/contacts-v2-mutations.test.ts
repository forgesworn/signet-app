import { describe, it, expect } from 'vitest';
import { buildOperation, type MutationActor } from './contacts-v2-mutations';
import { validateOperation } from './contacts-v2-reducer';

const actor: MutationActor = {
  actorPubkey: '1'.repeat(64),
  actorRole: 'guardian',
  actorDeviceId: 'd'.repeat(32),
};
const CID = '0'.repeat(32);
const OPID = 'a'.repeat(32);
const DEP_DIR = `dependant:${'b'.repeat(64)}`;

describe('buildOperation', () => {
  it('stamps the actor, clock and timestamp onto a valid operation', () => {
    const op = buildOperation({
      directoryId: DEP_DIR,
      contactId: CID,
      action: 'set-tier',
      value: { tier: 'kin' },
      clock: 7,
      actor,
      now: 5_000,
      operationId: OPID,
    });
    expect(op).toEqual({
      operationId: OPID,
      directoryId: DEP_DIR,
      contactId: CID,
      actorPubkey: '1'.repeat(64),
      actorRole: 'guardian',
      actorDeviceId: 'd'.repeat(32),
      logicalClock: 7,
      action: 'set-tier',
      value: { tier: 'kin' },
      createdAt: 5_000,
    });
    expect(validateOperation(op)).toBe(true);
  });

  it('includes itemId and targetOperationId only when given', () => {
    const plain = buildOperation({ directoryId: 'owner', contactId: CID, action: 'remove', value: {}, clock: 1, actor, now: 1, operationId: OPID });
    expect('itemId' in plain).toBe(false);
    expect('targetOperationId' in plain).toBe(false);

    const targeted = buildOperation({
      directoryId: 'owner', contactId: CID, action: 'unblock', value: {}, clock: 2, actor, now: 2,
      operationId: 'b'.repeat(32), targetOperationId: 'c'.repeat(32), itemId: '9'.repeat(32),
    });
    expect(targeted.itemId).toBe('9'.repeat(32));
    expect(targeted.targetOperationId).toBe('c'.repeat(32));
    expect(validateOperation(targeted)).toBe(true);
  });

  it('builds an operation the reducer rejects when the caller passes a bad value', () => {
    // The builder does not guess or repair a value — the reducer is the gate.
    const op = buildOperation({ directoryId: 'owner', contactId: CID, action: 'set-tier', value: { tier: 'boss' }, clock: 1, actor, now: 1, operationId: OPID });
    expect(validateOperation(op)).toBe(false);
  });
});
