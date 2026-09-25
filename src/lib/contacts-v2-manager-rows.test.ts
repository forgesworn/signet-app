import { describe, it, expect } from 'vitest';
import { buildManagerRows, coGuardianCeilingIsStricter, type ManagerDirectory } from './contacts-v2-manager-rows';
import type { EffectiveContact } from '../types';

const ME = '1'.repeat(64);
const OTHER_GUARDIAN = '9'.repeat(64);
const DAVE = 'a'.repeat(64);
const DAVE_ALT = 'b'.repeat(64);
const AMY = 'c'.repeat(64);

function contact(over: Partial<EffectiveContact> & { contactId: string }): EffectiveContact {
  return {
    directoryId: 'owner', type: 'person', displayName: 'Dave',
    tier: 'kin', roles: [], identities: [], contactMethods: [], accessGrants: [],
    lifecycle: 'active', createdAt: 1, updatedAt: 2,
    createdByActorRole: 'owner', createdByOperationId: 'op-1',
    vouches: [], ceilings: [], blocks: [],
    effectiveTier: 'kin', tierSource: 'direct', blocked: false, blockedBy: [],
    ...over,
  } as EffectiveContact;
}

function ident(pubkey: string) {
  return { itemId: `i-${pubkey.slice(0, 2)}`, pubkey, provenance: 'direct' as const, verification: 'proven' as const, addedAt: 1 };
}

const dirs = (owner: EffectiveContact[], sam: EffectiveContact[], lily: EffectiveContact[] = []): ManagerDirectory[] => ([
  { directoryId: 'owner', label: 'You', isOwner: true, contacts: owner },
  { directoryId: 'dependant:0', label: 'Sam', isOwner: false, contacts: sam },
  { directoryId: 'dependant:1', label: 'Lily', isOwner: false, contacts: lily },
]);

