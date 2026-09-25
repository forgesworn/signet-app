// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { getCurrentAuthorityUnion } from './verify-chain';

// Minimal stubs for relay events.
function makeRosterEvent(
  signerPubkey: string,
  memberPubkeys: string[],
  delegatePubkeys: string[],
  createdAt: number,
): { pubkey: string; created_at: number; tags: string[][] } {
  return {
    pubkey: signerPubkey,
    created_at: createdAt,
    tags: [
      ...memberPubkeys.map(p => ['p', p, 'form-tutor']),
      ...delegatePubkeys.map(p => ['delegate', p]),
    ],
  };
}

describe('getCurrentAuthorityUnion', () => {
  const LEAD_A = 'a'.repeat(64);
  const LEAD_B = 'b'.repeat(64);
  const DELEGATE_D = 'd'.repeat(64);
  const MEMBER_M = 'm'.repeat(64);

  it('signed by lead-A — in authority union', () => {
    const union = getCurrentAuthorityUnion({
      leadPubkeys: [LEAD_A],
      latestRosters: [makeRosterEvent(LEAD_A, [MEMBER_M], [], 100)],
    });
    expect(union.leads).toContain(LEAD_A);
    expect(union.allAuthorised).toContain(LEAD_A);
  });

  it('signed by lead-B in co-lead setup — both in authority union', () => {
    const union = getCurrentAuthorityUnion({
      leadPubkeys: [LEAD_A, LEAD_B],
      latestRosters: [
        makeRosterEvent(LEAD_A, [MEMBER_M], [DELEGATE_D], 100),
        makeRosterEvent(LEAD_B, [MEMBER_M], [], 90),
      ],
    });
    expect(union.allAuthorised).toContain(LEAD_A);
    expect(union.allAuthorised).toContain(LEAD_B);
  });

  it('delegate D appears in lead-A roster — delegate is in authority union', () => {
    const union = getCurrentAuthorityUnion({
      leadPubkeys: [LEAD_A],
      latestRosters: [makeRosterEvent(LEAD_A, [MEMBER_M], [DELEGATE_D], 100)],
    });
    expect(union.delegates).toContain(DELEGATE_D);
    expect(union.allAuthorised).toContain(DELEGATE_D);
  });

  it('non-authority pubkey not in union', () => {
    const STRANGER = 's'.repeat(64);
    const union = getCurrentAuthorityUnion({
      leadPubkeys: [LEAD_A],
      latestRosters: [makeRosterEvent(LEAD_A, [MEMBER_M], [DELEGATE_D], 100)],
    });
    expect(union.allAuthorised).not.toContain(STRANGER);
  });

  it('concurrent-roster race — D removed by lead-A latest but still in lead-B latest: union keeps D authorised (spec §3.5.6)', () => {
    // Lead-A signed at t=100 WITHOUT D (removal); lead-B signed at t=90 WITH D.
    // Default union: D remains authorised.
    const rosterA_withoutD = makeRosterEvent(LEAD_A, [MEMBER_M], [], 100);
    const rosterB_withD = makeRosterEvent(LEAD_B, [MEMBER_M], [DELEGATE_D], 90);
    const union = getCurrentAuthorityUnion({
      leadPubkeys: [LEAD_A, LEAD_B],
      latestRosters: [rosterA_withoutD, rosterB_withD],
    });
    // D remains authorised because lead-B's latest roster still includes D.
    expect(union.allAuthorised).toContain(DELEGATE_D);
  });

  it('stale-roster delegate removed in ALL leads latest rosters — not in union', () => {
    // Both leads' latest rosters omit D — D is not authorised.
    const rosterA = makeRosterEvent(LEAD_A, [MEMBER_M], [], 100);
    const rosterB = makeRosterEvent(LEAD_B, [MEMBER_M], [], 90);
    const union = getCurrentAuthorityUnion({
      leadPubkeys: [LEAD_A, LEAD_B],
      latestRosters: [rosterA, rosterB],
    });
    expect(union.allAuthorised).not.toContain(DELEGATE_D);
  });
});
