import { describe, it, expect } from 'vitest';
import {
  compileSlotPolicies,
  compileDependantSlotPolicy,
  compileGuardianSlotPolicy,
  buildCompilerInput,
  expectedToEscalate,
  isChildDeviceSlot,
  policyDiffersFromSlot,
  autonomousKinds,
  excludedScopes,
  SCOPE_KINDS,
  ALL_SCOPE_KINDS,
  INTERACTIVE_STAGE_METHODS,
  AUTONOMOUS_STAGE_METHODS,
  CHILD_DEVICE_LABEL,
  CHILD_DEVICE_LABEL_PREFIX,
  LOCKED_SLOT_POLICY,
  type CompilerDependant,
  type CompilerGrant,
} from './policy-compiler';
import { TOFU_SAFE_METHODS, type DeviceClientSlot } from './heartwood-mgmt-types';
import type { AutonomyStage, DependantIdentity } from '../types';
import type { RememberedGrant } from '../types/grants';

/**
 * C3 compiler tests — one per plan bullet (Task 3 "Tests:") plus edges.
 * Policy code: cases are spelled out rather than looped so a one-line
 * regression is caught by a named test, not hidden inside a matrix pass.
 */

const NP = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);
const EXTRA = 'c'.repeat(64);
const GUARDIAN_CLIENT = 'd'.repeat(64);
const STRANGER = 'e'.repeat(64);

const ALL_KINDS = [0, 1, 4, 7, 13, 1059, 9734, 21235, 21236, 24242];

function slot(overrides: Partial<DeviceClientSlot> = {}): DeviceClientSlot {
  return {
    slotIndex: 1,
    label: 'MySignet',
    secretFingerprint: 'f'.repeat(64),
    autoApprove: false,
    signingApproved: false,
    strictPermissions: true,
    currentPubkey: null,
    authorizedPubkeys: [],
    allowedKinds: [],
    allowedMethods: [],
    escalate: false,
    petitionOnDeny: false,
    auditChildWrap: false,
    boundIdentity: NP,
    ...overrides,
  };
}

function grant(overrides: Partial<CompilerGrant> = {}): CompilerGrant {
  return {
    scope: 'sign-in',
    decision: 'allow',
    hasSchedule: false,
    tombstoned: false,
    expired: false,
    ...overrides,
  };
}

function dep(overrides: Partial<CompilerDependant> = {}): CompilerDependant {
  return {
    id: NP,
    identityPubkeys: [NP, PERSONA, EXTRA],
    dormantIdentityPubkeys: [],
    autonomyStage: 'autonomous-alerts',
    hasDefaultSchedule: false,
    auditVisible: true,
    petitionOnDeny: false,
    grants: [],
    ...overrides,
  };
}

const STAGES: AutonomyStage[] = [
  'full-control',
  'request-approve',
  'autonomous-alerts',
  'autonomous-logging',
  'full-autonomy',
];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('SCOPE_KINDS', () => {
  it('maps every scope exactly per the design table', () => {
    expect(SCOPE_KINDS['sign-in']).toEqual([21236]);
    expect(SCOPE_KINDS['venue-entry']).toEqual([21235]);
    expect(SCOPE_KINDS['post-public']).toEqual([1]);
    expect(SCOPE_KINDS['react-zap-reply']).toEqual([1, 7, 9734]);
    expect(SCOPE_KINDS['dm-private']).toEqual([4, 13, 1059]);
    expect(SCOPE_KINDS['upload-photo']).toEqual([24242]);
    expect(SCOPE_KINDS['mutate-identity']).toEqual([0]);
  });

  it('never lists pair-device (24133) or 31000', () => {
    expect(SCOPE_KINDS['pair-device']).toBeUndefined();
    for (const kinds of Object.values(SCOPE_KINDS)) {
      expect(kinds).not.toContain(24133);
      expect(kinds).not.toContain(31000);
    }
    expect(ALL_SCOPE_KINDS).not.toContain(24133);
    expect(ALL_SCOPE_KINDS).not.toContain(31000);
  });

  it('ALL_SCOPE_KINDS is the sorted, deduped union', () => {
    expect([...ALL_SCOPE_KINDS]).toEqual(ALL_KINDS);
  });
});

// ---------------------------------------------------------------------------
// §3.1 stage table — one test per row
// ---------------------------------------------------------------------------

