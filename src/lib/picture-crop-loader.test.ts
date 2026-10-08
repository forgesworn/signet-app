// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCropPicture } from './picture-crop-loader';

class FakeImage {
  static next: { width: number; height: number } | 'error' = { width: 4000, height: 3000 };
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) {
    queueMicrotask(() => {
      if (FakeImage.next === 'error') { this.onerror?.(); return; }
      this.naturalWidth = FakeImage.next.width;
      this.naturalHeight = FakeImage.next.height;
      this.onload?.();
    });
  }
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('loadCropPicture', () => {
  it('resolves the oriented size with an object URL, revoked on release', async () => {
    const create = vi.fn(() => 'blob:photo');
    const revoke = vi.fn();
    URL.createObjectURL = create as never;
    URL.revokeObjectURL = revoke as never;
    vi.stubGlobal('Image', FakeImage);
    FakeImage.next = { width: 3000, height: 4000 };
    const p = await loadCropPicture(new Blob([new Uint8Array([1])]));
    expect([p.src, p.width, p.height]).toEqual(['blob:photo', 3000, 4000]);
    expect(revoke).not.toHaveBeenCalled();
    p.release();
    expect(revoke).toHaveBeenCalledWith('blob:photo');
  });

  it('rejects, revoking the URL, when the image cannot be decoded or has no size', async () => {
    const revoke = vi.fn();
    URL.createObjectURL = vi.fn(() => 'blob:bad') as never;
    URL.revokeObjectURL = revoke as never;
    vi.stubGlobal('Image', FakeImage);
    FakeImage.next = 'error';
    await expect(loadCropPicture(new Blob([]))).rejects.toThrow();
    FakeImage.next = { width: 0, height: 0 };
    await expect(loadCropPicture(new Blob([]))).rejects.toThrow();
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
