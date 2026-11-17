import { describe, it, expect } from 'vitest';
import { buildPersonaFirstDependant } from './dependant-record';
import {
  approvedForChild, childEffectiveApproval, childPressStands, childReadyRows, deviceShortNpub, PRESS_CLOCK_SKEW_MS, expectedChildPersonas, guardianOutcomeOf, guardianReadyRows,
  HEARTWOOD_SLOT_IDENTITY_CAP, identityApproved, isApprovalChanged, owedPresses, readySummary, slotGrantCount,
  type ChildApproval, type ReadyRow,
} from './child-ready-check';
import type { ClientApproval, DeviceClientSlot } from './heartwood-mgmt-types';
import type { DependantIdentity } from '../types';

const NP = 'a'.repeat(64), PERSONA = 'b'.repeat(64), EXTRA = 'c'.repeat(64);
const CHILD = 'd'.repeat(64), GUARDIAN = 'e'.repeat(64), GNP = '1'.repeat(64), MASTER = '2'.repeat(64);

function dep(over: Partial<DependantIdentity> = {}): DependantIdentity {
  const base = buildPersonaFirstDependant({ guardianPubkey: 'f'.repeat(64), enteredName: 'Lily', derivationPath: 'dependant-2',
    naturalPerson: { publicKey: NP, privateKey: '' }, persona: { publicKey: PERSONA, privateKey: '' }, createdAt: 1 });
  return {
    ...base,
    extraPersonas: [{ publicKey: EXTRA, privateKey: '', displayName: 'Gamer', derivationName: 'persona-1' }],
    childDevice: { mode: 'heartwood-direct', slotLabel: 'signet:child-device:v2:x', secretFingerprint: 'ab', slotIndex: 6,
      clientPubkey: CHILD, boundPersona: PERSONA, pairedAt: 1 },
    ...over,
  };
}
function slot(over: Partial<DeviceClientSlot>): DeviceClientSlot {
  return { slotIndex: 0, label: '', secretFingerprint: 'x', autoApprove: true, signingApproved: true, strictPermissions: true, currentPubkey: null,
    authorizedPubkeys: [], allowedKinds: [], allowedMethods: [], escalate: false, petitionOnDeny: false, auditChildWrap: false, boundIdentity: null, ...over };
}
const childSlot = (approvals?: ClientApproval[]) => slot({ slotIndex: 6, secretFingerprint: 'AB', currentPubkey: CHILD, authorizedPubkeys: [CHILD], boundIdentity: PERSONA,
  ...(approvals ? { clientApprovals: approvals } : {}) });
const guardianSlot = (approvals?: ClientApproval[]) => slot({ slotIndex: 1, secretFingerprint: 'g', currentPubkey: GUARDIAN, authorizedPubkeys: [GUARDIAN], boundIdentity: MASTER,
  ...(approvals ? { clientApprovals: approvals } : {}) });
const grant = (client: string, ids: string[], tags: string[] = []): ClientApproval => ({ clientPubkey: client, approvedIdentities: ids, legacyIdentityTags: tags });

function rows(slots: DeviceClientSlot[], npProbe: Parameters<typeof guardianReadyRows>[0]['npProbe'] = 'none', d = dep()) {
  return guardianReadyRows({ dependant: d, slots, guardianClientPubkey: GUARDIAN, guardianNpPubkey: GNP, npProbe, guardianRowName: 'This phone' });
}
const byKey = (rs: ReadyRow[] | null) => Object.fromEntries((rs ?? []).map(r => [r.pubkey, r]));

describe('identityApproved', () => {
  it('reads explicit grants and surviving legacy tags; null when not reported', () => {
    const a = [grant(CHILD, [PERSONA], [EXTRA.slice(0, 16)])];
    expect(identityApproved(a, CHILD, PERSONA)).toBe(true);
    expect(identityApproved(a, CHILD, EXTRA)).toBe(true);
    expect(identityApproved(a, CHILD, NP)).toBe(false);
    expect(identityApproved(a, GUARDIAN, PERSONA)).toBe(false);
    expect(identityApproved(undefined, CHILD, PERSONA)).toBeNull();
  });
});

