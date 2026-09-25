import { expect, it } from 'vitest';
import { mergeChildContactSettings, portableChildContactSettings } from './child-contact-settings';
import { contactInviteDecision } from './contact-invite-policy';
const childPubkey = '1'.repeat(64), guardianPubkey = '2'.repeat(64), peer = '3'.repeat(64);
const base = { childPubkey, guardianPubkey, contactPolicy: 'approved' as const, approvedContacts: [peer], updatedAt: 10 };
it('canonicalises bounded approvals and drops nonportable fields', () => {
  expect(portableChildContactSettings({ ...base, approvedContacts: [peer, peer], secret: 'private' })).toEqual({ ...base, approvedContacts: [peer], defaultChildCeiling: 'ken' });
  expect(portableChildContactSettings({ ...base, approvedContacts: ['invalid'] })).toBeNull();
  expect(portableChildContactSettings({ ...base, contactPolicy: 'allow-everyone' })).toBeNull();
});
it('converges to a deny-until-reviewed conflict at equal clocks, then accepts a newer guardian choice', () => {
  const other = { ...base, contactPolicy: 'open' as const };
  const ab = mergeChildContactSettings(base, other), ba = mergeChildContactSettings(other, base);
  expect(ab).toEqual(ba); expect(ab.contactPolicyConflicted).toBe(true);
  expect(mergeChildContactSettings(ab, base)).toEqual(ab);
  expect(contactInviteDecision(peer, [], { directoryId: `dependant:${childPubkey}`, settings: ab, activeGuardianPubkeys: [guardianPubkey] })).toBe('deny');
  const resolved = mergeChildContactSettings(ab, { ...other, updatedAt: 11 });
  expect(resolved.contactPolicyConflicted).toBeUndefined();
  expect(resolved.contactPolicy).toBe('open');
  expect(mergeChildContactSettings(resolved, ab)).toEqual(resolved);
});
it('does not union conflicting allowlists or overwrite another guardian', () => {
  const merged = mergeChildContactSettings(base, { ...base, approvedContacts: ['4'.repeat(64)] });
  expect(merged.contactPolicyConflicted).toBe(true);
  expect(merged.approvedContacts).toHaveLength(0);
  expect(() => mergeChildContactSettings(base, { ...base, guardianPubkey: peer })).toThrow('another guardian');
});
it('converges across three equal-clock devices while retaining only common approvals and the strictest ceiling', () => {
  const a = { ...base, approvedContacts: [peer, '4'.repeat(64)], defaultChildCeiling: 'kin' as const };
  const b = { ...base, contactPolicy: 'open' as const, approvedContacts: [peer, '5'.repeat(64)], defaultChildCeiling: 'kith' as const };
  const c = { ...base, contactPolicy: 'kin-only' as const, approvedContacts: [peer], defaultChildCeiling: 'ken' as const };
  const results = [[a,b,c], [a,c,b], [b,a,c], [b,c,a], [c,a,b], [c,b,a]].map(([x,y,z]) => mergeChildContactSettings(mergeChildContactSettings(x,y),z));
  for (const result of results) expect(result).toEqual(results[0]);
  expect(results[0]).toMatchObject({ approvedContacts: [peer], defaultChildCeiling: 'ken', contactPolicyConflicted: true });
});
