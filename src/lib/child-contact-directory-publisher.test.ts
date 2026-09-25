import { beforeEach, expect, it, vi } from 'vitest';
import { getDb, purgeAllUserData } from './db';
import { LocalSigningBackend } from './signing-backend';
import { childDirectoryPersonas, resolveChildAskPersona, publishChildContactDirectory, reserveChildDirectoryRevision, type ChildDirectoryPublicationScope } from './child-contact-directory-publisher';
import { openChildContactDirectory } from './child-contact-directory';
import * as crypto from './crypto-store';
import { contactIdentityLists } from './contacts-v2-identity-lists';
import type { SignetIdentity } from '../types';
const guardian = '2'.repeat(64), child = '1'.repeat(64), persona = '3'.repeat(64), key = 'directory-publisher-test';
const recipient = new LocalSigningBackend('05'.repeat(32));
const endpoint = new LocalSigningBackend('04'.repeat(32)).activePublicKeyHex;
const scope = () => ({ dependant: { id: child, guardianPubkey: guardian, autonomyStage: 'request-approve',
  naturalPersonActive: false, naturalPerson: { publicKey: child }, persona: { publicKey: persona },
  bunkerEndpoint: { publicKey: endpoint, privateKey: '04'.repeat(32), createdAt: 1, authorizedClientPubkey: recipient.activePublicKeyHex },
}, records: [] }) as unknown as ChildDirectoryPublicationScope;
const binding = { guardian, child, endpoint, recipient: recipient.activePublicKeyHex };
const current = () => true;
beforeEach(async () => { vi.restoreAllMocks(); await purgeAllUserData(); });
it('reserves distinct durable revisions concurrently and never resets corrupt state', async () => {
  expect((await Promise.all([reserveChildDirectoryRevision(binding, key, current), reserveChildDirectoryRevision(binding, key, current)])).sort()).toEqual([1, 2]);
  expect(await reserveChildDirectoryRevision(binding, key, current)).toBe(3);
  const db = await getDb(), row = (await db.getAll('privateVaultState'))[0];
  expect(row.encrypted).not.toContain('revision');
  await db.put('privateVaultState', { ...row, encrypted: 'broken' });
  await expect(reserveChildDirectoryRevision(binding, key, current)).rejects.toThrow();
});
it('omits dormant, hidden and removed persona slots', () => {
  const dep = scope().dependant;
  dep.extraPersonas = [{ publicKey: '6'.repeat(64), hidden: true }, { publicKey: '7'.repeat(64) }] as typeof dep.extraPersonas;
  dep.hiddenOnPairedDeviceKeys = [persona];
  expect(childDirectoryPersonas(dep)).toEqual(['7'.repeat(64)]);
});
it('sends an authenticated encrypted snapshot after fresh scope checks', async () => {
  const send = vi.fn(), readScope = vi.fn(async () => scope());
  await publishChildContactDirectory({ guardian, child, key, isCurrent: current, readScope,
    signer: async () => new LocalSigningBackend('04'.repeat(32)), send, now: () => 100 });
  expect(readScope).toHaveBeenCalledTimes(3);
  expect(send).toHaveBeenCalledOnce();
  expect(await openChildContactDirectory(send.mock.calls[0][0], { ...binding, availablePersonas: [persona], backend: recipient, now: 100, isCurrent: current }))
    .toMatchObject({ revision: 1, entries: [], personas: [persona] });
});
it.each(['pairing', 'policy', 'visibility', 'lock', 'expiry'])('withholds results after %s changes during signing', async change => {
  const fresh = scope(), send = vi.fn(); let active = true, now = 100;
  await expect(publishChildContactDirectory({ guardian, child, key, isCurrent: () => active, readScope: async () => structuredClone(fresh),
    signer: async () => {
      const backend = new LocalSigningBackend('04'.repeat(32)), sign = backend.signEvent.bind(backend);
      vi.spyOn(backend, 'signEvent').mockImplementation(async event => {
        const signed = await sign(event);
        if (change === 'pairing') fresh.dependant.bunkerEndpoint!.authorizedClientPubkey = '9'.repeat(64);
        if (change === 'policy') fresh.settings = { childPubkey: child, guardianPubkey: guardian, contactPolicy: 'approved', contactPolicyConflicted: true };
        if (change === 'visibility') fresh.dependant.hiddenOnPairedDeviceKeys = [persona];
        if (change === 'lock') active = false;
        if (change === 'expiry') now += 900;
        return signed;
      });
      return backend;
    }, send, now: () => now })).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  expect(await reserveChildDirectoryRevision(binding, key, current)).toBe(2);
});
it('refuses a lock during revision encryption at the commit boundary', async () => {
  let active = true; const encrypt = crypto.encryptSecret;
  vi.spyOn(crypto, 'encryptSecret').mockImplementation(async (...args) => { const result = await encrypt(...args); active = false; return result; });
  await expect(reserveChildDirectoryRevision(binding, key, () => active)).rejects.toThrow('session changed');
  expect(await (await getDb()).getAll('privateVaultState')).toEqual([]);
});
it.each([null, { v: 1, ...binding, revision: 253402300799 }, { v: 1, ...binding, recipient: child, revision: 2 }])('refuses invalid or exhausted encrypted revision floors (%j)', async bad => {
  await reserveChildDirectoryRevision(binding, key, current);
  const db = await getDb(), row = (await db.getAll('privateVaultState'))[0];
  await db.put('privateVaultState', { ...row, encrypted: await crypto.encryptSecret(JSON.stringify(bad), key) });
  await expect(reserveChildDirectoryRevision(binding, key, current)).rejects.toThrow('revision floor');
});
it('does not reuse a revision after a transport failure', async () => {
  await expect(publishChildContactDirectory({ guardian, child, key, isCurrent: current, readScope: async () => scope(),
    signer: async () => new LocalSigningBackend('04'.repeat(32)), send: () => { throw new Error('socket closed'); }, now: () => 100 })).rejects.toThrow('socket closed');
  expect(await reserveChildDirectoryRevision(binding, key, current)).toBe(2);
});
it('publishes an empty withdrawal when the guardian returns to full control', async () => {
  const state = scope(); state.dependant.autonomyStage = 'full-control';
  const send = vi.fn();
  await publishChildContactDirectory({ guardian, child, key, isCurrent: current, readScope: async () => state,
    signer: async () => new LocalSigningBackend('04'.repeat(32)), send, now: () => 100 });
  expect(await openChildContactDirectory(send.mock.calls[0][0], { ...binding, availablePersonas: [persona], backend: recipient, now: 100, isCurrent: current }))
    .toMatchObject({ revision: 1, personas: [], entries: [] });
});
it('orders concurrent same-second publications for replaceable-event relays', async () => {
  const send = vi.fn();
  const options = { guardian, child, key, isCurrent: current, readScope: async () => scope(),
    signer: async () => new LocalSigningBackend('04'.repeat(32)), send, now: () => 100 };
  await Promise.all([publishChildContactDirectory(options), publishChildContactDirectory(options)]);
  const events = send.mock.calls.map(call => call[0]).sort((a, b) => a.created_at - b.created_at);
  expect(events.map(e => e.created_at)).toEqual([100, 101]);
  const views = await Promise.all(events.map(event => openChildContactDirectory(event, { ...binding, availablePersonas: [persona], backend: recipient, now: 101, isCurrent: current })));
  expect(views.map(v => v?.revision)).toEqual([1, 2]);
});