describe('guardianReadyRows', () => {
  it('a fresh slot: the bound persona is owed (per-client consent records nothing at mint), bound first', () => {
    const r = rows([childSlot([grant(CHILD, [])]), guardianSlot([grant(GUARDIAN, [GNP])])])!;
    expect(r.map(x => x.pubkey)).toEqual([PERSONA, EXTRA, GNP]);
    expect(byKey(r)[PERSONA]).toMatchObject({ state: 'waiting', who: 'child' });
    expect(byKey(r)[EXTRA]).toMatchObject({ state: 'waiting' });
    expect(byKey(r)[GNP]).toMatchObject({ state: 'ready', who: 'guardian' });
    expect(owedPresses(r)).toBe(2);
    expect(readySummary(r)).toEqual({ kind: 'owed', owed: 2 });
  });

  it('ready only when the device lists it for that client key', () => {
    const r = rows([childSlot([grant(CHILD, [PERSONA, EXTRA]), grant(GUARDIAN, [PERSONA])]), guardianSlot([grant(GUARDIAN, [GNP])])])!;
    expect(owedPresses(r)).toBe(0);
    expect(readySummary(r)).toEqual({ kind: 'ready' });
    // Another client's grant on the child's slot never counts for the child.
    const r2 = rows([childSlot([grant(GUARDIAN, [PERSONA, EXTRA])]), guardianSlot([grant(GUARDIAN, [GNP])])])!;
    expect(byKey(r2)[PERSONA].state).toBe('waiting');
  });

  it('the guardian NP probe answered OK but the device does not list it: still owed, never Ready', () => {
    const r = rows([childSlot([grant(CHILD, [PERSONA, EXTRA])]), guardianSlot([grant(GUARDIAN, [])])], 'ok')!;
    expect(byKey(r)[GNP]).toMatchObject({ state: 'waiting' });
    expect(readySummary(r).kind).toBe('owed');
  });

  it('a full slot (16 grants across every client key) and the identity absent: cannot remember, no press owed', () => {
    const others = Array.from({ length: 15 }, (_, i) => `f0${i.toString(16).padStart(62, '0')}`);
    // 15 for the child plus 1 for another client on the same slot = 16: the firmware counts the slot.
    const full = rows([childSlot([grant(CHILD, [PERSONA, ...others.slice(0, 14)]), grant(GUARDIAN, [others[14]])]), guardianSlot([grant(GUARDIAN, [GNP])])])!;
    expect(byKey(full)[PERSONA].state).toBe('ready');
    expect(byKey(full)[EXTRA].state).toBe('full');
    expect(owedPresses(full)).toBe(0);
    expect(readySummary(full)).toEqual({ kind: 'full' });
    expect(slotGrantCount([grant(CHILD, [PERSONA, ...others.slice(0, 14)]), grant(GUARDIAN, [others[14]])])).toBe(HEARTWOOD_SLOT_IDENTITY_CAP);
    // One short of the cap: still recordable, so owed.
    const notFull = rows([childSlot([grant(CHILD, [PERSONA, ...others.slice(0, 13)])]), guardianSlot([grant(GUARDIAN, [GNP])])])!;
    expect(byKey(notFull)[EXTRA].state).toBe('waiting');
    // The guardian's own slot full: its row cannot be remembered either.
    const g = rows([childSlot([grant(CHILD, [PERSONA, EXTRA])]), guardianSlot([grant(GUARDIAN, others.concat(MASTER))])])!;
    expect(byKey(g)[GNP].state).toBe('full');
    expect(readySummary(g).kind).toBe('full');
  });

  it('no NP route: owed, offered Try again, never done', () => {
    const r = rows([childSlot([grant(CHILD, [PERSONA, EXTRA])]), guardianSlot([grant(GUARDIAN, [])])], 'no-route')!;
    expect(byKey(r)[GNP]).toMatchObject({ state: 'waiting', failed: true });
    expect(owedPresses(r)).toBe(1);
  });

  it('the device does not report approvals: every row unknown, whatever a probe answered; never Ready', () => {
    for (const probe of ['ok', 'none', 'failed'] as const) {
      const r = rows([childSlot(), guardianSlot()], probe)!;
      expect(r.every(x => x.state === 'unknown')).toBe(true);
      expect(readySummary(r)).toEqual({ kind: 'unknown' });
    }
    expect(byKey(rows([childSlot(), guardianSlot()], 'probing'))[GNP]).toMatchObject({ state: 'unknown', probing: true });
  });

  it('no usable reading (none yet, a failed read, an empty list): unknown, not "child gone"', () => {
    for (const slots of [null, []]) {
      const r = guardianReadyRows({ dependant: dep(), slots, guardianClientPubkey: GUARDIAN, guardianNpPubkey: GNP, npProbe: 'none', guardianRowName: 'This phone' });
      expect(r).not.toBeNull();
      expect(r!.every(x => x.state === 'unknown')).toBe(true);
      expect(readySummary(r!).kind).toBe('unknown');
    }
  });

  it('no reading but a saved owed guardian row: that press stays owed', () => {
    const r = guardianReadyRows({ dependant: dep(), slots: null, guardianClientPubkey: GUARDIAN, guardianNpPubkey: GNP, npProbe: 'none', guardianRowName: 'This phone', savedGuardian: 'owed' })!;
    expect(byKey(r)[GNP]).toMatchObject({ state: 'waiting' });
    expect(byKey(r)[PERSONA].state).toBe('unknown');
    expect(readySummary(r)).toEqual({ kind: 'owed', owed: 1 });
    // A saved "confirmed" is not repeated without the device: unknown.
    const c = guardianReadyRows({ dependant: dep(), slots: null, guardianClientPubkey: GUARDIAN, guardianNpPubkey: GNP, npProbe: 'none', guardianRowName: 'This phone', savedGuardian: 'confirmed' })!;
    expect(byKey(c)[GNP].state).toBe('unknown');
  });

  it('a persona added after pairing joins the rows as owed until the device lists it', () => {
    const NEW = '9'.repeat(64);
    const d = dep({ extraPersonas: [...(dep().extraPersonas ?? []), { publicKey: NEW, privateKey: '', displayName: 'Climber', derivationName: 'persona-2' }] });
    const r = rows([childSlot([grant(CHILD, [PERSONA, EXTRA])]), guardianSlot([grant(GUARDIAN, [GNP])])], 'ok', d)!;
    expect(byKey(r)[NEW]).toMatchObject({ state: 'waiting', name: 'Climber' });
    expect(owedPresses(r)).toBe(1);
  });

  it('a removed or dormant persona is not expected; a good reading without the child phone ⇒ null', () => {
    const d = dep({ childDevice: { ...dep().childDevice!, removedPersonas: [EXTRA] } });
    expect(expectedChildPersonas(d).map(p => p.pubkey)).toEqual([PERSONA]);
    expect(expectedChildPersonas(dep()).map(p => p.pubkey)).not.toContain(NP);
    expect(rows([guardianSlot()])).toBeNull();
    expect(rows([childSlot([]), guardianSlot()], 'none', dep({ childDevice: undefined }))).toBeNull();
    // Same index, another phone's key (re-paired elsewhere): not this child's slot.
    expect(rows([slot({ slotIndex: 6, secretFingerprint: 'ab', currentPubkey: GUARDIAN, authorizedPubkeys: [GUARDIAN] })])).toBeNull();
  });
});

