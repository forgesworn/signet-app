// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useContacts } from './useContacts';
import * as db from '../lib/db';
import type { Contact } from '../types';

// 64-char hex strings used as test pubkeys.
const OWNER_A = 'a'.repeat(64);
const OWNER_B = 'b'.repeat(64);
const PUBKEY_1 = '1'.repeat(64);
const PUBKEY_2 = '2'.repeat(64);

const ENCRYPTION_KEY = 'fake-key';

// Helper to build a minimal Contact.
function makeMember(pubkey: string, ownerPubkey: string, verifiedAt: number): Contact {
  return {
    pubkey,
    ownerPubkey,
    displayName: `Member ${pubkey.slice(0, 4)}`,
    sharedSecret: 'deadbeef',
    verifiedAt,
  };
}

// Reset all IndexedDB stores between tests.
beforeEach(async () => {
  await db.purgeAllUserData();
});

describe('useContacts — no ownerPubkey', () => {
  it('returns empty members and loading false when ownerPubkey is undefined', async () => {
    const { result } = renderHook(() => useContacts(undefined));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.members).toEqual([]);
  });
});

describe('useContacts — initial state', () => {
  it('starts with loading true before the DB resolves', () => {
    const { result } = renderHook(() => useContacts(OWNER_A, ENCRYPTION_KEY));

    // loading must be true on the very first synchronous render.
    expect(result.current.loading).toBe(true);
  });

  it('transitions loading to false and returns an empty list when the DB has no members', async () => {
    const { result } = renderHook(() => useContacts(OWNER_A, ENCRYPTION_KEY));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.members).toEqual([]);
  });
});

describe('useContacts — addMember', () => {
  it('adds a member and makes it appear in the list', async () => {
    const { result } = renderHook(() => useContacts(OWNER_A, ENCRYPTION_KEY));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const member = makeMember(PUBKEY_1, OWNER_A, 1_000_000);

    await act(async () => {
      await result.current.addMember(member);
    });

    expect(result.current.members).toHaveLength(1);
    expect(result.current.members[0].pubkey).toBe(PUBKEY_1);
    expect(result.current.members[0].displayName).toBe(member.displayName);
  });
});

describe('useContacts — removeMember', () => {
  it('removes a member so the list becomes empty again', async () => {
    const { result } = renderHook(() => useContacts(OWNER_A, ENCRYPTION_KEY));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const member = makeMember(PUBKEY_1, OWNER_A, 1_000_000);

    await act(async () => {
      await result.current.addMember(member);
    });
    expect(result.current.members).toHaveLength(1);

    await act(async () => {
      await result.current.removeMember(PUBKEY_1);
    });
    expect(result.current.members).toHaveLength(0);
  });
});

describe('useContacts — sort order', () => {
  it('returns members newest-first by verifiedAt', async () => {
    // Write two members directly to the DB with known timestamps so the sort
    // order can be asserted without relying on wall-clock timing.
    await db.saveContact(makeMember(PUBKEY_1, OWNER_A, 1_000_000), 'fake-encryption-key');
    await db.saveContact(makeMember(PUBKEY_2, OWNER_A, 2_000_000), 'fake-encryption-key');

    const { result } = renderHook(() => useContacts(OWNER_A));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.members).toHaveLength(2);
    // Higher verifiedAt value must come first.
    expect(result.current.members[0].pubkey).toBe(PUBKEY_2);
    expect(result.current.members[1].pubkey).toBe(PUBKEY_1);
  });
});

describe('useContacts — ownerPubkey scoping', () => {
  it('does not return members belonging to a different ownerPubkey', async () => {
    // Persist one member under OWNER_A and one under OWNER_B.
    await db.saveContact(makeMember(PUBKEY_1, OWNER_A, 1_000_000), 'fake-encryption-key');
    await db.saveContact(makeMember(PUBKEY_2, OWNER_B, 1_000_000), 'fake-encryption-key');

    const { result } = renderHook(() => useContacts(OWNER_A));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.members).toHaveLength(1);
    expect(result.current.members[0].pubkey).toBe(PUBKEY_1);
  });
});
