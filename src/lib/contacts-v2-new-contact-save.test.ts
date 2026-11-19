// @vitest-environment jsdom
// The real contacts hook, the real reducer and the real store: the save is one
// atomic batch, and a key a deleted or archived contact holds is found.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useContactsV2 } from '../hooks/useContactsV2';
import * as db from './db';
import type { MutationActor } from './contacts-v2-mutations';
import { ConfirmMergeRefusedError } from './contacts-v2-key-holders';
import { findContactHoldingKey, saveNewContact } from './contacts-v2-new-contact-save';

const KEY = 'correct-horse-battery-staple';
const GUARDIAN = '1'.repeat(64);
const OWNER = 'a'.repeat(64);
const K = 'c'.repeat(64);
const DIR = 'owner';
const TIMEOUT = 45_000;
const actor: MutationActor = { actorPubkey: OWNER, actorRole: 'owner', actorDeviceId: 'd'.repeat(32) };
const context = { activeGuardianPubkeys: [GUARDIAN], defaultChildCeiling: 'ken' as const, directoryIsDependant: false };
const contact = { type: 'person' as const, displayName: 'Alice', tier: 'ken' as const, lifecycle: 'active' as const };
const method = { kind: 'other' as const, label: 'NIP-05', value: 'alice@example.com', verification: 'unverified' as const, sharingPolicy: 'private' as const };

beforeEach(async () => { await db.purgeAllUserData(); });

function render(ownerIdentityPubkey?: string) {
  return renderHook(() => useContactsV2({ directoryId: DIR, encryptionKey: KEY, actor, context, ownerIdentityPubkey }));
}

describe('saveNewContact (real hook)', () => {
  it('writes the contact, method, key and exactly one NIP-05 origin in a single batch', async () => {
    const { result } = render(OWNER);
    await waitFor(() => expect(result.current.loading).toBe(false));
    const save = vi.spyOn(db, 'saveContactOperationsV2');
    let id = '';
    await act(async () => { id = await saveNewContact(result.current, OWNER, contact, [method], { pubkey: K }); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].map(o => o.action)).toEqual(['add', 'add-method', 'add-identity', 'record-origin']);
    save.mockRestore();
    await waitFor(() => expect(result.current.records).toHaveLength(1));
    const rec = result.current.records[0];
    expect(rec.contactId).toBe(id);
    expect(rec.identities.map(i => [i.pubkey, i.provenance, i.verification])).toEqual([[K, 'direct', 'unverified']]);
    expect(rec.contactMethods.map(m => [m.kind, m.label, m.value])).toEqual([['other', 'NIP-05', 'alice@example.com']]);
    expect(rec.origins?.map(o => o.method)).toEqual(['nip05']);
    expect(rec.listMemberships?.map(m => m.ownerIdentityPubkey) ?? [OWNER]).toEqual([OWNER]);
  }, TIMEOUT);

  it('records one "manual" origin for a keyless contact, and the same batch works in the all-lists view', async () => {
    const { result } = render(undefined);
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await saveNewContact(result.current, OWNER, contact, []); });
    await waitFor(() => expect(result.current.records).toHaveLength(1));
    expect(result.current.records[0].origins?.map(o => o.method)).toEqual(['manual']);
    await act(async () => { await saveNewContact(result.current, OWNER, { ...contact, displayName: 'Bea' }, [], { pubkey: 'd'.repeat(64) }); });
    await waitFor(() => expect(result.current.records).toHaveLength(2));
    const bea = result.current.records.find(r => r.displayName === 'Bea')!;
    expect(bea.origins?.map(o => o.method)).toEqual(['nip05']);
  }, TIMEOUT);

  it('a deleted holder refuses the save and leaves NOTHING behind, every time', async () => {
    const { result } = render(OWNER);
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      const bob = await saveNewContact(result.current, OWNER, { ...contact, displayName: 'Bob' }, [], { pubkey: K });
      await result.current.removeContact(bob);
    });
    const before = await db.listContactOperationsV2(DIR, KEY);
    for (let i = 0; i < 2; i++) {
      let error: unknown;
      await act(async () => {
        try { await saveNewContact(result.current, OWNER, contact, [method], { pubkey: K }); } catch (e) { error = e; }
      });
      expect(error).toBeInstanceOf(ConfirmMergeRefusedError);
      expect((error as ConfirmMergeRefusedError).refusal).toMatchObject({ displayName: 'Bob', state: 'deleted' });
    }
    expect(await db.listContactOperationsV2(DIR, KEY)).toHaveLength(before.length);
    expect(result.current.records.map(r => [r.displayName, r.lifecycle])).toEqual([['Bob', 'removed']]);
  }, TIMEOUT);

  it('an active holder refuses the save too', async () => {
    const { result } = render(OWNER);
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await saveNewContact(result.current, OWNER, { ...contact, displayName: 'Bob' }, [], { pubkey: K }); });
    let error: unknown;
    await act(async () => { try { await saveNewContact(result.current, OWNER, contact, [], { pubkey: K }); } catch (e) { error = e; } });
    expect((error as ConfirmMergeRefusedError).refusal).toMatchObject({ displayName: 'Bob', state: 'active' });
    expect(result.current.records).toHaveLength(1);
  }, TIMEOUT);
});

describe('findContactHoldingKey (the App predicate, on real records)', () => {
  it('finds active, deleted and archived holders, and ignores a key taken off a contact', async () => {
    const { result } = render(OWNER);
    await waitFor(() => expect(result.current.loading).toBe(false));
    const keys = ['1', '2', '3', '4'].map(c => c.repeat(64).replace(/^./, 'e'));
    const ids: string[] = [];
    await act(async () => {
      for (const [i, k] of keys.entries()) ids.push(await saveNewContact(result.current, OWNER, { ...contact, displayName: `P${i}` }, [], { pubkey: k }));
    });
    await waitFor(() => expect(result.current.records).toHaveLength(4));
    await act(async () => {
      await result.current.removeContact(ids[1]);
      await result.current.archiveContact(ids[2]);
      const item = result.current.records.find(r => r.contactId === ids[3])!.identities[0].itemId;
      await result.current.removeItem(ids[3], item);
    });
    await waitFor(() => expect(result.current.records.find(r => r.contactId === ids[3])?.identities).toHaveLength(0));
    const find = (k: string) => findContactHoldingKey(result.current.records, k);
    expect(find(keys[0])).toMatchObject({ displayName: 'P0', state: 'active' });
    expect(find(keys[1])).toMatchObject({ displayName: 'P1', state: 'deleted' });
    expect(find(keys[2])).toMatchObject({ displayName: 'P2', state: 'archived' });
    expect(find(keys[3])).toBeNull();
    expect(find('f'.repeat(64))).toBeNull();
  }, TIMEOUT);
});