describe('readySummary', () => {
  const r = (state: ReadyRow['state']): ReadyRow => ({ pubkey: PERSONA, name: 'x', who: 'child', state });
  it('Ready only when every row is confirmed; paused, then owed, then full, then unknown', () => {
    expect(readySummary([])).toEqual({ kind: 'empty' });
    expect(readySummary([r('ready'), r('ready')])).toEqual({ kind: 'ready' });
    expect(readySummary([r('ready')], { paused: true })).toEqual({ kind: 'ready' });
    expect(readySummary([r('waiting'), r('unknown')], { paused: true })).toEqual({ kind: 'paused' });
    expect(readySummary([r('waiting'), r('full'), r('unknown')])).toEqual({ kind: 'owed', owed: 1 });
    expect(readySummary([r('skipped')])).toEqual({ kind: 'owed', owed: 1 });
    expect(readySummary([r('full'), r('unknown'), r('ready')])).toEqual({ kind: 'full' });
    expect(readySummary([r('unknown'), r('ready')])).toEqual({ kind: 'unknown' });
  });
});

describe('approvedForChild (the rules payload reading)', () => {
  it('the child key\'s recorded identities, sorted; a legacy tag is listed by the persona\'s full key', () => {
    expect(approvedForChild(dep(), [childSlot([grant(CHILD, [PERSONA]), grant(GUARDIAN, [EXTRA])]), guardianSlot()])).toEqual([PERSONA]);
    expect(approvedForChild(dep(), [childSlot([grant(CHILD, [], [EXTRA.slice(0, 16)])])])).toEqual([EXTRA]);
    expect(approvedForChild(dep(), [childSlot([])])).toEqual([]);
  });

  it('undefined when the device did not report, there is no reading, or the child slot is not in it', () => {
    expect(approvedForChild(dep(), [childSlot(), guardianSlot()])).toBeUndefined();
    expect(approvedForChild(dep(), null)).toBeUndefined();
    expect(approvedForChild(dep(), [])).toBeUndefined();
    expect(approvedForChild(dep(), [guardianSlot([grant(GUARDIAN, [GNP])])])).toBeUndefined();
  });
});

