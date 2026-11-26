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
    name: 'Lily', sent: false, send: vi.fn(async () => ({ ok: true as const })), remove: vi.fn(async () => undefined), ...over,
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

  it('with no link (own persona, or a paired-child install) nothing is sent and no send result is returned', async () => {
    const { result } = renderHook(() => useCardBackdrop(PK), { wrapper: withLink(null) });
    let out!: Awaited<ReturnType<typeof result.current.set>>;
    await act(async () => { out = await result.current.set(imageFile()); });
    expect(out).toEqual({ ok: true });
    expect(result.current.link).toBeNull();
  });
});
