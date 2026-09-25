import { describe, it, expect } from 'vitest';
import { resolveIndependenceGate } from './contacts-v2-independence-gate';

describe('resolveIndependenceGate', () => {
  it('allows the ceremony when the directory is empty', () => {
    expect(resolveIndependenceGate({ dependantName: 'Sam', contacts: [] }))
      .toEqual({ allowed: true, reason: null });
  });

  it('allows the ceremony when every record is already removed', () => {
    expect(resolveIndependenceGate({
      dependantName: 'Sam',
      contacts: [{ lifecycle: 'removed' }, { lifecycle: 'removed' }],
    })).toEqual({ allowed: true, reason: null });
  });

  it('blocks the ceremony with the spec sentence when a contact remains', () => {
    const gate = resolveIndependenceGate({
      dependantName: 'Sam',
      contacts: [{ lifecycle: 'removed' }, { lifecycle: 'active' }],
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe(
      "Contact transfer isn't available yet. Independence will be enabled once contacts can move with Sam.",
    );
  });

  it('counts a suggested, pending or rejected record as remaining', () => {
    for (const lifecycle of ['suggested', 'pending', 'rejected'] as const) {
      expect(resolveIndependenceGate({ dependantName: 'Sam', contacts: [{ lifecycle }] }).allowed).toBe(false);
    }
  });

  it('does not block on an archived record — the reducer stamps it lifecycle: removed, archived: true', () => {
    expect(resolveIndependenceGate({
      dependantName: 'Sam',
      contacts: [{ lifecycle: 'removed', archived: true }],
    })).toEqual({ allowed: true, reason: null });
  });
});