describe('guardianOutcomeOf', () => {
  it('maps the guardian row to the saved outcome', () => {
    const ready = rows([childSlot([grant(CHILD, [])]), guardianSlot([grant(GUARDIAN, [GNP])])]);
    expect(guardianOutcomeOf(ready, 'none')).toBe('confirmed');
    const owed = rows([childSlot([grant(CHILD, [])]), guardianSlot([grant(GUARDIAN, [])])]);
    expect(guardianOutcomeOf(owed, 'failed')).toBe('owed');
    expect(guardianOutcomeOf(owed, 'no-route')).toBe('no-route');
    expect(guardianOutcomeOf(rows([childSlot(), guardianSlot()]), 'ok')).toBe('unknown');
  });
});

describe('childEffectiveApproval (the guardian\'s reading wins)', () => {
  const eff = (saved: ChildApproval | undefined, approved: string[] | undefined, probedUnderCurrent = false) =>
    childEffectiveApproval({ persona: PERSONA, saved, approved, probedUnderCurrent });
  it('without a reading: the saved answer, as before', () => {
    expect(eff('approved', undefined)).toBe('approved');
    expect(eff(undefined, undefined)).toBe('waiting');
    expect(eff('deferred', undefined)).toBe('deferred');
  });
  it('a stale saved "approved" the reading does not list is owed again', () => {
    expect(eff('approved', [])).toBe('waiting');
    expect(eff('approved', [EXTRA])).toBe('waiting');
    expect(eff('failed', [])).toBe('failed');
    expect(eff('deferred', [])).toBe('deferred');
  });
  it('listed ⇒ approved whatever was saved; a probe under the same payload counts; a full list ⇒ full', () => {
    expect(eff(undefined, [PERSONA])).toBe('approved');
    expect(eff('failed', [PERSONA])).toBe('approved');
    expect(eff('approved', [], true)).toBe('approved');
    const sixteen = Array.from({ length: 16 }, (_, i) => `f1${i.toString(16).padStart(62, '0')}`);
    expect(eff('approved', sixteen)).toBe('full');
    expect(eff('approved', sixteen, true)).toBe('full');
  });
});

