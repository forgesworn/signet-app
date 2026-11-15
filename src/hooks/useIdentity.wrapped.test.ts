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
