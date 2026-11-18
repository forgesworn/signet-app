/**
 * Child mode on the guardian's phone is the child acting (R-CHILD-MODE
 * reversed 2026-11-18): the same operations authored through the child-mode
 * scope and through a paired-child install of the same dependant must fold to
 * the same effective records, with the child ceiling, a guardian's block and
 * the `set-picture` refusal applying to both.
 */
import { describe, it, expect } from 'vitest';
import { resolveContactsScope, scopeEffectiveContext, contactsScopeActorPubkey } from './contacts-v2-scope';
import { buildOperation, type MutationActor } from './contacts-v2-mutations';
import { applyOperations, validateOperation } from './contacts-v2-reducer';
import { resolveEffectiveDirectory } from './contacts-v2-effective';
import { resolveActorRights } from './contacts-v2-rights';
import { contactInviteDecision } from './contact-invite-policy';
import type { ContactOperation } from '../types';

const GUARDIAN = '1'.repeat(64);
const KID = 'd'.repeat(64);
const STRANGER = '3'.repeat(64);
const DEVICE = 'e'.repeat(32);
const ID = (c: string) => c.repeat(32);

/** The scope and author a surface resolves to, the way App.tsx wires them. */
function surface(mode: 'child-mode' | 'paired-child' | 'guardian-on-dependant-row') {
  const scope = mode === 'paired-child'
    ? resolveContactsScope({ signingMode: 'paired-child', identityId: KID, activeDependant: null, childModeNow: 'off', childDependantId: null, dependantCount: 0 })
    : resolveContactsScope({
      signingMode: 'local', identityId: null, activeDependant: { id: KID, displayName: 'Sam' },
      childModeNow: mode === 'child-mode' ? 'on' : 'off', childDependantId: mode === 'child-mode' ? KID : null, dependantCount: 1,
    });
  const actorPubkey = contactsScopeActorPubkey({
    childModeNow: mode === 'child-mode' ? 'on' : 'off', childDependantId: mode === 'child-mode' ? KID : null,
    isPairedChild: mode === 'paired-child',
    // `contactsActorPubkey`: the paired child's own id, else the guardian's stable pubkey.
    actorPubkey: mode === 'paired-child' ? KID : GUARDIAN,
  });
  const actor: MutationActor = { actorPubkey, actorRole: scope.actorRole, actorDeviceId: DEVICE };
  const context = scopeEffectiveContext(scope, [GUARDIAN], 'ken');
  return { scope, actor, context };
}

/** The same user actions, authored by `author`, with a guardian block in between. */
function sequence(directoryId: string, author: MutationActor): ContactOperation[] {
  const guardian: MutationActor = { actorPubkey: GUARDIAN, actorRole: 'guardian', actorDeviceId: DEVICE };
  const build = (p: Parameters<typeof buildOperation>[0]) => buildOperation(p);
  return [
    build({ directoryId, contactId: ID('a'), action: 'add', value: { type: 'person', displayName: 'Ada', tier: 'kin' }, clock: 1, actor: author, now: 1, operationId: ID('1') }),
    build({ directoryId, contactId: ID('b'), action: 'add', value: { type: 'person', displayName: 'Bo', tier: 'kith' }, clock: 2, actor: author, now: 2, operationId: ID('2') }),
    // The guardian blocks Bo; the child tries to lift it.
    build({ directoryId, contactId: ID('b'), action: 'block', value: { scope: { kind: 'contact' } }, clock: 3, actor: guardian, now: 3, operationId: ID('3') }),
    build({ directoryId, contactId: ID('b'), action: 'unblock', value: {}, targetOperationId: ID('3'), clock: 4, actor: author, now: 4, operationId: ID('4') }),
    // A later tier raise by the child stays capped too.
    build({ directoryId, contactId: ID('a'), action: 'set-tier', value: { tier: 'kin' }, clock: 5, actor: author, now: 5, operationId: ID('5') }),
  ];
}

function fold(ops: ContactOperation[], context: ReturnType<typeof surface>['context']) {
  return resolveEffectiveDirectory(applyOperations(ops).values(), context);
}