describe('dependant slot — stage table', () => {
  it('full-control: get_public_key+sign_event, kinds [], auto false, escalate true', () => {
    const p = compileDependantSlotPolicy(dep({ autonomyStage: 'full-control' }), slot());
    expect(p.allowedMethods).toEqual(['get_public_key', 'sign_event']);
    expect(p.allowedKinds).toEqual([]);
    expect(p.autoApprove).toBe(false);
    expect(p.escalate).toBe(true);
    expect(expectedToEscalate(p)).toBe(true);
  });

  it('request-approve: get_public_key+sign_event, kinds [], auto false, escalate true', () => {
    const p = compileDependantSlotPolicy(dep({ autonomyStage: 'request-approve' }), slot());
    expect(p.allowedMethods).toEqual(['get_public_key', 'sign_event']);
    expect(p.allowedKinds).toEqual([]);
    expect(p.autoApprove).toBe(false);
    expect(p.escalate).toBe(true);
  });

  it('autonomous-alerts: four methods, full kind list, auto true, escalate true', () => {
    const p = compileDependantSlotPolicy(dep({ autonomyStage: 'autonomous-alerts' }), slot());
    expect(p.allowedMethods).toEqual([
      'get_public_key',
      'sign_event',
      'nip44_encrypt',
      'nip44_decrypt',
    ]);
    expect(p.allowedKinds).toEqual(ALL_KINDS);
    expect(p.autoApprove).toBe(true);
    expect(p.escalate).toBe(true);
    expect(expectedToEscalate(p)).toBe(false);
  });

  it('autonomous-logging: four methods, full kind list, auto true, escalate true', () => {
    const p = compileDependantSlotPolicy(dep({ autonomyStage: 'autonomous-logging' }), slot());
    expect(p.allowedMethods).toEqual([...AUTONOMOUS_STAGE_METHODS]);
    expect(p.allowedKinds).toEqual(ALL_KINDS);
    expect(p.autoApprove).toBe(true);
    expect(p.escalate).toBe(true);
  });

  it('full-autonomy with no exclusions: four methods, kinds [] (all), auto true, escalate true', () => {
    const p = compileDependantSlotPolicy(dep({ autonomyStage: 'full-autonomy' }), slot());
    expect(p.allowedMethods).toEqual([...AUTONOMOUS_STAGE_METHODS]);
    expect(p.allowedKinds).toEqual([]);
    expect(p.autoApprove).toBe(true);
    expect(p.escalate).toBe(true);
  });

  it('full-autonomy with an exclusion: explicit list minus the excluded kinds', () => {
    const p = compileDependantSlotPolicy(
      dep({
        autonomyStage: 'full-autonomy',
        grants: [grant({ scope: 'upload-photo', decision: 'deny' })],
      }),
      slot(),
    );
    expect(p.allowedKinds).toEqual(ALL_KINDS.filter((k) => k !== 24242));
    expect(p.autoApprove).toBe(true);
  });

  it('full-autonomy: an excluded scope with no kinds (pair-device deny) leaves [] (all)', () => {
    const p = compileDependantSlotPolicy(
      dep({
        autonomyStage: 'full-autonomy',
        grants: [grant({ scope: 'pair-device', decision: 'deny' })],
      }),
      slot(),
    );
    expect(p.allowedKinds).toEqual([]);
  });

  it('kinds are sorted ascending and deduped', () => {
    const p = compileDependantSlotPolicy(dep({ autonomyStage: 'autonomous-alerts' }), slot());
    const sorted = [...p.allowedKinds].sort((a, b) => a - b);
    expect(p.allowedKinds).toEqual(sorted);
    expect(new Set(p.allowedKinds).size).toBe(p.allowedKinds.length);
  });
});

// ---------------------------------------------------------------------------
// defaultSchedule interactive override — every stage
// ---------------------------------------------------------------------------

