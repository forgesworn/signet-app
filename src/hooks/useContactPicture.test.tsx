// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { renderHook, waitFor, act } from '@testing-library/react';

const KEY = 'unlock-key';
const JPEG = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 0xff, 0xd9]);
const PK = 'ab'.repeat(32);
const CID = '1'.repeat(32);

let urlCount = 0;
const urlFor = new Map<string, Blob>();

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  urlCount = 0;
  urlFor.clear();
  URL.createObjectURL = vi.fn((b: Blob) => { const u = `blob:${++urlCount}`; urlFor.set(u, b); return u; }) as never;
  URL.revokeObjectURL = vi.fn() as never;
});

async function firstByte(url: string | null): Promise<number | null> {
  if (!url) return null;
  const blob = urlFor.get(url);
  return blob ? new Uint8Array(await blob.arrayBuffer())[4] : null;
}

describe('useContactPicture precedence', () => {
  it('own > shared > downloaded kind-0 > none', async () => {
    const db = await import('../lib/db');
    const pictures = await import('../lib/contact-pictures');
    const { useContactPicture } = await import('./useContactPicture');
    await db.saveContactPicture({ id: `kind0:${PK}`, jpeg: JPEG(1), sourceUrl: 'https://x/a.jpg', fetchedAt: 1, updatedAt: 1 }, KEY);

    const { result, rerender } = renderHook(
      ({ shared }: { shared: string | null }) => useContactPicture({ encryptionKey: KEY, pubkey: PK, directoryId: 'owner', contactId: CID, sharedUrl: shared }),
      { initialProps: { shared: null as string | null } },
    );
    // Downloaded thumbnail only.
    await waitFor(() => expect(result.current.url).not.toBeNull());
    expect(await firstByte(result.current.url)).toBe(1);

    // Shared avatar beats it.
    rerender({ shared: 'blob:shared' });
    await waitFor(() => expect(result.current.url).toBe('blob:shared'));

    // Own picture beats both.
    await act(async () => {
      await pictures.setOwnContactPicture(KEY, 'owner', CID, new Blob([new Uint8Array([1])]), undefined, { thumbnail: async () => JPEG(9) });
    });
    await waitFor(() => expect(result.current.hasOwn).toBe(true));
    await waitFor(async () => expect(await firstByte(result.current.url)).toBe(9));
    // Theirs (the shared avatar) is the badge on it.
    await waitFor(() => expect(result.current.badgeUrl).toBe('blob:shared'));

    // Without a shared avatar, the downloaded kind-0 thumbnail is the badge.
    rerender({ shared: null });
    await waitFor(async () => expect(await firstByte(result.current.badgeUrl)).toBe(1));
    expect(await firstByte(result.current.url)).toBe(9);
    rerender({ shared: 'blob:shared' });

    // Removing it falls back, with no badge left.
    await act(async () => { await pictures.removeOwnContactPicture(KEY, 'owner', CID); });
    await waitFor(() => expect(result.current.url).toBe('blob:shared'));
    expect(result.current.badgeUrl).toBeNull();
    rerender({ shared: null });
    await waitFor(async () => expect(await firstByte(result.current.url)).toBe(1));
    expect(result.current.badgeUrl).toBeNull();
  });

  describe('badge', () => {
    it('own + kind-0: main is own, badge is the kind-0 thumbnail', async () => {
      const db = await import('../lib/db');
      const pictures = await import('../lib/contact-pictures');
      const { useContactPicture } = await import('./useContactPicture');
      await db.saveContactPicture({ id: `kind0:${PK}`, jpeg: JPEG(1), sourceUrl: 'https://x/a.jpg', fetchedAt: 1, updatedAt: 1 }, KEY);
      await pictures.setOwnContactPicture(KEY, 'owner', CID, new Blob([new Uint8Array([1])]), undefined, { thumbnail: async () => JPEG(9) });
      const { result } = renderHook(() => useContactPicture({ encryptionKey: KEY, pubkey: PK, directoryId: 'owner', contactId: CID, sharedUrl: null }));
      await waitFor(() => expect(result.current.badgeUrl).not.toBeNull());
      expect(await firstByte(result.current.url)).toBe(9);
      expect(await firstByte(result.current.badgeUrl)).toBe(1);
      expect(result.current.hasOwn).toBe(true);
    });

    it('own only: no badge', async () => {
      const pictures = await import('../lib/contact-pictures');
      const { useContactPicture } = await import('./useContactPicture');
      await pictures.setOwnContactPicture(KEY, 'owner', CID, new Blob([new Uint8Array([1])]), undefined, { thumbnail: async () => JPEG(9) });
      const { result } = renderHook(() => useContactPicture({ encryptionKey: KEY, pubkey: PK, directoryId: 'owner', contactId: CID, sharedUrl: null }));
      await waitFor(() => expect(result.current.url).not.toBeNull());
      expect(await firstByte(result.current.url)).toBe(9);
      await new Promise(r => setTimeout(r, 20));
      expect(result.current.badgeUrl).toBeNull();
    });

    it('kind-0 only: main is the kind-0 thumbnail, no badge', async () => {
      const db = await import('../lib/db');
      const { useContactPicture } = await import('./useContactPicture');
      await db.saveContactPicture({ id: `kind0:${PK}`, jpeg: JPEG(1), sourceUrl: 'https://x/a.jpg', fetchedAt: 1, updatedAt: 1 }, KEY);
      const { result } = renderHook(() => useContactPicture({ encryptionKey: KEY, pubkey: PK, directoryId: 'owner', contactId: CID, sharedUrl: null }));
      await waitFor(() => expect(result.current.url).not.toBeNull());
      expect(await firstByte(result.current.url)).toBe(1);
      expect(result.current.badgeUrl).toBeNull();
      expect(result.current.hasOwn).toBe(false);
    });

    it('own + shared avatar (no kind-0): the shared avatar is the badge', async () => {
      const pictures = await import('../lib/contact-pictures');
      const { useContactPicture } = await import('./useContactPicture');
      await pictures.setOwnContactPicture(KEY, 'owner', CID, new Blob([new Uint8Array([1])]), undefined, { thumbnail: async () => JPEG(9) });
      const { result } = renderHook(() => useContactPicture({ encryptionKey: KEY, pubkey: PK, directoryId: 'owner', contactId: CID, sharedUrl: 'blob:shared' }));
      await waitFor(() => expect(result.current.badgeUrl).toBe('blob:shared'));
      expect(await firstByte(result.current.url)).toBe(9);
    });
  });

  describe('backup state', () => {
    it('is null with no own picture, and follows the own row as it changes', async () => {
      const pictures = await import('../lib/contact-pictures');
      const { useContactPicture } = await import('./useContactPicture');
      const { result } = renderHook(() => useContactPicture({ encryptionKey: KEY, pubkey: PK, directoryId: 'owner', contactId: CID, sharedUrl: null }));
      await waitFor(() => expect(pictures.contactPicturesVersion()).toBeGreaterThan(0));
      expect(result.current.backup).toBeNull();

      await act(async () => {
        await pictures.setOwnContactPicture(KEY, 'owner', CID, new Blob([new Uint8Array([1])]), undefined, { thumbnail: async () => JPEG(9), backup: 'pending' });
      });
      await waitFor(() => expect(result.current.backup).toBe('pending'));

      await act(async () => { await pictures.setOwnPictureBackupState(KEY, 'owner', CID, 'synced'); });
      await waitFor(() => expect(result.current.backup).toBe('synced'));

      await act(async () => { await pictures.removeOwnContactPicture(KEY, 'owner', CID); });
      await waitFor(() => expect(result.current.backup).toBeNull());
    });

    it('a row saved without a state reads as local', async () => {
      const pictures = await import('../lib/contact-pictures');
      const { useContactPicture } = await import('./useContactPicture');
      await pictures.setOwnContactPicture(KEY, 'owner', CID, new Blob([new Uint8Array([1])]), undefined, { thumbnail: async () => JPEG(9) });
      const { result } = renderHook(() => useContactPicture({ encryptionKey: KEY, pubkey: PK, directoryId: 'owner', contactId: CID, sharedUrl: null }));
      await waitFor(() => expect(result.current.backup).toBe('local'));
    });
  });

  it('shows nothing when locked or with nothing stored', async () => {
    const { useContactPicture } = await import('./useContactPicture');
    const locked = renderHook(() => useContactPicture({ encryptionKey: null, pubkey: PK }));
    expect(locked.result.current.url).toBeNull();
    const empty = renderHook(() => useContactPicture({ encryptionKey: KEY, pubkey: PK, sharedUrl: null }));
    await new Promise(r => setTimeout(r, 20));
    expect(empty.result.current.url).toBeNull();
  });
});
