// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAuthorizedSites } from './useAuthorizedSites';
import * as db from '../lib/db';
import type { AuthorizedSite } from '../types';

// A valid 64-char hex pubkey used across tests.
const PUBKEY = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);

// Reset all IndexedDB stores between tests.
beforeEach(async () => {
  await db.purgeAllUserData();
});

describe('useAuthorizedSites — initial state', () => {
  it('starts with loading true and an empty sites list', async () => {
    const { result } = renderHook(() => useAuthorizedSites());

    // loading should be true on the very first render
    expect(result.current.loading).toBe(true);
    expect(result.current.sites).toEqual([]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sites).toEqual([]);
  });
});

describe('useAuthorizedSites — authorize (new site)', () => {
  it('creates a new entry with correct fields', async () => {
    const { result } = renderHook(() => useAuthorizedSites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const before = Math.floor(Date.now() / 1000);
    await act(async () => {
      await result.current.authorize(
        'https://example.com',
        'Example',
        'natural-person',
        PUBKEY,
      );
    });
    const after = Math.floor(Date.now() / 1000);

    expect(result.current.sites).toHaveLength(1);
    const site = result.current.sites[0];
    expect(site.origin).toBe('https://example.com');
    expect(site.name).toBe('Example');
    expect(site.keypairUsed).toBe('natural-person');
    expect(site.pubkeyShared).toBe(PUBKEY);
    expect(site.authorizedAt).toBeGreaterThanOrEqual(before);
    expect(site.authorizedAt).toBeLessThanOrEqual(after);
    expect(site.lastUsedAt).toBeGreaterThanOrEqual(before);
    expect(site.lastUsedAt).toBeLessThanOrEqual(after);
  });
});

describe('useAuthorizedSites — authorize (update existing)', () => {
  it('updates lastUsedAt, keypairUsed, pubkeyShared without creating a duplicate', async () => {
    const { result } = renderHook(() => useAuthorizedSites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.authorize(
        'https://example.com',
        'Example',
        'natural-person',
        PUBKEY,
      );
    });

    const firstLastUsed = result.current.sites[0].lastUsedAt;
    const firstAuthorisedAt = result.current.sites[0].authorizedAt;

    // Authorise again with different keypair and pubkey
    await act(async () => {
      await result.current.authorize(
        'https://example.com',
        'Example Renamed',
        'persona',
        PUBKEY_B,
      );
    });

    expect(result.current.sites).toHaveLength(1);
    const updated = result.current.sites[0];
    expect(updated.keypairUsed).toBe('persona');
    expect(updated.pubkeyShared).toBe(PUBKEY_B);
    expect(updated.lastUsedAt).toBeGreaterThanOrEqual(firstLastUsed);
    // authorizedAt must not change on update
    expect(updated.authorizedAt).toBe(firstAuthorisedAt);
  });
});

describe('useAuthorizedSites — authorize (validation)', () => {
  it('rejects an invalid URL — sites remains empty', async () => {
    const { result } = renderHook(() => useAuthorizedSites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.authorize('not-a-url', 'Bad', 'natural-person', PUBKEY);
    });

    expect(result.current.sites).toHaveLength(0);
  });

  it('rejects an origin longer than 2048 characters — sites remains empty', async () => {
    const { result } = renderHook(() => useAuthorizedSites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Construct a syntactically valid URL that exceeds the 2048-char limit.
    const longPath = 'a'.repeat(2050);
    const longOrigin = `https://example.com/${ longPath }`;
    await act(async () => {
      await result.current.authorize(longOrigin, 'Long', 'natural-person', PUBKEY);
    });

    expect(result.current.sites).toHaveLength(0);
  });

  it('rejects a pubkey that is not 64 hex characters — sites remains empty', async () => {
    const { result } = renderHook(() => useAuthorizedSites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      // Only 63 chars
      await result.current.authorize('https://example.com', 'Bad', 'natural-person', 'a'.repeat(63));
    });

    expect(result.current.sites).toHaveLength(0);
  });

  it('rejects a pubkey containing non-hex characters — sites remains empty', async () => {
    const { result } = renderHook(() => useAuthorizedSites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.authorize(
        'https://example.com',
        'Bad',
        'natural-person',
        'z'.repeat(64), // 'z' is not a hex character
      );
    });

    expect(result.current.sites).toHaveLength(0);
  });

  it('truncates site name to 200 characters', async () => {
    const { result } = renderHook(() => useAuthorizedSites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const longName = 'x'.repeat(300);
    await act(async () => {
      await result.current.authorize('https://example.com', longName, 'natural-person', PUBKEY);
    });

    expect(result.current.sites).toHaveLength(1);
    expect(result.current.sites[0].name).toHaveLength(200);
    expect(result.current.sites[0].name).toBe('x'.repeat(200));
  });
});

