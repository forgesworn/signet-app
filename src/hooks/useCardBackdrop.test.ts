// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

const store = vi.hoisted(() => ({
  rows: new Map<string, Blob>(),
  guardian: new Map<string, { blob: Blob; hash: string }>(),
  failDelete: false,
}));

vi.mock('../lib/db', () => ({
  getCardBackdrop: vi.fn(async (pubkey: string) => store.rows.get(pubkey) ?? null),
  setCardBackdrop: vi.fn(async (pubkey: string, blob: Blob) => { store.rows.set(pubkey, blob); }),
  deleteCardBackdrop: vi.fn(async (pubkey: string) => {
    if (store.failDelete) throw new Error('idb unavailable');
    store.rows.delete(pubkey);
  }),
  getGuardianBackdrop: vi.fn(async (pubkey: string) => store.guardian.get(pubkey) ?? null),
  deleteGuardianBackdrop: vi.fn(async (pubkey: string) => { store.guardian.delete(pubkey); }),
}));

import { createElement, type ReactNode } from 'react';
import { DependantBackdropContext, type DependantBackdropLink } from '../lib/backdrop-send-context';
import {
  useCardBackdrop,
  refreshCardBackdrop,
  forgetCardBackdrop,
  peekCardBackdropUrl,
  resetCardBackdropCacheForTests,
  MAX_BACKDROP_SOURCE_BYTES,
} from './useCardBackdrop';

const PK = 'a'.repeat(64);
let counter = 0;

function imageFile(size = 8, type = 'image/png'): File {
  return new File([new Uint8Array(size)], 'pic.png', { type });
}

