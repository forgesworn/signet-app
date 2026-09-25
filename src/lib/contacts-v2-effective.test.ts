import { describe, it, expect } from 'vitest';
import { resolveEffective, resolveEffectiveDirectory, type EffectiveContext } from './contacts-v2-effective';
import type { ContactRecord } from '../types';

const GUARDIAN_A = '1'.repeat(64);
const GUARDIAN_B = '2'.repeat(64);
const DEPARTED = '3'.repeat(64);

function record(overrides: Partial<ContactRecord> = {}): ContactRecord {
  return {
    directoryId: 'dependant:0',
    contactId: '0'.repeat(32),
    type: 'person',
    displayName: 'Dave',
    tier: 'ken',
    roles: [],
    identities: [],
    contactMethods: [],
    accessGrants: [],
    lifecycle: 'active',
    createdAt: 1,
    updatedAt: 1,
    createdByActorRole: 'guardian',
    createdByOperationId: 'a'.repeat(32),
    vouches: [],
    ceilings: [],
    blocks: [],
    ...overrides,
  };
}

const ctx = (over: Partial<EffectiveContext> = {}): EffectiveContext => ({
  activeGuardianPubkeys: [GUARDIAN_A, GUARDIAN_B],
  defaultChildCeiling: 'ken',
  directoryIsDependant: true,
  ...over,
});

const vouch = (guardianPubkey: string, tier: 'kin' | 'kith' | 'ken', revoked?: string) => ({
  vouchId: '9'.repeat(32), guardianPubkey, tier, createdAt: 1, operationId: '9'.repeat(32),
  ...(revoked ? { revokedByOperationId: revoked } : {}),
});

const ceiling = (guardianPubkey: string, maxTier: 'kin' | 'kith' | 'ken' | 'none', revoked?: string) => ({
  guardianPubkey, maxTier, createdAt: 1, operationId: 'c'.repeat(32),
  ...(revoked ? { revokedByOperationId: revoked } : {}),
});

describe('strongest valid evidence', () => {
  it('uses the owner direct tier when it beats every vouch', () => {
    const r = resolveEffective(record({ tier: 'kin', createdByActorRole: 'guardian' }), ctx());
    expect(r.effectiveTier).toBe('kin');
    expect(r.tierSource).toBe('direct');
  });

  it('uses a stronger guardian vouch and says so', () => {
    const r = resolveEffective(
      record({ tier: 'ken', vouches: [vouch(GUARDIAN_A, 'kin')] }),
      ctx(),
    );
    expect(r.effectiveTier).toBe('kin');
    expect(r.tierSource).toBe('guardian-vouched');
  });

  it('ignores a revoked vouch', () => {
    const r = resolveEffective(
      record({ tier: 'kith', createdByActorRole: 'guardian', vouches: [vouch(GUARDIAN_A, 'kin', '7'.repeat(32))] }),
      ctx(),
    );
    expect(r.effectiveTier).toBe('kith');
    expect(r.tierSource).toBe('direct');
  });

  it('ignores a vouch from a pubkey that is no longer an active guardian', () => {
    const r = resolveEffective(
      record({ tier: 'ken', createdByActorRole: 'guardian', vouches: [vouch(DEPARTED, 'kin')] }),
      ctx(),
    );
    expect(r.effectiveTier).toBe('ken');
    expect(r.tierSource).toBe('direct');
  });
});

describe('ceilings', () => {
  it('applies the most restrictive active ceiling', () => {
    const r = resolveEffective(
      record({ tier: 'kin', createdByActorRole: 'guardian', ceilings: [ceiling(GUARDIAN_A, 'kith'), ceiling(GUARDIAN_B, 'ken')] }),
      ctx(),
    );
    expect(r.effectiveTier).toBe('ken');
    expect(r.tierSource).toBe('guardian-limited');
  });

  it('ignores a revoked ceiling and a departed guardian ceiling', () => {
    const r = resolveEffective(
      record({ tier: 'kin', createdByActorRole: 'guardian', ceilings: [ceiling(GUARDIAN_A, 'ken', '8'.repeat(32)), ceiling(DEPARTED, 'none')] }),
      ctx(),
    );
    expect(r.effectiveTier).toBe('kin');
  });

  it('can forbid every tier', () => {
    const r = resolveEffective(
      record({ tier: 'kin', createdByActorRole: 'guardian', ceilings: [ceiling(GUARDIAN_A, 'none')] }),
      ctx(),
    );
    expect(r.effectiveTier).toBe('none');
    expect(r.tierSource).toBe('guardian-limited');
  });
});

