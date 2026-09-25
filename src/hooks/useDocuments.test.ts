// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useDocuments } from './useDocuments';
import * as db from '../lib/db';
import type { IdentityDocument } from '../types';

// Reset all IndexedDB stores between tests.
beforeEach(async () => {
  await db.purgeAllUserData();
});

// Helper to build a minimal valid IdentityDocument.
function makeDoc(overrides: Partial<IdentityDocument> & Pick<IdentityDocument, 'id' | 'ownerPubkey'>): IdentityDocument {
  return {
    country: 'GB',
    documentType: 'passport',
    fullName: 'Test Person',
    dateOfBirth: '1990-01-01',
    documentNumber: 'AB123456',
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    ...overrides,
  };
}

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);

describe('useDocuments — no ownerPubkey', () => {
  it('returns an empty list with loading false when no pubkey is supplied', async () => {
    const { result } = renderHook(() => useDocuments());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.documents).toEqual([]);
  });
});

describe('useDocuments — loading state', () => {
  it('starts with loading true, then settles to false', async () => {
    const { result } = renderHook(() => useDocuments(PUBKEY_A));

    // loading must be true on the very first render before the async fetch completes
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});

describe('useDocuments — empty store', () => {
  it('returns an empty list when the owner has no documents', async () => {
    const { result } = renderHook(() => useDocuments(PUBKEY_A));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.documents).toEqual([]);
  });
});

describe('useDocuments — addDocument', () => {
  it('appends the document so it appears in the list', async () => {
    const { result } = renderHook(() => useDocuments(PUBKEY_A, 'fake-encryption-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const doc = makeDoc({ id: 'doc-1', ownerPubkey: PUBKEY_A });

    await act(async () => {
      await result.current.addDocument(doc);
    });

    expect(result.current.documents).toHaveLength(1);
    expect(result.current.documents[0].id).toBe('doc-1');
    expect(result.current.documents[0].ownerPubkey).toBe(PUBKEY_A);
  });
});

describe('useDocuments — removeDocument', () => {
  it('removes the document so the list is empty again', async () => {
    const { result } = renderHook(() => useDocuments(PUBKEY_A, 'fake-encryption-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const doc = makeDoc({ id: 'doc-2', ownerPubkey: PUBKEY_A });

    await act(async () => {
      await result.current.addDocument(doc);
    });
    expect(result.current.documents).toHaveLength(1);

    await act(async () => {
      await result.current.removeDocument('doc-2');
    });
    expect(result.current.documents).toHaveLength(0);
  });
});

describe('useDocuments — ownerPubkey scoping', () => {
  it('does not return documents belonging to a different owner', async () => {
    // Pre-populate a document for PUBKEY_B directly in the DB.
    await db.saveDocument(makeDoc({ id: 'doc-b', ownerPubkey: PUBKEY_B }), 'fake-encryption-key');

    // Mount the hook scoped to PUBKEY_A — should not see PUBKEY_B's document.
    const { result } = renderHook(() => useDocuments(PUBKEY_A, 'fake-encryption-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.documents).toHaveLength(0);
  });
});

describe('useDocuments — multiple documents', () => {
  it('returns all documents belonging to the owner', async () => {
    const { result } = renderHook(() => useDocuments(PUBKEY_A, 'fake-encryption-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const docOne = makeDoc({ id: 'doc-multi-1', ownerPubkey: PUBKEY_A, documentType: 'passport' });
    const docTwo = makeDoc({ id: 'doc-multi-2', ownerPubkey: PUBKEY_A, documentType: 'driving_licence' });
    const docThree = makeDoc({ id: 'doc-multi-3', ownerPubkey: PUBKEY_A, documentType: 'national_id' });

    await act(async () => {
      await result.current.addDocument(docOne);
      await result.current.addDocument(docTwo);
      await result.current.addDocument(docThree);
    });

    expect(result.current.documents).toHaveLength(3);
    const ids = result.current.documents.map(d => d.id);
    expect(ids).toContain('doc-multi-1');
    expect(ids).toContain('doc-multi-2');
    expect(ids).toContain('doc-multi-3');
  });
});