beforeEach(() => {
  store.rows.clear();
  store.guardian.clear();
  store.failDelete = false;
  counter = 0;
  resetCardBackdropCacheForTests();
  // jsdom has no canvas, no createImageBitmap and no object URLs.
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2000, height: 1000, close: vi.fn() })));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(cb => cb(new Blob(['jpeg'], { type: 'image/jpeg' })));
  URL.createObjectURL = vi.fn(() => `blob:test/${++counter}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useCardBackdrop.set', () => {
  it('rejects a file that is not an image', async () => {
    const { result } = renderHook(() => useCardBackdrop(PK));
    let out!: Awaited<ReturnType<typeof result.current.set>>;
    await act(async () => { out = await result.current.set(imageFile(8, 'text/plain')); });
    expect(out).toEqual({ ok: false, reason: 'Choose an image file.' });
    expect(store.rows.size).toBe(0);
  });

  it('rejects a file over the source size cap without decoding it', async () => {
    const { result } = renderHook(() => useCardBackdrop(PK));
    const big = imageFile();
    Object.defineProperty(big, 'size', { value: MAX_BACKDROP_SOURCE_BYTES + 1 });
    let out!: Awaited<ReturnType<typeof result.current.set>>;
    await act(async () => { out = await result.current.set(big); });
    expect(out.ok).toBe(false);
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });

  it('decodes with the EXIF orientation applied, like the avatar and thumbnail paths', async () => {
    const { result } = renderHook(() => useCardBackdrop(PK));
    await act(async () => { await result.current.set(imageFile()); });
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), { imageOrientation: 'from-image' });
  });

  it('stores the downscaled image, caches a URL and notifies the mounted hook', async () => {
    const { result } = renderHook(() => useCardBackdrop(PK));
    await waitFor(() => expect(result.current.url).toBeNull());
    let out!: Awaited<ReturnType<typeof result.current.set>>;
    await act(async () => { out = await result.current.set(imageFile()); });
    expect(out).toEqual({ ok: true });
    expect(store.rows.get(PK)?.type).toBe('image/jpeg');
    expect(peekCardBackdropUrl(PK)).toBe('blob:test/1');
    expect(result.current.url).toBe('blob:test/1');
  });
});

describe('useCardBackdrop.clear', () => {
  it('removes the row, revokes the URL and empties the hook', async () => {
    const { result } = renderHook(() => useCardBackdrop(PK));
    await act(async () => { await result.current.set(imageFile()); });
    await act(async () => { await result.current.clear(); });
    expect(store.rows.has(PK)).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test/1');
    expect(result.current.url).toBeNull();
  });
});

describe('forgetCardBackdrop', () => {
  it('deletes the row and clears the cached URL so mounted cards repaint without it', async () => {
    const { result } = renderHook(() => useCardBackdrop(PK));
    await act(async () => { await result.current.set(imageFile()); });
    expect(result.current.url).toBe('blob:test/1');

    await act(async () => { await forgetCardBackdrop(PK); });

    expect(store.rows.has(PK)).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test/1');
    // null means "known to have no backdrop", not "not loaded yet".
    expect(peekCardBackdropUrl(PK)).toBeNull();
    expect(result.current.url).toBeNull();
  });

  it('does not throw when the delete fails, and still clears the cached URL', async () => {
    const { result } = renderHook(() => useCardBackdrop(PK));
    await act(async () => { await result.current.set(imageFile()); });
    store.failDelete = true;

    await expect(forgetCardBackdrop(PK)).resolves.toBeUndefined();

    expect(peekCardBackdropUrl(PK)).toBeNull();
  });
});

describe('own pick beats the guardian\'s picture (child\'s phone)', () => {
  const jpeg = (t: string) => new Blob([t], { type: 'image/jpeg' });

  it('shows the guardian\'s picture when the child has none of their own', async () => {
    store.guardian.set(PK, { blob: jpeg('g'), hash: 'h'.repeat(64) });
    const { result } = renderHook(() => useCardBackdrop(PK));
    await waitFor(() => expect(result.current.url).not.toBeNull());
    expect(result.current.source).toBe('guardian');
  });

  it('prefers the child\'s own row when both exist', async () => {
    store.guardian.set(PK, { blob: jpeg('g'), hash: 'h'.repeat(64) });
    store.rows.set(PK, jpeg('own'));
    const { result } = renderHook(() => useCardBackdrop(PK));
    await waitFor(() => expect(result.current.url).not.toBeNull());
    expect(result.current.source).toBe('own');
  });

  it('picking their own replaces the guardian\'s picture, and keeps the guardian\'s row', async () => {
    store.guardian.set(PK, { blob: jpeg('g'), hash: 'h'.repeat(64) });
    const { result } = renderHook(() => useCardBackdrop(PK));
    await waitFor(() => expect(result.current.source).toBe('guardian'));
    await act(async () => { await result.current.set(imageFile()); });
    expect(result.current.source).toBe('own');
    expect(store.guardian.has(PK)).toBe(true);
  });

  it('removing their own pick lets the guardian\'s reappear', async () => {
    store.guardian.set(PK, { blob: jpeg('g'), hash: 'h'.repeat(64) });
    const { result } = renderHook(() => useCardBackdrop(PK));
    await waitFor(() => expect(result.current.source).toBe('guardian'));
    await act(async () => { await result.current.set(imageFile()); });
    expect(result.current.source).toBe('own');
    await act(async () => { await result.current.clear(); });
    expect(store.rows.has(PK)).toBe(false);
    expect(result.current.source).toBe('guardian');
    expect(result.current.url).not.toBeNull();
  });

  it('refreshCardBackdrop repaints a mounted card when the guardian\'s row lands or is dropped', async () => {
    const { result } = renderHook(() => useCardBackdrop(PK));
    await waitFor(() => expect(result.current.url).toBeNull());
    store.guardian.set(PK, { blob: jpeg('g'), hash: 'h'.repeat(64) });
    await act(async () => { await refreshCardBackdrop(PK); });
    expect(result.current.source).toBe('guardian');
    store.guardian.delete(PK);
    await act(async () => { await refreshCardBackdrop(PK); });
    expect(result.current.url).toBeNull();
    expect(result.current.source).toBeNull();
  });

  it('forgetCardBackdrop deletes both rows', async () => {
    store.guardian.set(PK, { blob: jpeg('g'), hash: 'h'.repeat(64) });
    store.rows.set(PK, jpeg('own'));
    await act(async () => { await forgetCardBackdrop(PK); });
    expect(store.rows.has(PK)).toBe(false);
    expect(store.guardian.has(PK)).toBe(false);
    expect(peekCardBackdropUrl(PK)).toBeNull();
  });

  it('forgetCardBackdrop still drops the guardian row when the own delete fails', async () => {
    store.guardian.set(PK, { blob: jpeg('g'), hash: 'h'.repeat(64) });
    store.failDelete = true;
    await expect(forgetCardBackdrop(PK)).resolves.toBeUndefined();
    expect(store.guardian.has(PK)).toBe(false);
  });
});

describe('a guardian\'s dependant card sends the backdrop on', () => {
  function withLink(link: DependantBackdropLink | null) {
    return ({ children }: { children: ReactNode }) =>
      createElement(DependantBackdropContext.Provider, { value: (pk: string) => (pk === PK ? link : null) }, children);
  }
  const mkLink = (over: Partial<DependantBackdropLink> = {}): DependantBackdropLink => ({
    name: 'Lily', canSend: true, unlocked: true, sent: false, send: vi.fn(async () => ({ ok: true as const })), remove: vi.fn(async () => undefined), ...over,
  });

  it('saves locally first, then sends the stored blob and reports how it went', async () => {
    const link = mkLink();
    const { result } = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(link) });
    let out!: Awaited<ReturnType<typeof result.current.set>>;
    await act(async () => { out = await result.current.set(imageFile()); });
    expect(out).toEqual({ ok: true, send: { ok: true } });
    expect(store.rows.get(PK)).toBeDefined();
    expect(link.send).toHaveBeenCalledWith(store.rows.get(PK));
  });

  it('a failed send keeps the local picture and returns the reason', async () => {
    const link = mkLink({ send: vi.fn(async () => ({ ok: false as const, reason: 'Server said no.' })) });
    const { result } = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(link) });
    let out!: Awaited<ReturnType<typeof result.current.set>>;
    await act(async () => { out = await result.current.set(imageFile()); });
    expect(out).toEqual({ ok: true, send: { ok: false, reason: 'Server said no.' } });
    expect(store.rows.has(PK)).toBe(true);
    expect(result.current.url).not.toBeNull();
  });

  it('does not send when the picture could not be saved locally', async () => {
    const link = mkLink();
    const { result } = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(link) });
    await act(async () => { await result.current.set(imageFile(8, 'text/plain')); });
    expect(link.send).not.toHaveBeenCalled();
  });

  it('removing clears locally then removes the copy sent to the child', async () => {
    const link = mkLink();
    const { result } = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(link) });
    await act(async () => { await result.current.set(imageFile()); });
    await act(async () => { await result.current.clear(); });
    expect(store.rows.has(PK)).toBe(false);
    expect(link.remove).toHaveBeenCalledTimes(1);
  });

  it('a link that cannot send (no phone paired, or a slot the publisher skips): nothing is sent, no link is shown, but Remove still clears the pointer', async () => {
    const link = mkLink({ canSend: false });
    const { result } = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(link) });
    let out!: Awaited<ReturnType<typeof result.current.set>>;
    await act(async () => { out = await result.current.set(imageFile()); });
    expect(out).toEqual({ ok: true });
    expect(link.send).not.toHaveBeenCalled();
    expect(result.current.link).toBeNull();
    await act(async () => { await result.current.clear(); });
    expect(store.rows.has(PK)).toBe(false);
    expect(link.remove).toHaveBeenCalledTimes(1);
  });

  it('while locked, Remove is blocked and clear() leaves both the picture and the pointer alone', async () => {
    const link = mkLink({ unlocked: false });
    const { result } = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(link) });
    await act(async () => { await result.current.set(imageFile()); });
    expect(result.current.removeBlocked).toBe(true);
    await act(async () => { await result.current.clear(); });
    expect(store.rows.has(PK)).toBe(true);
    expect(link.remove).not.toHaveBeenCalled();
  });

  it('starts the remote remove before the local delete, so a send still uploading is outranked at once', async () => {
    const order: string[] = [];
    const link = mkLink({ remove: vi.fn(async () => { order.push('remove-called'); }) });
    const { result } = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(link) });
    await act(async () => { await result.current.set(imageFile()); });
    const { deleteCardBackdrop } = await import('../lib/db');
    (deleteCardBackdrop as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { order.push('local-delete'); store.rows.delete(PK); });
    await act(async () => { await result.current.clear(); });
    expect(order).toEqual(['remove-called', 'local-delete']);
  });

  describe('unsent: the current local picture is not the one last sent', () => {
    // sha256 of the stored test blob ('jpeg'), as the send layer records it.
    const DIGEST = '41e5787e9f28562d07b891b1816b492309d646c0f2829743fa4963a9f9cc1d61';
    const storeJpeg = () => { store.rows.set(PK, new Blob(['jpeg'], { type: 'image/jpeg' })); };

    it('is true when no digest was ever recorded, false once it matches the local picture', async () => {
      storeJpeg();
      const first = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(mkLink({ sent: false })) });
      await waitFor(() => expect(first.result.current.unsent).toBe(true));
      first.unmount();
      const second = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(mkLink({ sent: true, sentDigest: DIGEST })) });
      await waitFor(() => expect(second.result.current.url).not.toBeNull());
      await new Promise(r => setTimeout(r, 20));
      expect(second.result.current.unsent).toBe(false);
    });

    it('is true after a remount when the sent digest is of an OLDER picture (a failed replace survives remounts)', async () => {
      storeJpeg();
      const { result } = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(mkLink({ sent: true, sentDigest: 'e'.repeat(64) })) });
      await waitFor(() => expect(result.current.unsent).toBe(true));
    });

    it('is false where nothing is sent (no link, a link that cannot send, or no local picture)', async () => {
      storeJpeg();
      const none = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(null) });
      const cannot = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(mkLink({ canSend: false })) });
      await new Promise(r => setTimeout(r, 20));
      expect(none.result.current.unsent).toBe(false);
      expect(cannot.result.current.unsent).toBe(false);
      store.rows.clear();
      resetCardBackdropCacheForTests();
      const empty = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(mkLink()) });
      await new Promise(r => setTimeout(r, 20));
      expect(empty.result.current.unsent).toBe(false);
    });

    it('retrySend sends the stored local picture again', async () => {
      storeJpeg();
      const link = mkLink({ sent: false });
      const { result } = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(link) });
      await waitFor(() => expect(result.current.url).not.toBeNull());
      let out: Awaited<ReturnType<typeof result.current.retrySend>> | undefined;
      await act(async () => { out = await result.current.retrySend(); });
      expect(out).toEqual({ ok: true });
      expect(link.send).toHaveBeenCalledWith(store.rows.get(PK));
    });

    it('is not reported unsent while its own send is in flight', async () => {
      storeJpeg();
      let finish!: (r: { ok: true }) => void;
      const link = mkLink({ sent: false, send: vi.fn(() => new Promise<{ ok: true }>(r => { finish = r; })) });
      const { result } = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(link) });
      await waitFor(() => expect(result.current.unsent).toBe(true));
      let pending!: Promise<unknown>;
      act(() => { pending = result.current.retrySend(); });
      await waitFor(() => expect(result.current.unsent).toBe(false));
      await act(async () => { finish({ ok: true }); await pending; });
    });
  });

  it('with no link (own persona, or a paired-child install) nothing is sent and no send result is returned', async () => {
    const { result } = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(null) });
    let out!: Awaited<ReturnType<typeof result.current.set>>;
    await act(async () => { out = await result.current.set(imageFile()); });
    expect(out).toEqual({ ok: true });
    expect(result.current.link).toBeNull();
  });
});