describe('defaultSchedule interactive override', () => {
  it('full-control: auto false, kinds [], two methods', () => {
    const p = compileDependantSlotPolicy(
      dep({ autonomyStage: 'full-control', hasDefaultSchedule: true }),
      slot(),
    );
    expect(p.autoApprove).toBe(false);
    expect(p.escalate).toBe(true);
    expect(p.allowedKinds).toEqual([]);
    expect(p.allowedMethods).toEqual([...INTERACTIVE_STAGE_METHODS]);
  });

  it('request-approve: auto false, kinds [], two methods', () => {
    const p = compileDependantSlotPolicy(
      dep({ autonomyStage: 'request-approve', hasDefaultSchedule: true }),
      slot(),
    );
    expect(p.autoApprove).toBe(false);
    expect(p.escalate).toBe(true);
    expect(p.allowedKinds).toEqual([]);
    expect(p.allowedMethods).toEqual([...INTERACTIVE_STAGE_METHODS]);
  });

  it('autonomous-alerts: auto false, kinds [], nip44 kept', () => {
    const p = compileDependantSlotPolicy(
      dep({ autonomyStage: 'autonomous-alerts', hasDefaultSchedule: true }),
      slot(),
    );
    expect(p.autoApprove).toBe(false);
    expect(p.escalate).toBe(true);
    expect(p.allowedKinds).toEqual([]);
    expect(p.allowedMethods).toEqual([...AUTONOMOUS_STAGE_METHODS]);
    expect(expectedToEscalate(p)).toBe(true);
  });

  it('autonomous-logging: auto false, kinds [], nip44 kept', () => {
    const p = compileDependantSlotPolicy(
      dep({ autonomyStage: 'autonomous-logging', hasDefaultSchedule: true }),
      slot(),
    );
    expect(p.autoApprove).toBe(false);
    expect(p.escalate).toBe(true);
    expect(p.allowedKinds).toEqual([]);
    expect(p.allowedMethods).toEqual([...AUTONOMOUS_STAGE_METHODS]);
  });

  it('full-autonomy: auto false, kinds [], nip44 kept — even with grants that would exclude', () => {
    const p = compileDependantSlotPolicy(
      dep({
        autonomyStage: 'full-autonomy',
        hasDefaultSchedule: true,
        grants: [grant({ scope: 'dm-private', decision: 'deny' })],
      }),
      slot(),
    );
    expect(p.autoApprove).toBe(false);
    expect(p.escalate).toBe(true);
    expect(p.allowedKinds).toEqual([]);
    expect(p.allowedMethods).toEqual([...AUTONOMOUS_STAGE_METHODS]);
  });

  it('every stage under defaultSchedule is expectedToEscalate', () => {
    for (const stage of STAGES) {
      const p = compileDependantSlotPolicy(
        dep({ autonomyStage: stage, hasDefaultSchedule: true }),
        slot(),
      );
      expect(expectedToEscalate(p), stage).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

describe('exclusions at autonomous stages', () => {
  it('a per-origin scheduled allow-grant excludes its scope kinds', () => {
    const p = compileDependantSlotPolicy(
      dep({
        autonomyStage: 'autonomous-alerts',
        grants: [grant({ scope: 'dm-private', decision: 'allow', hasSchedule: true })],
      }),
      slot(),
    );
    expect(p.allowedKinds).toEqual(ALL_KINDS.filter((k) => ![4, 13, 1059].includes(k)));
    expect(p.autoApprove).toBe(true);
  });

  it('a schedule-free allow-grant excludes nothing', () => {
    const p = compileDependantSlotPolicy(
      dep({
        autonomyStage: 'autonomous-alerts',
        grants: [grant({ scope: 'dm-private', decision: 'allow' })],
      }),
      slot(),
    );
    expect(p.allowedKinds).toEqual(ALL_KINDS);
  });

  it('a deny grant excludes its scope kinds', () => {
    const p = compileDependantSlotPolicy(
      dep({
        autonomyStage: 'autonomous-logging',
        grants: [grant({ scope: 'sign-in', decision: 'deny' })],
      }),
      slot(),
    );
    expect(p.allowedKinds).toEqual(ALL_KINDS.filter((k) => k !== 21236));
  });

  it('tombstoned grants are ignored', () => {
    const p = compileDependantSlotPolicy(
      dep({
        autonomyStage: 'autonomous-alerts',
        grants: [
          grant({ scope: 'sign-in', decision: 'deny', tombstoned: true }),
          grant({ scope: 'dm-private', decision: 'allow', hasSchedule: true, tombstoned: true }),
        ],
      }),
      slot(),
    );
    expect(p.allowedKinds).toEqual(ALL_KINDS);
  });

  it('expired grants are ignored', () => {
    const p = compileDependantSlotPolicy(
      dep({
        autonomyStage: 'autonomous-alerts',
        grants: [
          grant({ scope: 'sign-in', decision: 'deny', expired: true }),
          grant({ scope: 'dm-private', decision: 'allow', hasSchedule: true, expired: true }),
        ],
      }),
      slot(),
    );
    expect(p.allowedKinds).toEqual(ALL_KINDS);
  });

  it('kind-1 shared-scope: excluding post-public removes kind 1 even though react-zap-reply keeps it', () => {
    const p = compileDependantSlotPolicy(
      dep({
        autonomyStage: 'autonomous-alerts',
        grants: [grant({ scope: 'post-public', decision: 'deny' })],
      }),
      slot(),
    );
    expect(p.allowedKinds).not.toContain(1);
    // react-zap-reply's other kinds survive
    expect(p.allowedKinds).toContain(7);
    expect(p.allowedKinds).toContain(9734);
  });

  it('kind-1 shared-scope: excluding react-zap-reply removes 1, 7 and 9734 (post-public loses kind 1 too)', () => {
    const p = compileDependantSlotPolicy(
      dep({
        autonomyStage: 'autonomous-alerts',
        grants: [grant({ scope: 'react-zap-reply', decision: 'allow', hasSchedule: true })],
      }),
      slot(),
    );
    expect(p.allowedKinds).toEqual(ALL_KINDS.filter((k) => ![1, 7, 9734].includes(k)));
  });

  it('exclusions do not apply at interactive stages (kinds stay [])', () => {
    for (const stage of ['full-control', 'request-approve'] as AutonomyStage[]) {
      const p = compileDependantSlotPolicy(
        dep({
          autonomyStage: stage,
          grants: [grant({ scope: 'sign-in', decision: 'deny' })],
        }),
        slot(),
      );
      expect(p.allowedKinds, stage).toEqual([]);
      expect(p.autoApprove, stage).toBe(false);
    }
  });

  it('a mix of active and inactive grants excludes only the active ones', () => {
    const p = compileDependantSlotPolicy(
      dep({
        autonomyStage: 'autonomous-alerts',
        grants: [
          grant({ scope: 'sign-in', decision: 'deny', tombstoned: true }),
          grant({ scope: 'upload-photo', decision: 'deny' }),
          grant({ scope: 'venue-entry', decision: 'allow', hasSchedule: true, expired: true }),
          grant({ scope: 'mutate-identity', decision: 'allow', hasSchedule: true }),
        ],
      }),
      slot(),
    );
    expect(p.allowedKinds).toEqual(ALL_KINDS.filter((k) => ![24242, 0].includes(k)));
  });

  it('excludedScopes / autonomousKinds helpers agree with the policy', () => {
    const grants = [
      grant({ scope: 'sign-in', decision: 'deny' }),
      grant({ scope: 'post-public', decision: 'allow' }),
    ];
    expect([...excludedScopes(grants)]).toEqual(['sign-in']);
    const { kinds, exclusionApplied } = autonomousKinds(grants);
    expect(exclusionApplied).toBe(true);
    expect(kinds).toEqual(ALL_KINDS.filter((k) => k !== 21236));
    expect(autonomousKinds([]).exclusionApplied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 24133 / 31000 never present
// ---------------------------------------------------------------------------

describe('never-listed kinds', () => {
  it('24133 and 31000 never appear at any stage, with or without grants', () => {
    const grantSets: CompilerGrant[][] = [
      [],
      [grant({ scope: 'pair-device', decision: 'allow' })],
      [grant({ scope: 'sign-in', decision: 'deny' })],
    ];
    for (const stage of STAGES) {
      for (const grants of grantSets) {
        const p = compileDependantSlotPolicy(dep({ autonomyStage: stage, grants }), slot());
        expect(p.allowedKinds, stage).not.toContain(24133);
        expect(p.allowedKinds, stage).not.toContain(31000);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// petitionOnDeny / auditChildWrap / boundIdentity
// ---------------------------------------------------------------------------

describe('dependant slot flags', () => {
  it('petitionOnDeny mirrors the dep opt-in', () => {
    expect(compileDependantSlotPolicy(dep({ petitionOnDeny: true }), slot()).petitionOnDeny).toBe(true);
    expect(compileDependantSlotPolicy(dep({ petitionOnDeny: false }), slot()).petitionOnDeny).toBe(false);
  });

  it('auditChildWrap true on a "MySignet" slot when visible', () => {
    const p = compileDependantSlotPolicy(dep({ auditVisible: true }), slot({ label: CHILD_DEVICE_LABEL }));
    expect(p.auditChildWrap).toBe(true);
    expect(p.boundIdentity).toBe(NP);
  });

  it('auditChildWrap true on a signet:child-device: prefixed slot when visible', () => {
    const p = compileDependantSlotPolicy(
      dep({ auditVisible: true }),
      slot({ label: `${CHILD_DEVICE_LABEL_PREFIX}${NP.slice(0, 8)}` }),
    );
    expect(p.auditChildWrap).toBe(true);
  });

  it('auditChildWrap false on a child-device slot when NOT visible', () => {
    const p = compileDependantSlotPolicy(dep({ auditVisible: false }), slot({ label: CHILD_DEVICE_LABEL }));
    expect(p.auditChildWrap).toBe(false);
  });

  it('auditChildWrap false on an app-pairing slot even when visible (zero-slot rule)', () => {
    const p = compileDependantSlotPolicy(dep({ auditVisible: true }), slot({ label: 'Roblox' }));
    expect(p.auditChildWrap).toBe(false);
  });

  it('boundIdentity is echoed verbatim from the slot (never re-bound)', () => {
    const p = compileDependantSlotPolicy(dep(), slot({ boundIdentity: PERSONA }));
    expect(p.boundIdentity).toBe(PERSONA);
  });

  it('boundIdentity is present whenever auditChildWrap is true', () => {
    for (const stage of STAGES) {
      const p = compileDependantSlotPolicy(
        dep({ autonomyStage: stage, auditVisible: true }),
        slot({ label: CHILD_DEVICE_LABEL, boundIdentity: EXTRA }),
      );
      if (p.auditChildWrap) expect(p.boundIdentity, stage).toBe(EXTRA);
    }
  });

  it('isChildDeviceSlot recognises the label and the prefix only', () => {
    expect(isChildDeviceSlot({ label: 'MySignet' })).toBe(true);
    expect(isChildDeviceSlot({ label: 'signet:child-device:abc' })).toBe(true);
    expect(isChildDeviceSlot({ label: 'my signet' })).toBe(false);
    expect(isChildDeviceSlot({ label: 'Roblox' })).toBe(false);
    expect(isChildDeviceSlot({ label: 'default' })).toBe(false);
    expect(isChildDeviceSlot({ label: '' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guardian slot (§3.3)
// ---------------------------------------------------------------------------

describe('guardian slot', () => {
  it('never escalates, auto true, kinds [], no petition, no child wrap, no boundIdentity', () => {
    const p = compileGuardianSlotPolicy(slot({ currentPubkey: GUARDIAN_CLIENT, boundIdentity: null }));
    expect(p.escalate).toBe(false);
    expect(p.autoApprove).toBe(true);
    expect(p.allowedKinds).toEqual([]);
    expect(p.petitionOnDeny).toBe(false);
    expect(p.auditChildWrap).toBe(false);
    expect(p.boundIdentity).toBeUndefined();
    expect('boundIdentity' in p).toBe(false);
    expect(expectedToEscalate(p)).toBe(false);
  });

  it('adds the four sync-rail methods when missing', () => {
    const p = compileGuardianSlotPolicy(slot({ currentPubkey: GUARDIAN_CLIENT, allowedMethods: [] }));
    expect(new Set(p.allowedMethods)).toEqual(
      new Set(['sign_event', 'get_public_key', 'nip44_encrypt', 'nip44_decrypt']),
    );
  });

  it('preserves heartwood_derive_persona on a non-strict slot', () => {
    const p = compileGuardianSlotPolicy(
      slot({
        currentPubkey: GUARDIAN_CLIENT,
        strictPermissions: false,
        allowedMethods: ['sign_event', 'heartwood_derive_persona'],
      }),
    );
    expect(p.allowedMethods).toContain('heartwood_derive_persona');
    expect(p.allowedMethods).toContain('nip44_encrypt');
    expect(p.allowedMethods).toContain('nip44_decrypt');
    expect(p.allowedMethods).toContain('get_public_key');
    expect(p.allowedMethods).toContain('sign_event');
    expect(new Set(p.allowedMethods).size).toBe(p.allowedMethods.length);
  });

  it('strips heartwood_derive_persona (and any non-TOFU-safe method) on a strict slot', () => {
    const p = compileGuardianSlotPolicy(
      slot({
        currentPubkey: GUARDIAN_CLIENT,
        strictPermissions: true,
        allowedMethods: ['sign_event', 'heartwood_derive_persona', 'nip04_encrypt', 'get_relays'],
      }),
    );
    expect(p.allowedMethods).not.toContain('heartwood_derive_persona');
    expect(p.allowedMethods).not.toContain('get_relays');
    expect(p.allowedMethods).toContain('nip04_encrypt');
    for (const m of p.allowedMethods) expect(TOFU_SAFE_METHODS).toContain(m);
    expect(new Set(p.allowedMethods)).toEqual(
      new Set(['sign_event', 'nip04_encrypt', 'get_public_key', 'nip44_encrypt', 'nip44_decrypt']),
    );
  });
});

// ---------------------------------------------------------------------------
// Classification / compileSlotPolicies
// ---------------------------------------------------------------------------

describe('compileSlotPolicies classification', () => {
  it('classifies guardian by currentPubkey', () => {
    const r = compileSlotPolicies({
      dependants: [dep()],
      guardianClientPubkey: GUARDIAN_CLIENT,
      deviceSlots: [slot({ slotIndex: 0, currentPubkey: GUARDIAN_CLIENT, boundIdentity: null })],
    });
    expect(r.slots).toHaveLength(1);
    expect(r.slots[0].reason).toBe('guardian');
    expect(r.slots[0].dependantId).toBeUndefined();
    expect(r.untouched).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it('classifies guardian by authorizedPubkeys', () => {
    const r = compileSlotPolicies({
      dependants: [],
      guardianClientPubkey: GUARDIAN_CLIENT,
      deviceSlots: [
        slot({ slotIndex: 0, currentPubkey: STRANGER, authorizedPubkeys: [GUARDIAN_CLIENT], boundIdentity: null }),
      ],
    });
    expect(r.slots[0].reason).toBe('guardian');
  });

  it('guardian classification wins when a slot also matches a dep identity', () => {
    const r = compileSlotPolicies({
      dependants: [dep()],
      guardianClientPubkey: GUARDIAN_CLIENT,
      deviceSlots: [slot({ slotIndex: 0, currentPubkey: GUARDIAN_CLIENT, boundIdentity: NP })],
    });
    expect(r.slots[0].reason).toBe('guardian');
    expect(r.slots[0].policy.escalate).toBe(false);
    expect(r.slots[0].policy.boundIdentity).toBeUndefined();
  });

  it('classifies dep slots by boundIdentity (NP, persona, extra) — case-insensitive', () => {
    const r = compileSlotPolicies({
      dependants: [dep()],
      guardianClientPubkey: GUARDIAN_CLIENT,
      deviceSlots: [
        slot({ slotIndex: 1, boundIdentity: NP }),
        slot({ slotIndex: 2, boundIdentity: PERSONA.toUpperCase() }),
        slot({ slotIndex: 3, boundIdentity: EXTRA }),
      ],
    });
    expect(r.slots.map((s) => s.reason)).toEqual(['dependant', 'dependant', 'dependant']);
    expect(r.slots.map((s) => s.dependantId)).toEqual([NP, NP, NP]);
    expect(r.slots.map((s) => s.slotIndex)).toEqual([1, 2, 3]);
  });

  it('routes each dep-bound slot to the right dep', () => {
    const otherNp = '1'.repeat(64);
    const r = compileSlotPolicies({
      dependants: [
        dep({ autonomyStage: 'full-control' }),
        dep({ id: otherNp, identityPubkeys: [otherNp], autonomyStage: 'full-autonomy' }),
      ],
      guardianClientPubkey: null,
      deviceSlots: [slot({ slotIndex: 1, boundIdentity: NP }), slot({ slotIndex: 2, boundIdentity: otherNp })],
    });
    expect(r.slots[0].dependantId).toBe(NP);
    expect(r.slots[0].policy.autoApprove).toBe(false);
    expect(r.slots[1].dependantId).toBe(otherNp);
    expect(r.slots[1].policy.autoApprove).toBe(true);
  });

  it('counts untouched: unbound slots, stranger-bound slots, and null-guardian primaries', () => {
    const r = compileSlotPolicies({
      dependants: [dep()],
      guardianClientPubkey: null,
      deviceSlots: [
        slot({ slotIndex: 0, currentPubkey: GUARDIAN_CLIENT, boundIdentity: null }), // would be guardian, but no pubkey known
        slot({ slotIndex: 1, boundIdentity: null }), // consumer pairing
        slot({ slotIndex: 2, boundIdentity: STRANGER }), // owner persona / not in roster
        slot({ slotIndex: 3, boundIdentity: NP }), // dep
      ],
    });
    expect(r.untouched).toBe(3);
    expect(r.slots).toHaveLength(1);
    expect(r.slots[0].slotIndex).toBe(3);
  });

  it('echoes slotIndex and secretFingerprint', () => {
    const r = compileSlotPolicies({
      dependants: [dep()],
      guardianClientPubkey: null,
      deviceSlots: [slot({ slotIndex: 7, secretFingerprint: '9'.repeat(64), boundIdentity: NP })],
    });
    expect(r.slots[0].slotIndex).toBe(7);
    expect(r.slots[0].secretFingerprint).toBe('9'.repeat(64));
  });

  it('warns when the guardian pubkey is known but no slot matches it', () => {
    const r = compileSlotPolicies({
      dependants: [],
      guardianClientPubkey: GUARDIAN_CLIENT,
      deviceSlots: [slot({ slotIndex: 1, currentPubkey: STRANGER, boundIdentity: null })],
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.untouched).toBe(1);
  });

  it('empty inventory compiles to nothing', () => {
    const r = compileSlotPolicies({ dependants: [dep()], guardianClientPubkey: null, deviceSlots: [] });
    expect(r).toEqual({ slots: [], untouched: 0, warnings: [] });
  });
});

// ---------------------------------------------------------------------------
// changed
// ---------------------------------------------------------------------------

describe('changed', () => {
  it('false when the device already matches (methods in a different order still equal)', () => {
    const r = compileSlotPolicies({
      dependants: [dep({ autonomyStage: 'autonomous-alerts', auditVisible: true })],
      guardianClientPubkey: null,
      deviceSlots: [
        slot({
          label: CHILD_DEVICE_LABEL,
          boundIdentity: NP,
          allowedMethods: ['nip44_decrypt', 'sign_event', 'nip44_encrypt', 'get_public_key'],
          allowedKinds: [24242, 21236, 21235, 9734, 1059, 13, 7, 4, 1, 0],
          autoApprove: true,
          escalate: true,
          petitionOnDeny: false,
          auditChildWrap: true,
        }),
      ],
    });
    expect(r.slots[0].changed).toBe(false);
  });

  it('false for a guardian slot that already lists the union', () => {
    const r = compileSlotPolicies({
      dependants: [],
      guardianClientPubkey: GUARDIAN_CLIENT,
      deviceSlots: [
        slot({
          currentPubkey: GUARDIAN_CLIENT,
          boundIdentity: null,
          strictPermissions: false,
          allowedMethods: ['heartwood_derive_persona', 'nip44_decrypt', 'sign_event', 'nip44_encrypt', 'get_public_key'],
          allowedKinds: [],
          autoApprove: true,
          escalate: false,
          petitionOnDeny: false,
          auditChildWrap: false,
        }),
      ],
    });
    expect(r.slots[0].changed).toBe(false);
  });

  it('true when a method is missing', () => {
    const p = compileDependantSlotPolicy(dep({ autonomyStage: 'full-control' }), slot());
    const base = { escalate: true, auditChildWrap: true };
    expect(policyDiffersFromSlot(p, slot({ ...base, allowedMethods: ['sign_event'] }))).toBe(true);
    expect(policyDiffersFromSlot(p, slot({ ...base, allowedMethods: ['sign_event', 'get_public_key'] }))).toBe(false);
  });

  it('true when kinds differ', () => {
    const p = compileDependantSlotPolicy(dep({ autonomyStage: 'autonomous-alerts' }), slot());
    const base = {
      allowedMethods: [...AUTONOMOUS_STAGE_METHODS],
      autoApprove: true,
      escalate: true,
      auditChildWrap: true,
    };
    expect(policyDiffersFromSlot(p, slot({ ...base, allowedKinds: ALL_KINDS }))).toBe(false);
    expect(policyDiffersFromSlot(p, slot({ ...base, allowedKinds: ALL_KINDS.filter((k) => k !== 1) }))).toBe(true);
    expect(policyDiffersFromSlot(p, slot({ ...base, allowedKinds: [] }))).toBe(true);
  });

  it('true when any flag differs', () => {
    const p = compileDependantSlotPolicy(dep({ autonomyStage: 'full-control', petitionOnDeny: true }), slot());
    const matching = slot({
      allowedMethods: ['get_public_key', 'sign_event'],
      autoApprove: false,
      escalate: true,
      petitionOnDeny: true,
      auditChildWrap: true,
    });
    expect(policyDiffersFromSlot(p, matching)).toBe(false);
    expect(policyDiffersFromSlot(p, { ...matching, autoApprove: true })).toBe(true);
    expect(policyDiffersFromSlot(p, { ...matching, escalate: false })).toBe(true);
    expect(policyDiffersFromSlot(p, { ...matching, petitionOnDeny: false })).toBe(true);
    expect(policyDiffersFromSlot(p, { ...matching, auditChildWrap: false })).toBe(true);
  });

  it('boundIdentity is compared only when the policy carries one', () => {
    const g = compileGuardianSlotPolicy(slot({ currentPubkey: GUARDIAN_CLIENT }));
    const listed = slot({
      currentPubkey: GUARDIAN_CLIENT,
      boundIdentity: STRANGER,
      allowedMethods: ['sign_event', 'get_public_key', 'nip44_encrypt', 'nip44_decrypt'],
      autoApprove: true,
      escalate: false,
    });
    expect(policyDiffersFromSlot(g, listed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// expectedToEscalate
// ---------------------------------------------------------------------------

describe('expectedToEscalate', () => {
  it('a slot with auto true is never expected to escalate', () => {
    expect(expectedToEscalate({ autoApprove: true, escalate: true })).toBe(false);
    expect(expectedToEscalate({ autoApprove: true, escalate: false })).toBe(false);
  });

  it('auto false + escalate true is the only reachable park path', () => {
    expect(expectedToEscalate({ autoApprove: false, escalate: true })).toBe(true);
    expect(expectedToEscalate({ autoApprove: false, escalate: false })).toBe(false);
  });

  it('every autonomous compiled dep slot (no schedule) is unreachable for C4', () => {
    for (const stage of ['autonomous-alerts', 'autonomous-logging', 'full-autonomy'] as AutonomyStage[]) {
      const p = compileDependantSlotPolicy(dep({ autonomyStage: stage }), slot());
      expect(expectedToEscalate(p), stage).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// buildCompilerInput
// ---------------------------------------------------------------------------

function appDep(overrides: Partial<DependantIdentity> = {}): DependantIdentity {
  return {
    id: NP,
    guardianPubkey: '9'.repeat(64),
    displayName: 'Kid',
    naturalPerson: { publicKey: NP.toUpperCase(), privateKey: '', displayName: 'Kid' },
    persona: { publicKey: PERSONA, privateKey: '', displayName: 'Anon' },
    extraPersonas: [
      { publicKey: EXTRA, privateKey: '', displayName: 'Extra', derivationName: 'dependant-0-persona-2' },
    ],
    derivationPath: 'dependant-0',
    createdAt: 0,
    autonomyStage: 'autonomous-alerts',
    primaryKeypair: 'natural-person',
    ...overrides,
  } as DependantIdentity;
}

function appGrant(overrides: Partial<RememberedGrant> = {}): RememberedGrant {
  return {
    dependantId: NP,
    scope: 'sign-in',
    origin: 'https://example.com',
    decision: 'allow',
    decidedAt: 100,
    ...overrides,
  };
}

describe('buildCompilerInput', () => {
  const NOW = 1_000_000;

  it('collects NP + persona + extras as lowercase identityPubkeys', () => {
    const input = buildCompilerInput({
      dependants: [appDep()],
      grants: [],
      guardianClientPubkey: GUARDIAN_CLIENT,
      deviceSlots: [],
      nowSeconds: NOW,
    });
    expect(input.dependants).toHaveLength(1);
    expect(input.dependants[0].id).toBe(NP);
    expect(input.dependants[0].identityPubkeys).toEqual([NP, PERSONA, EXTRA]);
    expect(input.guardianClientPubkey).toBe(GUARDIAN_CLIENT);
    expect(input.deviceSlots).toEqual([]);
  });

  it('carries the stage and hasDefaultSchedule', () => {
    const withSchedule = buildCompilerInput({
      dependants: [
        appDep({
          autonomyStage: 'full-autonomy',
          defaultSchedule: { v: 1, tz: 'Europe/London' } as DependantIdentity['defaultSchedule'],
        }),
      ],
      grants: [],
      guardianClientPubkey: null,
      deviceSlots: [],
      nowSeconds: NOW,
    });
    expect(withSchedule.dependants[0].autonomyStage).toBe('full-autonomy');
    expect(withSchedule.dependants[0].hasDefaultSchedule).toBe(true);

    const without = buildCompilerInput({
      dependants: [appDep()],
      grants: [],
      guardianClientPubkey: null,
      deviceSlots: [],
      nowSeconds: NOW,
    });
    expect(without.dependants[0].hasDefaultSchedule).toBe(false);
  });

  it('resolves auditVisible via resolveAuditVisibility (stage default + override)', () => {
    const build = (stage: AutonomyStage, override?: DependantIdentity['auditVisibility']) =>
      buildCompilerInput({
        dependants: [appDep({ autonomyStage: stage, auditVisibility: override })],
        grants: [],
        guardianClientPubkey: null,
        deviceSlots: [],
        nowSeconds: NOW,
      }).dependants[0].auditVisible;
    expect(build('autonomous-alerts')).toBe(true);
    expect(build('full-control')).toBe(false);
    expect(build('full-control', 'force-visible')).toBe(true);
    expect(build('full-autonomy', 'force-hidden')).toBe(false);
  });

  it('reads petitionOnDeny defensively (default false)', () => {
    const on = buildCompilerInput({
      dependants: [appDep({ petitionOnDeny: true } as Partial<DependantIdentity>)],
      grants: [],
      guardianClientPubkey: null,
      deviceSlots: [],
      nowSeconds: NOW,
    });
    expect(on.dependants[0].petitionOnDeny).toBe(true);
    const off = buildCompilerInput({
      dependants: [appDep()],
      grants: [],
      guardianClientPubkey: null,
      deviceSlots: [],
      nowSeconds: NOW,
    });
    expect(off.dependants[0].petitionOnDeny).toBe(false);
  });

  it('filters grants by dependantId and maps tombstoned / expired / hasSchedule', () => {
    const otherNp = '2'.repeat(64);
    const input = buildCompilerInput({
      dependants: [appDep(), appDep({ id: otherNp, naturalPerson: { publicKey: otherNp, privateKey: '', displayName: 'Other' } })],
      grants: [
        appGrant({ scope: 'sign-in', decision: 'allow' }),
        appGrant({ scope: 'dm-private', decision: 'deny', tombstonedAt: 500 }),
        appGrant({ scope: 'upload-photo', decision: 'allow', expiresAt: NOW - 1 }),
        appGrant({ scope: 'venue-entry', decision: 'allow', expiresAt: NOW + 1 }),
        appGrant({
          scope: 'react-zap-reply',
          decision: 'allow',
          schedule: { v: 1, tz: 'Europe/London' } as RememberedGrant['schedule'],
        }),
        appGrant({ dependantId: otherNp, scope: 'post-public', decision: 'deny' }),
      ],
      guardianClientPubkey: null,
      deviceSlots: [],
      nowSeconds: NOW,
    });
    const [me, other] = input.dependants;
    expect(me.grants).toEqual([
      { scope: 'sign-in', decision: 'allow', hasSchedule: false, tombstoned: false, expired: false },
      { scope: 'dm-private', decision: 'deny', hasSchedule: false, tombstoned: true, expired: false },
      { scope: 'upload-photo', decision: 'allow', hasSchedule: false, tombstoned: false, expired: true },
      { scope: 'venue-entry', decision: 'allow', hasSchedule: false, tombstoned: false, expired: false },
      { scope: 'react-zap-reply', decision: 'allow', hasSchedule: true, tombstoned: false, expired: false },
    ]);
    expect(other.grants).toEqual([
      { scope: 'post-public', decision: 'deny', hasSchedule: false, tombstoned: false, expired: false },
    ]);
  });

  it('a grant expiring exactly now is not yet expired', () => {
    const input = buildCompilerInput({
      dependants: [appDep()],
      grants: [appGrant({ expiresAt: NOW })],
      guardianClientPubkey: null,
      deviceSlots: [],
      nowSeconds: NOW,
    });
    expect(input.dependants[0].grants[0].expired).toBe(false);
  });

  it('end-to-end: app records → compileSlotPolicies', () => {
    const input = buildCompilerInput({
      dependants: [appDep({ autonomyStage: 'autonomous-logging' })],
      grants: [appGrant({ scope: 'dm-private', decision: 'deny' })],
      guardianClientPubkey: GUARDIAN_CLIENT,
      deviceSlots: [
        slot({ slotIndex: 0, currentPubkey: GUARDIAN_CLIENT, boundIdentity: null }),
        slot({ slotIndex: 1, label: CHILD_DEVICE_LABEL, boundIdentity: NP }),
        slot({ slotIndex: 2, label: 'Roblox', boundIdentity: PERSONA }),
        slot({ slotIndex: 3, boundIdentity: null }),
      ],
      nowSeconds: NOW,
    });
    const r = compileSlotPolicies(input);
    expect(r.untouched).toBe(1);
    expect(r.slots.map((s) => [s.slotIndex, s.reason])).toEqual([
      [0, 'guardian'],
      [1, 'dependant'],
      [2, 'dependant'],
    ]);
    const kid = r.slots[1].policy;
    expect(kid.allowedKinds).toEqual(ALL_KINDS.filter((k) => ![4, 13, 1059].includes(k)));
    expect(kid.auditChildWrap).toBe(true);
    expect(kid.boundIdentity).toBe(NP);
    const app = r.slots[2].policy;
    expect(app.auditChildWrap).toBe(false);
    expect(app.boundIdentity).toBe(PERSONA);
    expect(r.slots.every((s) => s.changed)).toBe(true);
  });
});

describe('dormant dependant NP compiles locked (spec §7.6)', () => {
  const personaFirstDep: DependantIdentity = {
    id: PERSONA,
    guardianPubkey: 'g'.repeat(64),
    displayName: 'Lily',
    naturalPerson: { publicKey: NP, privateKey: '', displayName: '' },
    persona: { publicKey: PERSONA, privateKey: '', displayName: 'Lily' },
    derivationPath: 'dependant-0',
    createdAt: 0,
    autonomyStage: 'full-autonomy',
    primaryKeypair: 'persona',
    naturalPersonActive: false,
  } as DependantIdentity;

  const input = buildCompilerInput({
    dependants: [personaFirstDep],
    grants: [],
    guardianClientPubkey: null,
    deviceSlots: [slot({ slotIndex: 1, boundIdentity: NP }), slot({ slotIndex: 2, boundIdentity: PERSONA })],
    nowSeconds: 1_700_000_000,
  });

  it('marks the dormant NP pubkey on the compiler input', () => {
    expect(input.dependants[0].dormantIdentityPubkeys).toEqual([NP]);
    expect(input.dependants[0].identityPubkeys).toContain(NP);
  });

  it('locks the NP-bound slot down to nothing', () => {
    const out = compileSlotPolicies(input);
    const npSlot = out.slots.find((s) => s.slotIndex === 1)!;
    expect(npSlot.policy.allowedMethods).toEqual([]);
    expect(npSlot.policy.allowedKinds).toEqual([]);
    expect(npSlot.policy.autoApprove).toBe(false);
    expect(npSlot.policy.escalate).toBe(false);
    expect(npSlot.policy.petitionOnDeny).toBe(false);
    expect(npSlot.policy.auditChildWrap).toBe(false);
    expect(npSlot.policy.boundIdentity).toBe(NP);
    expect(expectedToEscalate(npSlot.policy)).toBe(false);
  });

  it('leaves the persona slot on the ordinary stage policy', () => {
    const out = compileSlotPolicies(input);
    const pSlot = out.slots.find((s) => s.slotIndex === 2)!;
    expect(pSlot.policy.allowedMethods).toContain('sign_event');
    expect(pSlot.policy.autoApprove).toBe(true);
  });

  it('does not lock an activated dependant', () => {
    const active = buildCompilerInput({
      dependants: [
        {
          ...personaFirstDep,
          naturalPersonActive: true,
          naturalPerson: { ...personaFirstDep.naturalPerson, displayName: 'Lily Rivera' },
        },
      ],
      grants: [],
      guardianClientPubkey: null,
      deviceSlots: [slot({ slotIndex: 1, boundIdentity: NP })],
      nowSeconds: 1_700_000_000,
    });
    expect(active.dependants[0].dormantIdentityPubkeys).toEqual([]);
    const out = compileSlotPolicies(active);
    expect(out.slots[0].policy.allowedMethods).not.toEqual([]);
  });

  it('exports the locked policy shape as a constant', () => {
    expect(LOCKED_SLOT_POLICY).toEqual({
      allowedMethods: [],
      allowedKinds: [],
      autoApprove: false,
      escalate: false,
      petitionOnDeny: false,
      auditChildWrap: false,
    });
  });
});
