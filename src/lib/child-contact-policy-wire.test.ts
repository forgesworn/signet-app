import { expect, it, vi } from 'vitest';
import { LocalSigningBackend } from './signing-backend';
import { childContactPolicyDecision, mergeChildContactPolicy, openChildContactPolicy, parseChildContactPolicy, projectChildContactPolicy, sealChildContactPolicy } from './child-contact-policy-wire';
const child = '1'.repeat(64), guardian = '2'.repeat(64), peer = '3'.repeat(64), now = 1800000000;
const endpoint = new LocalSigningBackend('04'.repeat(32)), recipient = new LocalSigningBackend('05'.repeat(32));
const view = () => projectChildContactPolicy({ child, guardian, recipient: recipient.activePublicKeyHex, now, records: [],
  settings: { childPubkey: child, guardianPubkey: guardian, contactPolicy: 'approved', approvedContacts: [peer] } });
it('shares only the bounded policy view, without the child identity or unrelated fields', () => {
  const projected = view();
  expect(projected.allowed).toEqual([peer]);
  expect(JSON.stringify(projected)).not.toContain(child);
  expect(childContactPolicyDecision(projected, peer, now)).toBe('allow');
  expect(childContactPolicyDecision(projected, '6'.repeat(64), now)).toBe('guardian-review');
  expect(childContactPolicyDecision(projected, peer, projected.expiresAt)).toBe('deny');
  expect(childContactPolicyDecision(null, peer, now)).toBe('deny');
  expect(parseChildContactPolicy(JSON.stringify({ ...projected, allowed: Array(501).fill(peer) }))).toBeNull();
  expect(parseChildContactPolicy(JSON.stringify({ ...projected, blocked: [peer] }))).toBeNull();
  expect(parseChildContactPolicy(JSON.stringify({ ...projected, notes: 'private' }))).not.toHaveProperty('notes');
});
it('encrypts to the pinned child transport and verifies the endpoint before decrypting', async () => {
  const event = await sealChildContactPolicy(view(), endpoint);
  const options = { endpoint: endpoint.activePublicKeyHex, guardian, recipient: recipient.activePublicKeyHex, backend: recipient, now };
  expect(event.content).not.toContain(peer);
  expect(await openChildContactPolicy(event, options)).toEqual(view());
  const decrypt = vi.spyOn(recipient, 'nip44Decrypt'); decrypt.mockClear();
  expect(await openChildContactPolicy({ ...event, sig: '00'.repeat(64) }, options)).toBeNull();
  expect(await openChildContactPolicy(event, { ...options, endpoint: peer })).toBeNull();
  expect(await openChildContactPolicy(event, { ...options, now: view().expiresAt })).toBeNull();
  expect(decrypt).not.toHaveBeenCalled();
  expect(await openChildContactPolicy(event, { ...options, guardian: peer })).toBeNull();
  decrypt.mockRestore();
});
it('rejects foreign guardian settings and foreign directory records', () => {
  expect(() => projectChildContactPolicy({ child, guardian, recipient: recipient.activePublicKeyHex, now, records: [],
    settings: { childPubkey: child, guardianPubkey: peer, contactPolicy: 'open' } })).toThrow('Foreign');
  expect(() => projectChildContactPolicy({ child, guardian, recipient: recipient.activePublicKeyHex, now,
    records: [{ directoryId: 'owner' }] as never })).toThrow('Foreign');
});
it('retains the high-water mark and denies equal-time policy disagreements in either order', () => {
  const a = view(), b = { ...view(), policy: 'open' as const, allowed: [] };
  expect(mergeChildContactPolicy(a, { ...b, revision: now - 1 })).toEqual(a);
  expect(mergeChildContactPolicy(a, b)).toEqual(mergeChildContactPolicy(b, a));
  expect(childContactPolicyDecision(mergeChildContactPolicy(a, b), peer, now)).toBe('deny');
  expect(mergeChildContactPolicy(a, { ...b, revision: now + 1, expiresAt: b.expiresAt + 1 })).toMatchObject({ policy: 'open', conflicted: false });
});
