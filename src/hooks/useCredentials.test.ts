// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCredentials } from './useCredentials';
import * as db from '../lib/db';
import type { StoredCredential } from '../types';

// Reset all IndexedDB stores between tests.
beforeEach(async () => {
  await db.purgeAllUserData();
});

// Minimal valid StoredCredential factory.
function makeCredential(overrides: Partial<StoredCredential> & { id: string }): StoredCredential {
  return {
    documentId: 'doc-1',
    keypairType: 'natural-person',
    event: '{"kind":30470}',
    verifierPubkey: 'a'.repeat(64),
    verifiedAt: 1_700_000_000,
    verifierStatus: 'confirmed',
    ...overrides,
  };
}

describe('useCredentials — no encryption key', () => {
  it('resolves with loading false and an empty credentials list when no key is provided', async () => {
    const { result } = renderHook(() => useCredentials());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.credentials).toEqual([]);
  });

  it('resolves with loading false when key is explicitly null', async () => {
    const { result } = renderHook(() => useCredentials(null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.credentials).toEqual([]);
  });
});

describe('useCredentials — loading state', () => {
  it('transitions loading to false after the DB read completes', async () => {
    const { result } = renderHook(() => useCredentials('fake-encryption-key'));

    // loading is either true initially or resolves very quickly — either way
    // it must be false once the async DB read finishes.
    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});

describe('useCredentials — initial load from DB', () => {
  it('returns credentials already in the DB when mounted with a key', async () => {
    const cred = makeCredential({ id: 'cred-1' });
    await db.saveCredential(cred, 'fake-encryption-key');

    const { result } = renderHook(() => useCredentials('fake-encryption-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.credentials).toHaveLength(1);
    expect(result.current.credentials[0].id).toBe('cred-1');
  });
});

describe('useCredentials — key transition', () => {
  it('loads credentials when encryptionKey changes from null to a value', async () => {
    const cred = makeCredential({ id: 'cred-key-change' });
    await db.saveCredential(cred, 'fake-encryption-key');

    // renderHook's initialProps + rerender pattern passes the new prop value
    // through to the hook factory on each render.
    const { result, rerender } = renderHook(
      ({ key }: { key: string | null }) => useCredentials(key),
      { initialProps: { key: null as string | null } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.credentials).toEqual([]);

    // Simulate unlock: provide an encryption key.
    rerender({ key: 'fake-encryption-key' });

    await waitFor(() => expect(result.current.credentials).toHaveLength(1));
    expect(result.current.credentials[0].id).toBe('cred-key-change');
  });
});

describe('useCredentials — addCredential', () => {
  it('persists a credential to the DB and adds it to the list', async () => {
    const { result } = renderHook(() => useCredentials('fake-encryption-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const cred = makeCredential({ id: 'cred-add' });

    await act(async () => {
      await result.current.addCredential(cred);
    });

    expect(result.current.credentials).toHaveLength(1);
    expect(result.current.credentials[0].id).toBe('cred-add');

    // Verify the record is actually in the DB, not just in React state.
    const stored = await db.getCredential('cred-add');
    expect(stored).toBeDefined();
    expect(stored?.id).toBe('cred-add');
  });
});

describe('useCredentials — multiple credentials', () => {
  it('returns all credentials when more than one exists in the DB', async () => {
    const creds = [
      makeCredential({ id: 'cred-a', documentId: 'doc-a' }),
      makeCredential({ id: 'cred-b', documentId: 'doc-b' }),
      makeCredential({ id: 'cred-c', documentId: 'doc-c' }),
    ];
    for (const c of creds) {
      await db.saveCredential(c, 'fake-encryption-key');
    }

    const { result } = renderHook(() => useCredentials('fake-encryption-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.credentials).toHaveLength(3);
    const ids = result.current.credentials.map((c) => c.id).sort();
    expect(ids).toEqual(['cred-a', 'cred-b', 'cred-c']);
  });
});

describe('useCredentials — refresh', () => {
  it('re-reads from the DB when refresh is called', async () => {
    const { result } = renderHook(() => useCredentials('fake-encryption-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.credentials).toHaveLength(0);

    // Write directly to the DB, bypassing the hook.
    await db.saveCredential(makeCredential({ id: 'cred-refresh' }), 'fake-encryption-key');

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.credentials).toHaveLength(1);
    expect(result.current.credentials[0].id).toBe('cred-refresh');
  });
});
