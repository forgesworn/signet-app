import { describe, it, expect } from 'vitest';
import { applyOperations } from './contacts-v2-reducer';
import { mergeOps, nextClock, frontierOf } from './contacts-v2-clock';
import { resolveEffectiveDirectory } from './contacts-v2-effective';
import { buildImportOps, importOps } from './contacts-v2-import';
import { buildOperation } from './contacts-v2-mutations';
import type { ContactOperation } from '../types';

const GUARDIAN = '1'.repeat(64);
const PARTNER = '2'.repeat(64);
const DEP_NP = 'c'.repeat(64);
const PEER = '3'.repeat(64);
// A real directory id: `dependant:<the dependant's own 64-hex pubkey>`, per
// directoryIdForDependant — not a derivation-index form, which no paired-child
// device could ever compute for itself.
const DEP_DIR = `dependant:${DEP_NP}`;

/** Two guardian devices, each holding half the log, must agree on every field. */
describe('contacts v2 convergence', () => {
  it('reaches the same state from either merge order', () => {
    const plan = buildImportOps({
      contacts: [{ pubkey: PEER, ownerPubkey: DEP_NP, displayName: 'Dave', sharedSecret: 'deadbeef', verifiedAt: 1_700, relationship: 'other' }],
      kens: [],
      ownerPubkeys: [GUARDIAN],
      dependants: [{ directoryId: DEP_DIR, slotPubkeys: [DEP_NP] }],
      deviceId: 'd'.repeat(32),
      actorPubkey: GUARDIAN,
      now: 9_000,
    });
    const imported = importOps(plan);
    const contactId = plan.entries[0].contactId;
    const base = frontierOf(imported).maxClock;

    // Device A: the partner guardian imposes a ceiling of ken.
    const deviceA: ContactOperation = buildOperation({
      directoryId: DEP_DIR, contactId, action: 'ceiling', value: { guardianPubkey: PARTNER, maxTier: 'ken' },
      clock: nextClock(base, base), actor: { actorPubkey: PARTNER, actorRole: 'guardian', actorDeviceId: 'a'.repeat(32) },
      now: 10_000, operationId: 'aa'.repeat(16),
    });
    // Device B, offline, at the same clock: this guardian vouches Kin.
    const deviceB: ContactOperation = buildOperation({
      directoryId: DEP_DIR, contactId, action: 'vouch', value: { guardianPubkey: GUARDIAN, tier: 'kin' },
      clock: nextClock(base, base), actor: { actorPubkey: GUARDIAN, actorRole: 'guardian', actorDeviceId: 'b'.repeat(16) + 'b'.repeat(16) },
      now: 10_001, operationId: 'bb'.repeat(16),
    });

    const forward = mergeOps([...imported, deviceA], [deviceB]).ops;
    const backward = mergeOps([deviceB], [...imported, deviceA]).ops;
    expect(applyOperations(forward)).toEqual(applyOperations(backward));

    const ctx = { activeGuardianPubkeys: [GUARDIAN, PARTNER], defaultChildCeiling: 'ken' as const, directoryIsDependant: true };
    const [effective] = resolveEffectiveDirectory(applyOperations(forward).values(), ctx);
    // Vouched Kin, capped by the partner's active ceiling — the safety-preserving answer.
    expect(effective.effectiveTier).toBe('ken');
    expect(effective.tierSource).toBe('guardian-limited');
    expect(effective.blocked).toBe(false);
    expect(effective.tier).toBe('kin'); // the child's own direct classification survives
  });

  // T16: the tie-break half of the total order. Two devices rename the same
  // contact at the SAME Lamport clock — only `actorPubkey`, then `operationId`,
  // can decide, and both merge orders must decide the same way.
  it('breaks a same-clock tie by actor pubkey, in either merge order', () => {
    const contactId = '0'.repeat(32);
    const add = buildOperation({
      directoryId: 'owner', contactId, action: 'add', value: { type: 'person', displayName: 'Dave', tier: 'kin' },
      clock: 1, actor: { actorPubkey: GUARDIAN, actorRole: 'owner', actorDeviceId: 'd'.repeat(32) }, now: 1, operationId: 'aa'.repeat(16),
    });
    // GUARDIAN is '1'*64, PARTNER is '2'*64 — PARTNER sorts LAST and therefore
    // applies last, so their name wins regardless of arrival order or wall clock.
    const fromGuardian = buildOperation({
      directoryId: 'owner', contactId, action: 'rename', value: { displayName: 'Dave G' },
      clock: 2, actor: { actorPubkey: GUARDIAN, actorRole: 'owner', actorDeviceId: 'd'.repeat(32) }, now: 9_999, operationId: 'ff'.repeat(16),
    });
    const fromPartner = buildOperation({
      directoryId: 'owner', contactId, action: 'rename', value: { displayName: 'Dave P' },
      clock: 2, actor: { actorPubkey: PARTNER, actorRole: 'owner', actorDeviceId: 'e'.repeat(32) }, now: 1, operationId: '11'.repeat(16),
    });

    const forward = applyOperations(mergeOps([add, fromGuardian], [fromPartner]).ops);
    const backward = applyOperations(mergeOps([fromPartner], [add, fromGuardian]).ops);
    expect(forward).toEqual(backward);
    expect(forward.get(`owner/${contactId}`)!.displayName).toBe('Dave P');
  });

  it('keeps a block applied on one device after a merge with the other', () => {
    const contactId = '0'.repeat(32);
    const add = buildOperation({
      directoryId: 'owner', contactId, action: 'add', value: { type: 'person', displayName: 'Dave', tier: 'kin' },
      clock: 1, actor: { actorPubkey: GUARDIAN, actorRole: 'owner', actorDeviceId: 'd'.repeat(32) }, now: 1, operationId: 'cc'.repeat(16),
    });
    const block = buildOperation({
      directoryId: 'owner', contactId, action: 'block', value: { scope: { kind: 'contact' } },
      clock: 2, actor: { actorPubkey: GUARDIAN, actorRole: 'owner', actorDeviceId: 'd'.repeat(32) }, now: 2, operationId: 'dd'.repeat(16),
    });
    const renameElsewhere = buildOperation({
      directoryId: 'owner', contactId, action: 'rename', value: { displayName: 'Davey' },
      clock: 3, actor: { actorPubkey: GUARDIAN, actorRole: 'owner', actorDeviceId: 'e'.repeat(32) }, now: 3, operationId: 'ee'.repeat(16),
    });
    const { ops } = mergeOps([add, block], [renameElsewhere]);
    const ctx = { activeGuardianPubkeys: [GUARDIAN], defaultChildCeiling: 'ken' as const, directoryIsDependant: false };
    const [effective] = resolveEffectiveDirectory(applyOperations(ops).values(), ctx);
    expect(effective.displayName).toBe('Davey');
    expect(effective.blocked).toBe(true);
  });
});