describe('useAuthorizedSites — revoke', () => {
  it('removes the site so sites becomes empty again', async () => {
    const { result } = renderHook(() => useAuthorizedSites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.authorize('https://example.com', 'Example', 'natural-person', PUBKEY);
    });
    expect(result.current.sites).toHaveLength(1);

    const id = result.current.sites[0].id;
    await act(async () => {
      await result.current.revoke(id);
    });

    expect(result.current.sites).toHaveLength(0);
  });
});

describe('useAuthorizedSites — sort order', () => {
  it('returns sites newest-first by lastUsedAt', async () => {
    const { result } = renderHook(() => useAuthorizedSites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Save two sites directly into the DB with known timestamps so we can
    // assert the order without relying on wall-clock timing.
    const older: AuthorizedSite = {
      id: 'site-older',
      origin: 'https://older.example.com',
      name: 'Older',
      keypairUsed: 'natural-person',
      pubkeyShared: PUBKEY,
      authorizedAt: 1_000_000,
      lastUsedAt: 1_000_000,
    };
    const newer: AuthorizedSite = {
      id: 'site-newer',
      origin: 'https://newer.example.com',
      name: 'Newer',
      keypairUsed: 'natural-person',
      pubkeyShared: PUBKEY,
      authorizedAt: 2_000_000,
      lastUsedAt: 2_000_000,
    };

    await db.saveAuthorizedSite(older);
    await db.saveAuthorizedSite(newer);

    // Trigger a refresh by re-rendering with a fresh hook instance.
    const { result: result2 } = renderHook(() => useAuthorizedSites());
    await waitFor(() => expect(result2.current.loading).toBe(false));

    expect(result2.current.sites).toHaveLength(2);
    expect(result2.current.sites[0].id).toBe('site-newer');
    expect(result2.current.sites[1].id).toBe('site-older');
  });
});

describe('useAuthorizedSites — concurrent authorize race', () => {
  it('collapses duplicate-origin writes into one row', async () => {
    const { result } = renderHook(() => useAuthorizedSites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Both writes target the same origin but run concurrently. Prior to the
    // transactional upsert, each call did a separate getAuthorizedSiteByOrigin
    // (returning undefined twice), then each allocated a fresh id and put a
    // duplicate row.
    await act(async () => {
      await Promise.all([
        result.current.authorize('https://dup.example.com', 'One', 'natural-person', PUBKEY),
        result.current.authorize('https://dup.example.com', 'Two', 'persona', PUBKEY_B),
      ]);
    });

    const stored = await db.getAuthorizedSites();
    const dupRows = stored.filter(s => s.origin === 'https://dup.example.com');
    expect(dupRows).toHaveLength(1);
  });

  it('rejects non-web schemes (javascript:, data:, file:)', async () => {
    const { result } = renderHook(() => useAuthorizedSites());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.authorize('javascript:alert(1)', 'X', 'natural-person', PUBKEY);
      await result.current.authorize('data:text/html,<x>', 'X', 'natural-person', PUBKEY);
      await result.current.authorize('file:///etc/passwd', 'X', 'natural-person', PUBKEY);
    });

    expect(result.current.sites).toHaveLength(0);
  });
});