describe('default child ceiling', () => {
  it('caps a dependant-added contact at the default when no guardian vouched', () => {
    const r = resolveEffective(
      record({ tier: 'kin', createdByActorRole: 'dependant' }),
      ctx(),
    );
    expect(r.effectiveTier).toBe('ken');
    expect(r.tierSource).toBe('guardian-limited');
  });

  it('does not apply to a guardian-created contact', () => {
    const r = resolveEffective(record({ tier: 'kin', createdByActorRole: 'guardian' }), ctx());
    expect(r.effectiveTier).toBe('kin');
  });

  it('does not apply once a guardian has vouched', () => {
    const r = resolveEffective(
      record({ tier: 'kin', createdByActorRole: 'dependant', vouches: [vouch(GUARDIAN_A, 'kin')] }),
      ctx(),
    );
    expect(r.effectiveTier).toBe('kin');
    expect(r.tierSource).toBe('guardian-vouched');
  });

  // I1: a vouch is independent evidence and is taken AT ITS OWN TIER. It does
  // not hand the child's own (capped) `'kin'` back to them at any tier the
  // guardian happens to state.
  it('lifts a child-assigned kin only to the tier a kith vouch actually states', () => {
    const r = resolveEffective(
      record({ tier: 'kin', createdByActorRole: 'dependant', vouches: [vouch(GUARDIAN_A, 'kith')] }),
      ctx(),
    );
    expect(r.effectiveTier).toBe('kith');
    expect(r.tierSource).toBe('guardian-vouched');
  });

  it('leaves a child-assigned kin at ken when the vouch itself is only ken', () => {
    const r = resolveEffective(
      record({ tier: 'kin', createdByActorRole: 'dependant', vouches: [vouch(GUARDIAN_A, 'ken')] }),
      ctx(),
    );
    expect(r.effectiveTier).toBe('ken');
    expect(r.tierSource).toBe('guardian-vouched');
  });

  it('takes the strongest of several vouches over the capped own tier', () => {
    const r = resolveEffective(
      record({
        tier: 'kin',
        createdByActorRole: 'dependant',
        vouches: [vouch(GUARDIAN_A, 'ken'), { ...vouch(GUARDIAN_B, 'kith'), vouchId: '8'.repeat(32), operationId: '8'.repeat(32) }],
      }),
      ctx(),
    );
    expect(r.effectiveTier).toBe('kith');
  });

  it('still lets an explicit guardian ceiling win over a vouch', () => {
    const r = resolveEffective(
      record({
        tier: 'kin',
        createdByActorRole: 'dependant',
        vouches: [vouch(GUARDIAN_A, 'kin')],
        ceilings: [ceiling(GUARDIAN_B, 'kith')],
      }),
      ctx(),
    );
    expect(r.effectiveTier).toBe('kith');
    expect(r.tierSource).toBe('guardian-limited');
  });

  it('does not apply in the owner directory', () => {
    const r = resolveEffective(
      record({ directoryId: 'owner', tier: 'kin', createdByActorRole: 'owner' }),
      ctx({ directoryIsDependant: false }),
    );
    expect(r.effectiveTier).toBe('kin');
  });

  it('honours a configured ceiling other than ken', () => {
    const r = resolveEffective(
      record({ tier: 'kin', createdByActorRole: 'dependant' }),
      ctx({ defaultChildCeiling: 'kith' }),
    );
    expect(r.effectiveTier).toBe('kith');
  });
});