it('never asks with the dormant pair-time stub, even though the contacts list offers it', () => {
  // The paired-child seed before the guardian's first persona inventory: the
  // dependant id sits in a dormant real-identity slot and the persona is empty.
  const dep = 'a'.repeat(64);
  const seeded = { id: dep, mnemonic: '', naturalPerson: { publicKey: dep, privateKey: '', displayName: 'Robin' },
    persona: { publicKey: '', privateKey: '', displayName: '' }, primaryKeypair: 'natural-person', naturalPersonActive: false,
    isChild: true, createdAt: 1, encrypted: true, backedUp: true } as SignetIdentity;
  const listed = contactIdentityLists(seeded)[0];
  expect(listed).toEqual({ ownerIdentityPubkey: dep, label: 'Robin' });
  expect(resolveChildAskPersona(seeded, listed.ownerIdentityPubkey)).toBeNull();

  // Inventory lands: persona-first dependant, its persona key is the dep id.
  const merged = { ...seeded, naturalPerson: { publicKey: '', privateKey: '', displayName: '' }, primaryKeypair: 'persona',
    persona: { publicKey: dep, privateKey: '', displayName: 'Robin' },
    extraPersonas: [{ publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Gamer' }, { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Hid', hidden: true }] } as SignetIdentity;
  expect(resolveChildAskPersona(merged, dep)).toEqual({ pubkey: dep, label: 'Robin' });
  expect(resolveChildAskPersona(merged, 'b'.repeat(64))).toEqual({ pubkey: 'b'.repeat(64), label: 'Gamer' });
  // A hidden or unknown preference falls back to the built-in persona.
  expect(resolveChildAskPersona(merged, 'c'.repeat(64))).toEqual({ pubkey: dep, label: 'Robin' });
  expect(resolveChildAskPersona(merged, 'all')).toEqual({ pubkey: dep, label: 'Robin' });
});