describe('buildManagerRows', () => {
  it('gives one cell per directory, in directory order', () => {
    const rows = buildManagerRows(
      dirs([contact({ contactId: 'c-owner', identities: [ident(DAVE)] })], []),
      { actorPubkey: ME },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cells.map(c => c.directoryId)).toEqual(['owner', 'dependant:0', 'dependant:1']);
    expect(rows[0].cells[0].present).toBe(true);
    expect(rows[0].cells[1]).toMatchObject({ present: false, contactId: null, localName: null, blocked: false });
  });

  it('groups records across directories by an exactly matching pubkey', () => {
    const rows = buildManagerRows(
      dirs(
        [contact({ contactId: 'c-owner', displayName: 'Dave', identities: [ident(DAVE)] })],
        [contact({ contactId: 'c-sam', directoryId: 'dependant:0', displayName: 'Uncle Dave', identities: [ident(DAVE)], effectiveTier: 'ken', tierSource: 'guardian-vouched' })],
      ),
      { actorPubkey: ME },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cells[1]).toMatchObject({
      present: true, localName: 'Uncle Dave', effectiveTier: 'ken', tierSource: 'guardian-vouched',
    });
  });

  it('joins two records that share one of several pubkeys', () => {
    const rows = buildManagerRows(
      dirs(
        [contact({ contactId: 'c-owner', identities: [ident(DAVE), ident(DAVE_ALT)] })],
        [contact({ contactId: 'c-sam', directoryId: 'dependant:0', identities: [ident(DAVE_ALT)] })],
      ),
      { actorPubkey: ME },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].identityPubkeys.sort()).toEqual([DAVE, DAVE_ALT].sort());
  });

  it('keeps keyless contacts as separate rows even when the names match', () => {
    const rows = buildManagerRows(
      dirs(
        [contact({ contactId: 'c-owner', displayName: 'Dave' })],
        [contact({ contactId: 'c-sam', directoryId: 'dependant:0', displayName: 'Dave' })],
      ),
      { actorPubkey: ME },
    );
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.groupPubkey === null)).toBe(true);
    expect(new Set(rows.map(r => r.rowKey)).size).toBe(2);
  });

  it('marks a block and says whether the actor applied it', () => {
    const blockedByMe = contact({
      contactId: 'c-sam', directoryId: 'dependant:0', identities: [ident(DAVE)],
      blocked: true, blockedBy: [ME],
      blocks: [{ blockedBy: ME, scope: { kind: 'contact' }, blockedAt: 4, operationId: 'op-b' }],
    });
    const blockedByOther = contact({
      contactId: 'c-lily', directoryId: 'dependant:1', identities: [ident(DAVE)],
      blocked: true, blockedBy: [OTHER_GUARDIAN],
      blocks: [{ blockedBy: OTHER_GUARDIAN, scope: { kind: 'contact' }, blockedAt: 4, operationId: 'op-c' }],
    });
    const rows = buildManagerRows(dirs([], [blockedByMe], [blockedByOther]), { actorPubkey: ME });
    expect(rows[0].cells[1]).toMatchObject({ blocked: true, blockedByActor: true });
    expect(rows[0].cells[2]).toMatchObject({ blocked: true, blockedByActor: false });
  });

  it('reports the most restrictive active ceiling on the cell', () => {
    const capped = contact({
      contactId: 'c-sam', directoryId: 'dependant:0', identities: [ident(DAVE)],
      ceilings: [
        { guardianPubkey: ME, maxTier: 'kith', createdAt: 1, operationId: 'op-1' },
        { guardianPubkey: OTHER_GUARDIAN, maxTier: 'ken', createdAt: 2, operationId: 'op-2' },
        { guardianPubkey: ME, maxTier: 'kin', createdAt: 3, operationId: 'op-3', revokedByOperationId: 'op-x' },
      ],
    });
    const rows = buildManagerRows(dirs([], [capped]), { actorPubkey: ME });
    expect(rows[0].cells[1].ceilingMaxTier).toBe('ken');
  });

  it('R-CEILING-DISPLAY: reports the actor\'s own ceiling separately, and flags a co-guardian\'s stricter cap', () => {
    const capped = contact({
      contactId: 'c-sam', directoryId: 'dependant:0', identities: [ident(DAVE)],
      ceilings: [
        { guardianPubkey: ME, maxTier: 'kith', createdAt: 1, operationId: 'op-1' },
        { guardianPubkey: OTHER_GUARDIAN, maxTier: 'ken', createdAt: 2, operationId: 'op-2' },
        // Revoked — excluded from BOTH the actor's own ceiling and the
        // most-restrictive one, even though it is ME's own and newer.
        { guardianPubkey: ME, maxTier: 'kin', createdAt: 3, operationId: 'op-3', revokedByOperationId: 'op-x' },
      ],
    });
    const rows = buildManagerRows(dirs([], [capped]), { actorPubkey: ME });
    const cell = rows[0].cells[1];
    expect(cell.actorCeilingMaxTier).toBe('kith');
    expect(cell.ceilingMaxTier).toBe('ken'); // the co-guardian's stricter cap
    expect(coGuardianCeilingIsStricter(cell)).toBe(true);
  });

  it('R-CEILING-DISPLAY: is never flagged when the actor\'s own ceiling IS the binding one', () => {
    const capped = contact({
      contactId: 'c-sam', directoryId: 'dependant:0', identities: [ident(DAVE)],
      ceilings: [{ guardianPubkey: ME, maxTier: 'kith', createdAt: 1, operationId: 'op-1' }],
    });
    const rows = buildManagerRows(dirs([], [capped]), { actorPubkey: ME });
    const cell = rows[0].cells[1];
    expect(cell.actorCeilingMaxTier).toBe('kith');
    expect(cell.ceilingMaxTier).toBe('kith');
    expect(coGuardianCeilingIsStricter(cell)).toBe(false);
  });

  it('R-CEILING-DISPLAY: flags a co-guardian ceiling even when the actor has none at all', () => {
    const capped = contact({
      contactId: 'c-sam', directoryId: 'dependant:0', identities: [ident(DAVE)],
      ceilings: [{ guardianPubkey: OTHER_GUARDIAN, maxTier: 'ken', createdAt: 1, operationId: 'op-1' }],
    });
    const rows = buildManagerRows(dirs([], [capped]), { actorPubkey: ME });
    const cell = rows[0].cells[1];
    expect(cell.actorCeilingMaxTier).toBeNull();
    expect(coGuardianCeilingIsStricter(cell)).toBe(true);
  });

  it('P5: two records in the SAME directory that collide onto one grouped row each keep their own cell, not overwrite one another', () => {
    // Both owner records carry DAVE, so they union into the same grouped row
    // — but they are two DIFFERENT contacts in the SAME (owner) directory.
    const first = contact({ contactId: 'c-first', displayName: 'Dave', identities: [ident(DAVE)] });
    const second = contact({ contactId: 'c-second', displayName: 'Dave Two', identities: [ident(DAVE)] });
    const rows = buildManagerRows(dirs([first, second], []), { actorPubkey: ME });
    expect(rows).toHaveLength(2);
    const owners = rows.map(r => r.cells[0]).filter(c => c.present);
    expect(owners.map(c => c.contactId).sort()).toEqual(['c-first', 'c-second']);
    // Neither dropped the other's data.
    expect(rows.some(r => r.displayName === 'Dave')).toBe(true);
    expect(rows.some(r => r.displayName === 'Dave Two')).toBe(true);
  });

  it('skips removed and archived records', () => {
    const rows = buildManagerRows(
      dirs(
        [contact({ contactId: 'gone', identities: [ident(DAVE)], lifecycle: 'removed' })],
        [contact({ contactId: 'archived', directoryId: 'dependant:0', identities: [ident(AMY)], archived: true })],
      ),
      { actorPubkey: ME },
    );
    expect(rows).toEqual([]);
  });

  it('sorts rows by display name and prefers the owner name for the row label', () => {
    const rows = buildManagerRows(
      dirs(
        [contact({ contactId: 'c-owner', displayName: 'Dave', identities: [ident(DAVE)] })],
        [
          contact({ contactId: 'c-sam', directoryId: 'dependant:0', displayName: 'Uncle Dave', identities: [ident(DAVE)] }),
          contact({ contactId: 'c-amy', directoryId: 'dependant:0', displayName: 'Amy', identities: [ident(AMY)] }),
        ],
      ),
      { actorPubkey: ME },
    );
    expect(rows.map(r => r.displayName)).toEqual(['Amy', 'Dave']);
  });
});
