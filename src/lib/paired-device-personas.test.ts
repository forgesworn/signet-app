import { describe, expect, it } from 'vitest';
import { pairedDeviceAllows } from './paired-device-personas';
import type { DependantIdentity } from '../types';

const BOUND = 'b'.repeat(64), EXTRA = 'c'.repeat(64), NP = 'a'.repeat(64);
const direct = (over: Partial<NonNullable<DependantIdentity['childDevice']>> = {}): Pick<DependantIdentity, 'childDevice' | 'hiddenOnPairedDeviceKeys'> => ({
  childDevice: { mode: 'heartwood-direct', slotLabel: 'x', secretFingerprint: 'ab', slotIndex: 1, clientPubkey: 'd'.repeat(64),
    boundPersona: BOUND, pairedAt: 1, ...over },
});

describe('pairedDeviceAllows', () => {
  it('lets everything through on a dependant with no paired-device restrictions', () => {
    const allows = pairedDeviceAllows({});
    expect([BOUND, EXTRA, NP].every(k => allows(k))).toBe(true);
    expect(allows('')).toBe(false);
    expect(allows(undefined)).toBe(false);
  });

  it('A51: a persona removed from the phone is refused — the real identity too', () => {
    const allows = pairedDeviceAllows(direct({ removedPersonas: [EXTRA, NP] }));
    expect(allows(EXTRA)).toBe(false);
    expect(allows(NP)).toBe(false);
    expect(allows(BOUND)).toBe(true);
  });

  it('a soft-deleted extra is refused', () => {
    expect(pairedDeviceAllows({})(EXTRA, true)).toBe(false);
  });

  it('a key hidden from the paired device is refused, compared case-insensitively', () => {
    const allows = pairedDeviceAllows({ hiddenOnPairedDeviceKeys: [EXTRA.toUpperCase()] });
    expect(allows(EXTRA)).toBe(false);
    expect(pairedDeviceAllows(direct({ removedPersonas: [EXTRA.toUpperCase()] }))(EXTRA)).toBe(false);
  });

  it('A51: the bound persona is never filtered — not removed, hidden, nor soft-deleted', () => {
    const allows = pairedDeviceAllows({ ...direct({ removedPersonas: [BOUND] }), hiddenOnPairedDeviceKeys: [BOUND] });
    expect(allows(BOUND)).toBe(true);
    expect(allows(BOUND.toUpperCase(), true)).toBe(true);
  });

  it('legacy (no childDevice): a hidden default persona stays hidden', () => {
    expect(pairedDeviceAllows({ hiddenOnPairedDeviceKeys: [BOUND] })(BOUND)).toBe(false);
  });
});
