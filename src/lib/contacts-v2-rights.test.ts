import { describe, it, expect } from 'vitest';
import { resolveActorRights, activeBlocks, ownBlocks } from './contacts-v2-rights';
import type { BlockFact, EffectiveContact } from '../types';

const ME = '1'.repeat(64);
const GUARDIAN = '2'.repeat(64);

function block(by: string, lifted?: string): BlockFact {
  return {
    blockedBy: by,
    scope: { kind: 'contact' },
    blockedAt: 10,
    operationId: `op-${by.slice(0, 4)}`,
    ...(lifted ? { liftedByOperationId: lifted } : {}),
  };
}

function contact(over: Partial<EffectiveContact> = {}): EffectiveContact {
  return {
    directoryId: 'owner', contactId: 'c1', type: 'person', displayName: 'Dave',
    tier: 'kin', roles: [], identities: [], contactMethods: [], accessGrants: [],
    lifecycle: 'active', createdAt: 1, updatedAt: 2,
    createdByActorRole: 'owner', createdByOperationId: 'op-1',
    vouches: [], ceilings: [], blocks: [],
    effectiveTier: 'kin', tierSource: 'direct', blocked: false, blockedBy: [],
    ...over,
  };
}

describe('block helpers', () => {
  it('ignores lifted blocks', () => {
    const record = contact({ blocks: [block(ME, 'op-lift'), block(GUARDIAN)] });
    expect(activeBlocks(record).map(b => b.blockedBy)).toEqual([GUARDIAN]);
    expect(ownBlocks(record, ME)).toEqual([]);
    expect(ownBlocks(record, GUARDIAN)).toHaveLength(1);
  });
});

describe('resolveActorRights', () => {
  it('gives an owner the full set on their own record', () => {
    const rights = resolveActorRights(contact(), { actorRole: 'owner', actorPubkey: ME });
    expect(rights.canSetTier).toBe(true);
    expect(rights.canBlock).toBe(true);
    expect(rights.canRemove).toBe(true);
    expect(rights.canVouch).toBe(false);
    expect(rights.canSetCeiling).toBe(false);
  });

  it('lets a guardian vouch and set a ceiling on a dependant record', () => {
    const rights = resolveActorRights(
      contact({ directoryId: 'dependant:0' }),
      { actorRole: 'guardian', actorPubkey: GUARDIAN },
    );
    expect(rights.canVouch).toBe(true);
    expect(rights.canSetCeiling).toBe(true);
    expect(rights.canRemove).toBe(true);
  });

  it('lets a dependant block but not vouch or cap', () => {
    const rights = resolveActorRights(contact(), { actorRole: 'dependant', actorPubkey: ME });
    expect(rights.canBlock).toBe(true);
    expect(rights.canVouch).toBe(false);
    expect(rights.canSetCeiling).toBe(false);
  });

  it('lets a dependant unblock their own block', () => {
    const record = contact({ blocks: [block(ME)], blocked: true, blockedBy: [ME] });
    const rights = resolveActorRights(record, { actorRole: 'dependant', actorPubkey: ME });
    expect(rights.canUnblock).toBe(true);
    expect(rights.unblockBlockedReason).toBeNull();
  });

  it('refuses a dependant unblocking a guardian block, with the guardian copy', () => {
    const record = contact({ blocks: [block(GUARDIAN)], blocked: true, blockedBy: [GUARDIAN] });
    const rights = resolveActorRights(record, { actorRole: 'dependant', actorPubkey: ME });
    expect(rights.canUnblock).toBe(false);
    expect(rights.unblockBlockedReason).toBe('A guardian applied this block');
  });

  it('refuses a guardian clearing another guardian block', () => {
    const record = contact({
      directoryId: 'dependant:0', blocks: [block(GUARDIAN)], blocked: true, blockedBy: [GUARDIAN],
    });
    const rights = resolveActorRights(record, { actorRole: 'guardian', actorPubkey: ME }, [ME, GUARDIAN]);
    expect(rights.canUnblock).toBe(false);
    expect(rights.unblockBlockedReason).toBe('Another guardian applied this block');
  });

  // M7
  it('refuses a guardian clearing a block the DEPENDANT applied themselves, with the dependant copy', () => {
    const DEPENDANT_PK = '3'.repeat(64);
    const record = contact({
      directoryId: 'dependant:0', blocks: [block(DEPENDANT_PK)], blocked: true, blockedBy: [DEPENDANT_PK],
    });
    // Only ME is an active guardian on this directory — DEPENDANT_PK is not.
    const rights = resolveActorRights(record, { actorRole: 'guardian', actorPubkey: ME }, [ME]);
    expect(rights.canUnblock).toBe(false);
    expect(rights.unblockBlockedReason).toBe('They applied this block themselves');
  });

  it('defaults to the dependant copy (never crashes) when activeGuardianPubkeys is omitted', () => {
    // A caller that forgets to pass the guardian list gets a well-defined,
    // if imprecise, answer rather than a throw — every non-actor blocker
    // reads as "not a known guardian" against the default empty set (still
    // gated on the directory being a `dependant:*` one — see N2 below).
    const record = contact({
      directoryId: 'dependant:0', blocks: [block(GUARDIAN)], blocked: true, blockedBy: [GUARDIAN],
    });
    const rights = resolveActorRights(record, { actorRole: 'guardian', actorPubkey: ME });
    expect(rights.unblockBlockedReason).toBe('They applied this block themselves');
  });

  // N2: `guardianPubkeysFor` (App.tsx) returns at most one pubkey, so a
  // non-actor blocker routinely falls outside `activeGuardianPubkeys` even
  // when it genuinely IS a co-guardian (joint guardianship) or, worse, when
  // the record lives in the OWNER's own directory — which has no dependant
  // to have authored anything. The dependant copy is now gated on the
  // directory actually being a `dependant:*` one.
  it('never reads a non-actor block in the OWNER\'s own directory as a dependant\'s own block', () => {
    const record = contact({
      directoryId: 'owner', blocks: [block(GUARDIAN)], blocked: true, blockedBy: [GUARDIAN],
    });
    // GUARDIAN is not in the (empty) guardian set — the exact shape of the
    // real bug this guards against — but the owner directory can never have
    // a dependant author.
    const rights = resolveActorRights(record, { actorRole: 'guardian', actorPubkey: ME });
    expect(rights.unblockBlockedReason).toBe('Another guardian applied this block');
  });

  it('refuses unblock when only one of two blocks is the actor own', () => {
    const record = contact({
      blocks: [block(ME), block(GUARDIAN)], blocked: true, blockedBy: [ME, GUARDIAN],
    });
    const rights = resolveActorRights(record, { actorRole: 'owner', actorPubkey: ME });
    expect(rights.canUnblock).toBe(false);
  });

  it('turns every edit off on a removed record', () => {
    const rights = resolveActorRights(
      contact({ lifecycle: 'removed', removedAt: 99 }),
      { actorRole: 'owner', actorPubkey: ME },
    );
    expect(rights.canRename).toBe(false);
    expect(rights.canBlock).toBe(false);
    expect(rights.canRemove).toBe(false);
  });

  it('gives an app actor nothing', () => {
    const rights = resolveActorRights(contact(), { actorRole: 'app', actorPubkey: ME });
    expect(Object.values(rights).filter(v => v === true)).toHaveLength(0);
  });
});
