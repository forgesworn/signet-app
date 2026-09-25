import { describe, it, expect } from 'vitest';
import { dependantGateReason } from './real-identity-gate-reasons';

describe('dependantGateReason (spec §7.3/§7.6)', () => {
  it('names the dependant for verification', () => {
    expect(dependantGateReason('get-verified', 'Lily')).toBe(
      'Getting verified attaches Lily’s legal name to their Signet, so it needs their real identity.',
    );
  });

  it('names the dependant for venue entry', () => {
    expect(dependantGateReason('venue-entry', 'Lily')).toBe(
      'A venue reads Lily’s legal name at the door, so venue entry needs their real identity.',
    );
  });

  it('never uses a forbidden word', () => {
    for (const f of ['get-verified', 'venue-entry'] as const) {
      expect(dependantGateReason(f, 'Lily')).not.toMatch(/Guest|provisional|burner/i);
    }
  });
});
