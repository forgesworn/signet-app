import { describe, it, expect, vi } from 'vitest';
import { saveNewContact, type NewContactSaveOps } from './contacts-v2-new-contact-save';

const OWNER = 'a'.repeat(64);
const KEY = 'c'.repeat(64);
const contact = { type: 'person' as const, displayName: 'Alice', tier: 'ken' as const, lifecycle: 'active' as const };
const method = { kind: 'other' as const, label: 'NIP-05', value: 'alice@example.com', verification: 'unverified' as const, sharingPolicy: 'private' as const };

function fakeOps(withOrigin = true) {
  const calls: string[] = [];
  const ops: NewContactSaveOps = {
    addContact: vi.fn(async () => { calls.push('add'); return 'cid'; }),
    addContactMethod: vi.fn(async () => { calls.push('method'); return 'mid'; }),
    addIdentity: vi.fn(async () => { calls.push('identity'); return 'iid'; }),
    recordOrigin: withOrigin ? vi.fn(async () => { calls.push('origin'); }) : undefined,
  };
  return { ops, calls };
}

describe('saveNewContact', () => {
  it('passes the looked-up key through to add-identity, unverified and direct', async () => {
    const { ops, calls } = fakeOps();
    const id = await saveNewContact(ops, OWNER, contact, [method], { pubkey: KEY, nip05: 'alice@example.com' }, () => 1700000000000);
    expect(id).toBe('cid');
    expect(calls).toEqual(['add', 'method', 'identity', 'origin']);
    expect(ops.addContact).toHaveBeenCalledWith({ ...contact, ownerIdentityPubkey: OWNER });
    expect(ops.addContactMethod).toHaveBeenCalledWith('cid', method);
    expect(ops.addIdentity).toHaveBeenCalledWith('cid', { pubkey: KEY, provenance: 'direct', verification: 'unverified' }, { refuseMerge: true });
    expect(ops.recordOrigin).toHaveBeenCalledWith('cid', expect.objectContaining({ method: 'nip05', addedAt: 1700000000000 }));
  });

  it('writes no identity when no key was found', async () => {
    const { ops, calls } = fakeOps();
    await saveNewContact(ops, OWNER, contact, [method]);
    expect(calls).toEqual(['add', 'method']);
  });

  it('skips the origin when the hook is not scoped to one identity list', async () => {
    const { ops, calls } = fakeOps(false);
    await saveNewContact(ops, OWNER, contact, [], { pubkey: KEY, nip05: 'alice@example.com' });
    expect(calls).toEqual(['add', 'identity']);
  });
});