describe('blocked overrides everything', () => {
  it('reports blocked and every blocking authority while keeping the tier facts', () => {
    const r = resolveEffective(
      record({
        tier: 'kin',
        createdByActorRole: 'guardian',
        blocks: [
          { blockedBy: GUARDIAN_A, scope: { kind: 'contact' }, blockedAt: 2, operationId: 'b'.repeat(32) },
          { blockedBy: GUARDIAN_B, scope: { kind: 'contact' }, blockedAt: 3, operationId: 'd'.repeat(32), liftedByOperationId: 'e'.repeat(32) },
        ],
      }),
      ctx(),
    );
    expect(r.blocked).toBe(true);
    expect(r.blockedBy).toEqual([GUARDIAN_A]);
    expect(r.tier).toBe('kin');           // the underlying fact is preserved
    expect(r.effectiveTier).toBe('kin');  // blocked is a separate status, not a tier
  });

  // I3: the asymmetry is deliberate. A departed guardian's vouch and ceiling
  // are ignored (standing permissions), but their block stands until its own
  // author lifts it — §7.10 gives nobody else that power, so dropping it here
  // would silently unblock the contact.
  it('still blocks on a departed guardian block, though their ceiling is ignored', () => {
    const r = resolveEffective(
      record({
        tier: 'kin',
        createdByActorRole: 'guardian',
        ceilings: [ceiling(DEPARTED, 'none')],
        blocks: [{ blockedBy: DEPARTED, scope: { kind: 'contact' }, blockedAt: 2, operationId: 'b'.repeat(32) }],
      }),
      ctx(),
    );
    expect(r.effectiveTier).toBe('kin');   // the departed guardian's ceiling is ignored
    expect(r.blocked).toBe(true);          // their block is not
    expect(r.blockedBy).toEqual([DEPARTED]);
  });

  it('is not blocked once every block is lifted', () => {
    const r = resolveEffective(
      record({ blocks: [{ blockedBy: GUARDIAN_A, scope: { kind: 'contact' }, blockedAt: 2, operationId: 'b'.repeat(32), liftedByOperationId: 'f'.repeat(32) }] }),
      ctx(),
    );
    expect(r.blocked).toBe(false);
    expect(r.blockedBy).toEqual([]);
  });
});

describe('resolveEffectiveDirectory', () => {
  it('resolves each record against its own creating actor', () => {
    const out = resolveEffectiveDirectory([
      record({ contactId: '1'.repeat(32), tier: 'kin', createdByActorRole: 'dependant' }),
      record({ contactId: '2'.repeat(32), tier: 'kin', createdByActorRole: 'guardian' }),
    ], ctx());
    expect(out.map(r => r.effectiveTier)).toEqual(['ken', 'kin']);
  });

  it('lets an explicit creatingActorRole override the record', () => {
    const out = resolveEffectiveDirectory(
      [record({ tier: 'kin', createdByActorRole: 'guardian' })],
      ctx({ creatingActorRole: 'dependant' }),
    );
    expect(out[0].effectiveTier).toBe('ken');
  });
});

describe('an app-created contact is capped at ken (R-7)', () => {
  const appCtx = ctx({ directoryIsDependant: false });

  it('holds in the OWNER’s own directory, where the child ceiling does not apply', () => {
    const rec = record({ tier: 'kin', createdByActorRole: 'app' });
    const resolved = resolveEffective(rec, appCtx);
    expect(resolved.effectiveTier).toBe('ken');
    expect(resolved.tierSource).toBe('guardian-limited');
  });

  it('holds in a dependant directory too', () => {
    const rec = record({ tier: 'kin', createdByActorRole: 'app' });
    expect(resolveEffective(rec, { ...appCtx, directoryIsDependant: true }).effectiveTier).toBe('ken');
  });

  it('does not cap a contact the owner added themselves', () => {
    expect(resolveEffective(record({ tier: 'kin', createdByActorRole: 'owner' }), appCtx).effectiveTier).toBe('kin');
  });

  it('is independent evidence, not a wholesale lift: a guardian vouch is taken at its own tier', () => {
    const rec = record({
      tier: 'kin', createdByActorRole: 'app',
      vouches: [vouch(GUARDIAN_A, 'kith')],
    });
    expect(resolveEffective(rec, appCtx).effectiveTier).toBe('kith');
  });
});
