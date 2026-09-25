import { expect, it, vi } from 'vitest';
import type { ContactRecord } from '../types';
import { LocalSigningBackend } from './signing-backend';
import { childDirectoryVisible, mergeChildContactDirectory, openChildContactDirectory, parseChildContactDirectory, projectChildContactDirectory, sealChildContactDirectory } from './child-contact-directory';
const child = '1'.repeat(64), guardian = '2'.repeat(64), persona = '3'.repeat(64), peer = '6'.repeat(64), now = 1800000000;
const endpoint = new LocalSigningBackend('04'.repeat(32)), recipient = new LocalSigningBackend('05'.repeat(32));
const record = (): ContactRecord => ({ directoryId: `dependant:${child}`, contactId: 'a'.repeat(32), displayName: 'Friend', type: 'person',
  tier: 'kin', createdByActorRole: 'dependant', createdByOperationId: 'b'.repeat(32), lifecycle: 'active', createdAt: now, updatedAt: now,
  roles: ['secret-role'], notes: 'private guardian note', identities: [{ itemId: 'c'.repeat(32), pubkey: peer, verification: 'mutual', provenance: 'direct', addedAt: now,
    direct: { ownerPubkey: persona, sharedSecret: 'secret-evidence', verifiedAt: now } }], contactMethods: [], accessGrants: [], vouches: [], ceilings: [], blocks: [],
  primaryIdentityPubkey: persona, listMemberships: [{ ownerIdentityPubkey: persona, addedAt: now }] });
const input = () => ({ child, guardian, recipient: recipient.activePublicKeyHex, availablePersonas: [persona], records: [record()], revision: 10, now });
const options = () => ({ endpoint: endpoint.activePublicKeyHex, guardian, recipient: recipient.activePublicKeyHex, availablePersonas: [persona], backend: recipient, now, isCurrent: () => true });
it('projects named available lists, with the effective ceiling and no private evidence', () => {
  const view = projectChildContactDirectory(input());
  expect(view.entries).toEqual([{ id: 'a'.repeat(32), name: 'Friend', tier: 'ken', identities: [peer], lists: [persona] }]);
  expect(JSON.stringify(view)).not.toMatch(/secret|private|verification|direct|roles|notes/);
  expect(JSON.stringify(view)).not.toContain(child);
  expect(projectChildContactDirectory({ ...input(), availablePersonas: [] }).entries).toEqual([]);
  expect(projectChildContactDirectory({ ...input(), records: [{ ...record(), listMemberships: undefined }] }).entries).toEqual([]);
  expect(() => projectChildContactDirectory({ ...input(), records: [{ ...record(), directoryId: 'owner' }] })).toThrow('Foreign');
  expect(() => projectChildContactDirectory({ ...input(), settings: { childPubkey: peer, guardianPubkey: guardian, contactPolicy: 'approved' } })).toThrow('Foreign');
});
it('withholds blocked peers across duplicate rows, hidden records and none ceilings', () => {
  const blocked = { ...record(), contactId: 'd'.repeat(32), blocks: [{ blockedBy: guardian, scope: { kind: 'contact' as const }, blockedAt: now, operationId: 'e'.repeat(32) }] };
  expect(projectChildContactDirectory({ ...input(), records: [record(), blocked] }).entries).toEqual([]);
  for (const extra of [{ archived: true }, { removedAt: now }, { lifecycle: 'pending' as const }])
    expect(projectChildContactDirectory({ ...input(), records: [{ ...record(), ...extra }] }).entries).toEqual([]);
  expect(projectChildContactDirectory({ ...input(), settings: { childPubkey: child, guardianPubkey: guardian, contactPolicy: 'approved', defaultChildCeiling: 'none' } }).entries).toEqual([]);
});
it('bounds payloads, strips unknown fields, and rejects duplicates or foreign list references', () => {
  const view = projectChildContactDirectory(input());
  expect(parseChildContactDirectory(JSON.stringify({ ...view, notes: 'private' }))).toEqual(view);
  expect(parseChildContactDirectory(JSON.stringify({ ...view, entries: [...view.entries, ...view.entries] }))).toBeNull();
  expect(parseChildContactDirectory(JSON.stringify({ ...view, entries: [{ ...view.entries[0], lists: [peer] }] }))).toBeNull();
  expect(parseChildContactDirectory(JSON.stringify({ ...view, ignored: 'x'.repeat(48000) }))).toBeNull();
  expect(parseChildContactDirectory(JSON.stringify({ ...view, expiresAt: now + 901 }))).toBeNull();
});
it('verifies the pinned envelope before transport decryption and checks the available personas', async () => {
  const view = projectChildContactDirectory(input()), event = await sealChildContactDirectory(view, endpoint);
  expect(event.tags).toEqual([['d', 'signet:child-contact-directory:v1']]);
  expect(event.content).not.toContain('Friend');
  expect(await openChildContactDirectory(event, options())).toEqual(view);
  const decrypt = vi.spyOn(recipient, 'nip44Decrypt'); decrypt.mockClear();
  // verifyEvent cached symbols must not turn a modified event into authority.
  expect(await openChildContactDirectory({ ...event, content: `${event.content}x` }, options())).toBeNull();
  expect(await openChildContactDirectory(event, { ...options(), endpoint: peer })).toBeNull();
  expect(await openChildContactDirectory(event, { ...options(), now: now + 900 })).toBeNull();
  expect(decrypt).not.toHaveBeenCalled();
  expect(await openChildContactDirectory(event, { ...options(), availablePersonas: [] })).toBeNull();
  decrypt.mockRestore();
});
it('discards a decrypted view after lock or pairing switch', async () => {
  const event = await sealChildContactDirectory(projectChildContactDirectory(input()), endpoint);
  const decrypt = recipient.nip44Decrypt.bind(recipient); let current = true;
  const spy = vi.spyOn(recipient, 'nip44Decrypt').mockImplementation(async (...args) => { const value = await decrypt(...args); current = false; return value; });
  expect(await openChildContactDirectory(event, { ...options(), isCurrent: () => current })).toBeNull();
  spy.mockRestore();
});
it('persists monotonic revisions and sticky equal-revision conflicts without leaking names', () => {
  const a = projectChildContactDirectory(input()), b = { ...a, entries: [{ ...a.entries[0], name: 'Changed' }] };
  const conflict = mergeChildContactDirectory(a, b);
  expect(conflict).toEqual(mergeChildContactDirectory(b, a));
  expect(conflict.entries).toEqual([]);
  expect(childDirectoryVisible(conflict, now)).toBe(false);
  expect(mergeChildContactDirectory(conflict, a)).toEqual(conflict);
  expect(mergeChildContactDirectory(a, { ...b, revision: 9 })).toEqual(a);
  expect(mergeChildContactDirectory(conflict, { ...b, revision: 11 })).toEqual({ ...b, revision: 11 });
  expect(childDirectoryVisible(a, now)).toBe(true);
  expect(childDirectoryVisible(a, now + 900)).toBe(false);
  expect(() => mergeChildContactDirectory(a, { ...b, recipient: peer })).toThrow('pairing changed');
  const lateConflict = mergeChildContactDirectory(a, { ...b, issuedAt: now + 1000, expiresAt: now + 1900 });
  expect(parseChildContactDirectory(JSON.stringify(lateConflict))).toEqual(lateConflict);
});
