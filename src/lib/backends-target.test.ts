import { describe, it, expect } from 'vitest';
import { backendsTargetId } from './backends-target';

const base = { identityId: 'a'.repeat(64), identityEncrypted: false, activeDependant: null, pairingGeneration: 0 };

describe('backendsTargetId', () => {
  it('is stable while nothing changes (the effect dedups re-runs)', () => {
    expect(backendsTargetId(base)).toBe(backendsTargetId({ ...base }));
  });

  it('changes on an in-session re-pair, so the signer is rebuilt for the new pairing (bug 5)', () => {
    const before = backendsTargetId(base);
    const after = backendsTargetId({ ...base, pairingGeneration: 1 });
    expect(after).not.toBe(before);
  });

  it('changes between the encrypted and decrypted identity', () => {
    expect(backendsTargetId({ ...base, identityEncrypted: true })).not.toBe(backendsTargetId(base));
  });

  it('keeps the dep: prefix for a guardian acting as a dependant (guardian re-entry clears on it)', () => {
    const id = backendsTargetId({ ...base, activeDependant: { id: 'd1', primaryKeypair: 'persona' } });
    expect(id.startsWith('dep:')).toBe(true);
    expect(backendsTargetId({ ...base, activeDependant: { id: 'd1', primaryKeypair: 'natural-person' } })).not.toBe(id);
  });
});
