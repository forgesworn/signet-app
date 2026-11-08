import { describe, expect, it } from 'vitest';
import { heartwoodEntriesFor, heartwoodPolicySummary } from './known-place-heartwood';
import type { DeviceClientSlot } from './heartwood-mgmt-types';

const slot = (over: Partial<DeviceClientSlot> = {}): DeviceClientSlot => ({
  slotIndex: 0, label: 'Bark', secretFingerprint: 'ff'.repeat(32), autoApprove: false, signingApproved: false,
  strictPermissions: true, currentPubkey: null, authorizedPubkeys: [], allowedKinds: [], allowedMethods: [],
  escalate: false, petitionOnDeny: false, auditChildWrap: false, boundIdentity: null, ...over,
});
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('heartwood known-place entries', () => {
  it('summarises what the device lets the app do', () => {
    expect(heartwoodPolicySummary(slot())).toBe('Asks on the device');
    expect(heartwoodPolicySummary(slot({ autoApprove: true, signingApproved: true, allowedKinds: [1, 7] }))).toBe('Signs automatically · 2 kinds');
    expect(heartwoodPolicySummary(slot({ escalate: true, autoApprove: true, signingApproved: true }))).toBe('Asks on your phone');
  });

  it('keeps slots bound to this identity or to none, and names the identity', () => {
    const slots = [slot({ label: 'Mine', boundIdentity: A }), slot({ label: 'Theirs', boundIdentity: B, secretFingerprint: 'ee'.repeat(32) }), slot({ label: 'Open', secretFingerprint: 'dd'.repeat(32) })];
    const out = heartwoodEntriesFor(slots, A, pk => (pk === A ? 'Alice' : undefined));
    expect(out.map(e => e.label)).toEqual(['Mine', 'Open']);
    expect(out[0].boundIdentity).toBe('Alice');
    expect(out[1].boundIdentity).toBe('Any identity');
  });
});
