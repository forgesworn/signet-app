// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import type { SignetIdentity } from '../types';
import * as db from '../lib/db';
import { useIdentity } from './useIdentity';

const KEY = 'test-wrapped-unlock-key';
const raw = new Uint8Array(32).fill(0x22);
const publicKey = getPublicKey(raw);
const owner: SignetIdentity = {
  id: 'a'.repeat(64), mnemonic: '', primaryKeypair: 'persona', isChild: false, createdAt: 1,
  naturalPerson: {publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Owner'},
  persona: {publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Main'},
};
beforeEach(async () => {
  await db.purgeAllUserData();
  await db.saveIdentityEncrypted(owner, KEY);
  await db.savePreferences({id: 'current', theme: 'system', activeAccountId: owner.id});
});

describe('restored imported raw-key persistence', () => {
  it('rechecks approval at the actual write after encryption and preserves a concurrent identity change', async () => {
    const {result} = renderHook(() => useIdentity(KEY));
    await waitFor(() => expect(result.current.identity?.id).toBe(owner.id));
    let approvals = 0;
    await act(async () => {
      await expect(result.current.addImportedPersonas([{privateKey: raw, name: 'New'}], KEY, () => {
        if (++approvals === 3) throw new Error('Locked while encrypting');
      })).rejects.toThrow('Locked while encrypting');
    });
    expect((await db.loadIdentityDecrypted(owner.id, KEY))?.extraPersonas).toBeUndefined();
    const before = (await db.getIdentity(owner.id))!;
    await db.saveIdentityEncrypted({...owner, persona: {...owner.persona, displayName: 'Changed in another tab'}}, KEY);
    await expect(db.saveIdentityEncrypted(owner, KEY, {expectedStored: before, assertAuthorised: () => {}})).rejects.toThrow(/changed/);
    expect((await db.loadIdentityDecrypted(owner.id, KEY))?.persona.displayName).toBe('Changed in another tab');
  }, 120_000);
  it('restores ten keys in one save, refuses collisions and never persists after revoked approval', async () => {
    const {result} = renderHook(() => useIdentity(KEY));
    await waitFor(() => expect(result.current.identity?.id).toBe(owner.id));
    const accounts = Array.from({length: 10}, (_, i) => ({privateKey: new Uint8Array(32).fill(i + 1), name: `Account ${i + 1}`}));
    const denied = vi.fn(() => { throw new Error('Signet locked'); });
    await act(async () => {
      await expect(result.current.addImportedPersonas(accounts, KEY, denied)).rejects.toThrow('Signet locked');
    });
    expect((await db.loadIdentityDecrypted(owner.id, KEY))?.extraPersonas).toBeUndefined();
    await act(async () => { await result.current.addImportedPersonas(accounts, KEY, () => {}); });
    const saved = await db.loadIdentityDecrypted(owner.id, KEY);
    expect(saved?.extraPersonas).toHaveLength(10);
    saved!.extraPersonas!.forEach((p, i) => expect(p).toMatchObject({imported: true, derivationName: '', displayName: `Account ${i + 1}`, publicKey: getPublicKey(accounts[i].privateKey)}));
    await act(async () => {
      await expect(result.current.addImportedPersonas([{privateKey: new Uint8Array(32).fill(20), name: 'New'}, accounts[0]], KEY, () => {})).rejects.toThrow(/already/);
    });
    expect((await db.loadIdentityDecrypted(owner.id, KEY))?.extraPersonas).toHaveLength(10);
    expect(accounts[0].privateKey.every(b => b === 1)).toBe(true);
  }, 120_000);
  it('saves as imported without deriving a new identity or consuming caller bytes', async () => {
    const {result} = renderHook(() => useIdentity(KEY));
    await waitFor(() => expect(result.current.identity?.id).toBe(owner.id));
    await act(async () => { await result.current.addImportedPersona(raw, 'Existing', KEY); });
    const saved = await db.loadIdentityDecrypted(owner.id, KEY);
    expect(saved?.extraPersonas?.[0]).toMatchObject({publicKey, privateKey: '22'.repeat(32), imported: true, derivationName: ''});
    expect(raw.every(byte => byte === 0x22)).toBe(true);
  });

  it('rechecks current authorisation after loading storage and refuses before saving', async () => {
    const {result} = renderHook(() => useIdentity(KEY));
    await waitFor(() => expect(result.current.identity?.id).toBe(owner.id));
    const assertAuthorised = vi.fn(() => { throw new Error('Signet locked'); });
    await act(async () => {
      await expect(result.current.addImportedPersona(raw, 'Existing', KEY, {assertAuthorised})).rejects.toThrow('Signet locked');
    });
    expect(assertAuthorised).toHaveBeenCalled();
    expect((await db.loadIdentityDecrypted(owner.id, KEY))?.extraPersonas).toBeUndefined();
  });
});