describe('childPressStands (this phone\'s press against the guardian\'s reading)', () => {
  const T = 1_800_000_000_000, MIN = 60_000;
  /** The persona's state as shown, after a press at `pressedAt` and the reading `approved` read at `approvedAt`. */
  const shown = (pressedAt: number | undefined, approved: string[], approvedAt: number | undefined, atPress: string[] | undefined = []) =>
    childEffectiveApproval({ persona: PERSONA, saved: pressedAt === undefined ? undefined : 'approved', approved,
      probedUnderCurrent: childPressStands({ pressedAt, approvedAt, atPress, approved }) });

  it('a press, then a stale reading (taken before it) without the identity: the press stands, confirmed', () => {
    expect(shown(T, [], T - 10 * MIN)).toBe('approved');
    expect(shown(T, [EXTRA], T - 10 * MIN)).toBe('approved');
  });
  it('a reading taken after the press without the identity: owed again', () => {
    expect(shown(T, [], T + 10 * MIN)).toBe('waiting');
    expect(shown(T, [EXTRA], T + 10 * MIN)).toBe('waiting');
    // ... and listed: confirmed by the reading itself.
    expect(shown(T, [PERSONA], T + 10 * MIN)).toBe('approved');
  });
  it('an empty reading, a press, then a full clear read later: owed (the old rule missed this)', () => {
    expect(shown(T, [], T - 10 * MIN, [])).toBe('approved');
    expect(shown(T, [], T + 10 * MIN, [])).toBe('waiting');
    // The rule without a reading time (an older guardian build) still misses it.
    expect(shown(T, [], undefined, [])).toBe('approved');
  });
  it('allows the two phones\' clocks to differ by up to 2 minutes', () => {
    expect(PRESS_CLOCK_SKEW_MS).toBe(2 * MIN);
    // A press up to 120 s BEFORE the reading counts as after it.
    expect(shown(T, [], T + 2 * MIN)).toBe('approved');
    expect(shown(T, [], T + 2 * MIN - 1)).toBe('approved');
    expect(shown(T, [], T + 2 * MIN + 1)).toBe('waiting');
  });
  it('no press this session: the reading decides', () => {
    expect(childPressStands({ pressedAt: undefined, approvedAt: T, atPress: undefined, approved: [] })).toBe(false);
    expect(childPressStands({ pressedAt: undefined, approvedAt: undefined, atPress: undefined, approved: [] })).toBe(false);
  });
  it('without a reading time (an older guardian build): the press stands while the reading lost nothing it held at the press', () => {
    expect(childPressStands({ pressedAt: T, approvedAt: undefined, atPress: [EXTRA], approved: [EXTRA] })).toBe(true);
    expect(childPressStands({ pressedAt: T, approvedAt: undefined, atPress: [EXTRA], approved: [] })).toBe(false);
  });
});

describe('childReadyRows', () => {
  it('maps the shown states: approved → ready, deferred → skipped, full → full, failed → waiting + retry', () => {
    const r = childReadyRows([
      { pubkey: PERSONA, name: 'Ally', approval: 'waiting' },
      { pubkey: EXTRA, name: 'Gamer', approval: 'failed' },
      { pubkey: NP, name: 'Lily', approval: 'deferred' },
      { pubkey: GNP, name: 'X', approval: 'approved' },
      { pubkey: MASTER, name: 'Y', approval: 'full' },
    ], new Set([PERSONA]));
    expect(r.map(x => [x.state, !!x.failed, !!x.probing])).toEqual([
      ['waiting', false, true], ['waiting', true, false], ['skipped', false, false], ['ready', false, false], ['full', false, false],
    ]);
    expect(owedPresses(r)).toBe(3);
  });
});

describe('helpers', () => {
  it('short npub like the Heartwood card; approval_changed detection', () => {
    expect(deviceShortNpub(PERSONA)).toMatch(/^npub1[02-9ac-hj-np-z]{8}\.\.$/);
    expect(deviceShortNpub('nothex')).toBe('');
    expect(isApprovalChanged(new Error('approval_changed: pairing or permissions changed; send the request again'))).toBe(true);
    expect(isApprovalChanged('approval changed')).toBe(true);
    expect(isApprovalChanged(new Error('denied'))).toBe(false);
  });
});
