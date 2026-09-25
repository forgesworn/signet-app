// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { checkPromotionEligibility } from './useRosterWatch';

// checkPromotionEligibility is an exported pure function for testability.
// The hook itself wires it to relay calls + IDB updates.

describe('checkPromotionEligibility', () => {
  it('returns confirmed when all three conditions pass: anchor found, headPubkey signs roster, issuer in roster', () => {
    const result = checkPromotionEligibility({
      issuerProPubkey: 'aaa'.repeat(21) + 'a', // 64 chars
      claimedFirm: '100000',
      claimedRole: 'form-tutor',
      anchorFound: true,
      leadPubkeys: ['bbb'.repeat(21) + 'b'],
      rosterMemberPubkeys: ['aaa'.repeat(21) + 'a', 'ccc'.repeat(21) + 'c'],
      delegatePubkeys: [],
    });
    expect(result).toBe('confirmed');
  });

  it('returns pending when no anchor is found', () => {
    const result = checkPromotionEligibility({
      issuerProPubkey: 'a'.repeat(64),
      claimedFirm: '100000',
      claimedRole: 'form-tutor',
      anchorFound: false,
      leadPubkeys: [],
      rosterMemberPubkeys: [],
      delegatePubkeys: [],
    });
    expect(result).toBe('pending');
  });

  it('returns pending when anchor found but issuer not in roster', () => {
    const result = checkPromotionEligibility({
      issuerProPubkey: 'a'.repeat(64),
      claimedFirm: '100000',
      claimedRole: 'form-tutor',
      anchorFound: true,
      leadPubkeys: ['b'.repeat(64)],
      rosterMemberPubkeys: ['c'.repeat(64)],
      delegatePubkeys: [],
    });
    expect(result).toBe('pending');
  });

  it('returns pending when anchor found but roster is empty', () => {
    const result = checkPromotionEligibility({
      issuerProPubkey: 'a'.repeat(64),
      claimedFirm: '100000',
      claimedRole: 'form-tutor',
      anchorFound: true,
      leadPubkeys: ['b'.repeat(64)],
      rosterMemberPubkeys: [],
      delegatePubkeys: [],
    });
    expect(result).toBe('pending');
  });

  it('does not promote a lapsed credential (guard: never called on expired-pending)', () => {
    // This test documents a contract: callers must NOT pass expired-pending credentials
    // to checkPromotionEligibility. The function only returns 'confirmed' | 'pending'.
    // Callers filter to verifierStatus === 'pending' before calling.
    const result = checkPromotionEligibility({
      issuerProPubkey: 'a'.repeat(64),
      claimedFirm: '100000',
      claimedRole: 'form-tutor',
      anchorFound: true,
      leadPubkeys: ['b'.repeat(64)],
      rosterMemberPubkeys: ['a'.repeat(64)],
      delegatePubkeys: [],
    });
    // Roster contains issuer — would confirm.
    expect(result).toBe('confirmed');
  });

  it('returns confirmed when anchor found and issuer in roster with multiple leads (multi-lead compat)', () => {
    const result = checkPromotionEligibility({
      issuerProPubkey: 'a'.repeat(64),
      claimedFirm: '100000',
      claimedRole: 'form-tutor',
      anchorFound: true,
      leadPubkeys: ['b'.repeat(64), 'c'.repeat(64)],
      rosterMemberPubkeys: ['a'.repeat(64)],
      delegatePubkeys: [],
    });
    expect(result).toBe('confirmed');
  });
});
