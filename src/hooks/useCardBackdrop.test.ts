// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

const store = vi.hoisted(() => ({
  rows: new Map<string, Blob>(),
  failDelete: false,
}));

vi.mock('../lib/db', () => ({
  getCardBackdrop: vi.fn(async (pubkey: string) => store.rows.get(pubkey) ?? null),
  setCardBackdrop: vi.fn(async (pubkey: string, blob: Blob) => { store.rows.set(pubkey, blob); }),
  deleteCardBackdrop: vi.fn(async (pubkey: string) => {
    if (store.failDelete) throw new Error('idb unavailable');
    store.rows.delete(pubkey);
  }),
}));

import {
  useCardBackdrop,
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