describe('child mode authors exactly what a paired child would', () => {
  const child = surface('child-mode');
  const paired = surface('paired-child');

  it('resolves to the same directory, role and author as a paired-child install', () => {
    expect(child.scope.directoryId).toBe(paired.scope.directoryId);
    expect(child.actor).toEqual(paired.actor);
    expect(child.actor.actorRole).toBe('dependant');
    expect(child.actor.actorPubkey).toBe(KID);
  });

  it('folds the same operations to the same effective records', () => {
    const viaChild = fold(sequence(child.scope.directoryId!, child.actor), child.context);
    const viaPaired = fold(sequence(paired.scope.directoryId!, paired.actor), paired.context);
    expect(viaChild).toEqual(viaPaired);
  });

  it('caps the tier at the default child ceiling and keeps the guardian block', () => {
    const [ada, bo] = fold(sequence(child.scope.directoryId!, child.actor), child.context)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    expect(ada.tier).toBe('kin');
    expect(ada.effectiveTier).toBe('ken');
    expect(ada.tierSource).toBe('guardian-limited');
    expect(bo.effectiveTier).toBe('ken');
    // The child's unblock of the guardian's block did nothing.
    expect(bo.blocked).toBe(true);
    expect(bo.blockedBy).toEqual([GUARDIAN]);
  });

  it('gives the child no vouch, ceiling or unblock rights, and the guardian-block lock copy', () => {
    const [, bo] = fold(sequence(child.scope.directoryId!, child.actor), child.context)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    const viaChild = resolveActorRights(bo, { actorRole: child.scope.actorRole, actorPubkey: child.actor.actorPubkey }, [GUARDIAN]);
    const viaPaired = resolveActorRights(bo, { actorRole: paired.scope.actorRole, actorPubkey: paired.actor.actorPubkey }, [GUARDIAN]);
    expect(viaChild).toEqual(viaPaired);
    expect(viaChild.canVouch).toBe(false);
    expect(viaChild.canSetCeiling).toBe(false);
    expect(viaChild.canUnblock).toBe(false);
    expect(viaChild.unblockBlockedReason).toBeTruthy();
  });

  it('refuses set-picture and clear-picture from the child-mode author, as from a paired child', () => {
    const pointer = { server: 'https://nostr.download', hash: 'ab12'.repeat(16), key: 'c0de'.repeat(16), plainHash: '5eed'.repeat(16) };
    for (const surf of [child, paired]) {
      const set = buildOperation({ directoryId: surf.scope.directoryId!, contactId: ID('a'), action: 'set-picture', value: pointer, clock: 9, actor: surf.actor, now: 9, operationId: ID('9') });
      const clear = buildOperation({ directoryId: surf.scope.directoryId!, contactId: ID('a'), action: 'clear-picture', value: {}, clock: 10, actor: surf.actor, now: 10, operationId: ID('8') });
      expect(validateOperation(set)).toBe(false);
      expect(validateOperation(clear)).toBe(false);
    }
  });

  it('a guardian on a dependant row with child mode off still stamps guardian and is not capped', () => {
    const guardianRow = surface('guardian-on-dependant-row');
    expect(guardianRow.actor).toEqual({ actorPubkey: GUARDIAN, actorRole: 'guardian', actorDeviceId: DEVICE });
    const add = buildOperation({ directoryId: guardianRow.scope.directoryId!, contactId: ID('a'), action: 'add', value: { type: 'person', displayName: 'Ada', tier: 'kin' }, clock: 1, actor: guardianRow.actor, now: 1, operationId: ID('1') });
    const [ada] = fold([add], guardianRow.context);
    expect(ada.effectiveTier).toBe('kin');
  });
});

describe('a Kin add in child mode does not pass the kin-only invite policy', () => {
  const addAda = (actor: MutationActor, directoryId: string) => buildOperation({
    directoryId, contactId: ID('a'), action: 'add', value: { type: 'person', displayName: 'Stranger', tier: 'kin' },
    clock: 1, actor, now: 1, operationId: ID('1'),
  });
  const withIdentity = (op: ContactOperation): ContactOperation[] => [op, buildOperation({
    directoryId: op.directoryId, contactId: op.contactId, action: 'add-identity',
    value: { itemId: ID('7'), pubkey: STRANGER, provenance: 'direct', verification: 'unverified' },
    clock: 2, actor: { actorPubkey: op.actorPubkey, actorRole: op.actorRole, actorDeviceId: DEVICE }, now: 2, operationId: ID('2'), itemId: ID('7'),
  })];
  const decide = (ops: ContactOperation[], directoryId: string) => contactInviteDecision(STRANGER,
    [...applyOperations(ops).values()], { directoryId, activeGuardianPubkeys: [GUARDIAN] });

  it('denies the stranger when the child (child mode) called them Kin', () => {
    const child = surface('child-mode');
    const ops = withIdentity(addAda(child.actor, child.scope.directoryId!));
    expect(ops.every(validateOperation)).toBe(true);
    expect(decide(ops, child.scope.directoryId!)).toBe('deny');
  });

  it('still allows the stranger when a guardian on a dependant row called them Kin', () => {
    const guardianRow = surface('guardian-on-dependant-row');
    const ops = withIdentity(addAda(guardianRow.actor, guardianRow.scope.directoryId!));
    expect(decide(ops, guardianRow.scope.directoryId!)).toBe('allow');
  });
});
