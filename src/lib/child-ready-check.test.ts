import { describe, it, expect } from 'vitest';
import { buildPersonaFirstDependant } from './dependant-record';
import {
  childReadyRows, deviceShortNpub, expectedChildPersonas, guardianReadyRows, identityApproved, isApprovalChanged, owedPresses, type ReadyRow,
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
  it('a fresh slot: the bound persona is NOT ready (per-client consent records nothing at mint), bound first', () => {
    const r = rows([childSlot([grant(CHILD, [])]), guardianSlot([grant(GUARDIAN, [GNP])])])!;
    expect(r.map(x => x.pubkey)).toEqual([PERSONA, EXTRA, GNP]);
    expect(byKey(r)[PERSONA]).toMatchObject({ state: 'waiting', verified: true, who: 'child' });
    expect(byKey(r)[EXTRA]).toMatchObject({ state: 'waiting', verified: true });
    expect(byKey(r)[GNP]).toMatchObject({ state: 'ready', verified: true, who: 'guardian' });
    expect(owedPresses(r)).toBe(2);
  });

  it('ready only when the device lists it for that client key', () => {
    const r = rows([childSlot([grant(CHILD, [PERSONA, EXTRA]), grant(GUARDIAN, [PERSONA])]), guardianSlot([grant(GUARDIAN, [GNP])])])!;
    expect(owedPresses(r)).toBe(0);
    // Another client's grant on the child's slot never counts for the child.
    const r2 = rows([childSlot([grant(GUARDIAN, [PERSONA, EXTRA])]), guardianSlot([grant(GUARDIAN, [GNP])])])!;
    expect(byKey(r2)[PERSONA].state).toBe('waiting');
  });

  it('the guardian NP probe answered OK but the device does not list it (ONCE AS, full list): still waiting', () => {
    const r = rows([childSlot([grant(CHILD, [PERSONA, EXTRA])]), guardianSlot([grant(GUARDIAN, [])])], 'ok')!;
    expect(byKey(r)[GNP]).toMatchObject({ state: 'waiting', verified: true });
  });

  it('no NP route: recorded as not confirmed (waiting, offer Try again), never as done', () => {
    const r = rows([childSlot([grant(CHILD, [PERSONA, EXTRA])]), guardianSlot()], 'no-route')!;
    expect(byKey(r)[GNP]).toMatchObject({ state: 'waiting', verified: false, failed: true });
    expect(owedPresses(r)).toBe(1);
  });

  it('device does not report approvals: NP falls back to the probe answer (unverified), child rows unverified ready', () => {
    const ok = rows([childSlot(), guardianSlot()], 'ok')!;
    expect(byKey(ok)[GNP]).toMatchObject({ state: 'ready', verified: false });
    expect(byKey(ok)[PERSONA]).toMatchObject({ state: 'ready', verified: false });
    const none = rows([childSlot(), guardianSlot()], 'none')!;
    expect(byKey(none)[GNP]).toMatchObject({ state: 'waiting', verified: false });
    expect(byKey(rows([childSlot(), guardianSlot()], 'probing'))[GNP]).toMatchObject({ state: 'waiting', probing: true });
    expect(byKey(rows([childSlot(), guardianSlot()], 'failed'))[GNP]).toMatchObject({ state: 'waiting', failed: true });
  });

  it('a persona added after pairing joins the rows as owed until the device lists it', () => {
    const NEW = '9'.repeat(64);
    const d = dep({ extraPersonas: [...(dep().extraPersonas ?? []), { publicKey: NEW, privateKey: '', displayName: 'Climber', derivationName: 'persona-2' }] });
    const r = rows([childSlot([grant(CHILD, [PERSONA, EXTRA])]), guardianSlot([grant(GUARDIAN, [GNP])])], 'ok', d)!;
    expect(byKey(r)[NEW]).toMatchObject({ state: 'waiting', name: 'Climber' });
    expect(owedPresses(r)).toBe(1);
  });

  it('a removed or dormant persona is not expected; the child phone off the device ⇒ null', () => {
    const d = dep({ childDevice: { ...dep().childDevice!, removedPersonas: [EXTRA] } });
    expect(expectedChildPersonas(d).map(p => p.pubkey)).toEqual([PERSONA]);
    expect(expectedChildPersonas(dep()).map(p => p.pubkey)).not.toContain(NP);
    expect(rows([guardianSlot()])).toBeNull();
    expect(rows([childSlot([]), guardianSlot()], 'none', dep({ childDevice: undefined }))).toBeNull();
    // Same index, another phone's key (re-paired elsewhere): not this child's slot.
    expect(rows([slot({ slotIndex: 6, secretFingerprint: 'ab', currentPubkey: GUARDIAN, authorizedPubkeys: [GUARDIAN] })])).toBeNull();
  });
});

describe('childReadyRows', () => {
  it('maps the stored ceremony states: approved → ready, deferred → skipped, failed → waiting + retry', () => {
    const r = childReadyRows([
      { pubkey: PERSONA, name: 'Ally', approval: 'waiting' },
      { pubkey: EXTRA, name: 'Gamer', approval: 'failed' },
      { pubkey: NP, name: 'Lily', approval: 'deferred' },
      { pubkey: GNP, name: 'X', approval: 'approved' },
    ], new Set([PERSONA]));
    expect(r.map(x => [x.state, !!x.failed, !!x.probing])).toEqual([
      ['waiting', false, true], ['waiting', true, false], ['skipped', false, false], ['ready', false, false],
    ]);
    expect(r.every(x => x.verified === false)).toBe(true);
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
