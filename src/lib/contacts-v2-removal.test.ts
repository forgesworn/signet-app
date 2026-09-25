import { describe, it, expect } from 'vitest';
import { planDependantContactRemoval } from './contacts-v2-removal';
import type { ContactRecord } from '../types';

function record(over: Partial<ContactRecord> & { contactId: string }): ContactRecord {
  return {
    directoryId: 'dependant:0', type: 'person', displayName: 'Dave',
    tier: 'ken', roles: [], identities: [], contactMethods: [], accessGrants: [],
    lifecycle: 'active', createdAt: 1, updatedAt: 2,
    createdByActorRole: 'guardian', createdByOperationId: 'op-1',
    vouches: [], ceilings: [], blocks: [], ...over,
  } as ContactRecord;
}

describe('planDependantContactRemoval', () => {
  it('tombstones every live record on delete', () => {
    const plan = planDependantContactRemoval('dependant:0', [record({ contactId: 'a' }), record({ contactId: 'b' })], 'delete');
    expect(plan).toEqual({ choice: 'delete', directoryId: 'dependant:0', action: 'remove', contactIds: ['a', 'b'] });
  });

  it('archives every live record on archive', () => {
    const plan = planDependantContactRemoval('dependant:0', [record({ contactId: 'a' })], 'archive');
    expect(plan.action).toBe('archive');
    expect(plan.contactIds).toEqual(['a']);
  });

  it('skips records already removed or archived', () => {
    const plan = planDependantContactRemoval('dependant:0', [
      record({ contactId: 'a', lifecycle: 'removed' }),
      record({ contactId: 'b', archived: true }),
      record({ contactId: 'c' }),
    ], 'delete');
    expect(plan.contactIds).toEqual(['c']);
  });

  it('ignores records from another directory', () => {
    const plan = planDependantContactRemoval('dependant:0', [
      record({ contactId: 'a', directoryId: 'owner' }),
      record({ contactId: 'b' }),
    ], 'archive');
    expect(plan.contactIds).toEqual(['b']);
  });

  it('returns an empty plan for an empty directory', () => {
    expect(planDependantContactRemoval('dependant:0', [], 'delete').contactIds).toEqual([]);
  });
});
