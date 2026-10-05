// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeThumbnail, resetThumbnailWorkerForTests } from './picture-thumbnail';
import { thumbnailSize } from './image-header';

const PNG_3x2 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGM8wcXFwMDAwMDAxAADABByAOAp6i43AAAAAElFTkSuQmCC';
const GIF = 'R0lGODdhAwACAIEAAMgKCgAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7';
const bytes = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

function hugePng(): Uint8Array {
  const b = bytes(PNG_3x2).slice();
  new DataView(b.buffer).setUint32(16, 20000);
  new DataView(b.buffer).setUint32(20, 20000);
  return b;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetThumbnailWorkerForTests();
});

describe('thumbnailSize', () => {
  it('fits the longest side to 256 and keeps the aspect', () => {
    expect(thumbnailSize(1024, 512)).toEqual({ width: 256, height: 128 });
    expect(thumbnailSize(300, 1200)).toEqual({ width: 64, height: 256 });
  });
  it('never upscales', () => {
    expect(thumbnailSize(40, 30)).toEqual({ width: 40, height: 30 });
  });
});

describe('makeThumbnail', () => {
  it('never decodes refused bytes (GIF, SVG, image bomb) and zero-fills them', async () => {
    const decode = vi.fn(async () => FAKE_JPEG);
    for (const input of [bytes(GIF), new TextEncoder().encode('<svg/>'), hugePng()]) {
      expect(await makeThumbnail(input, { decode })).toBeNull();
      expect(input.every(b => b === 0)).toBe(true);
    }
    expect(decode).not.toHaveBeenCalled();
  });

  it('returns the re-encoded JPEG and zero-fills the original', async () => {
    const input = bytes(PNG_3x2);
    const decode = vi.fn(async (_b: Uint8Array, mime: string) => { expect(mime).toBe('image/png'); return FAKE_JPEG.slice(); });
    expect(Array.from(await makeThumbnail(input, { decode }) ?? [])).toEqual(Array.from(FAKE_JPEG));
    expect(input.every(b => b === 0)).toBe(true);
  });

  it('refuses a decoder result that is not a JPEG', async () => {
    expect(await makeThumbnail(bytes(PNG_3x2), { decode: async () => bytes(PNG_3x2) })).toBeNull();
  });

  it('runs in a worker when Worker and OffscreenCanvas exist, transferring a copy', async () => {
    const posted: { msg: { id: number; buffer: ArrayBuffer; type: string }; transfer: Transferable[] }[] = [];
    class FakeWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      postMessage(msg: { id: number; buffer: ArrayBuffer; type: string }, transfer: Transferable[]) {
        posted.push({ msg, transfer });
        const jpeg = FAKE_JPEG.slice().buffer;
        queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok: true, jpeg } } as MessageEvent));
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('OffscreenCanvas', class {});
    const input = bytes(PNG_3x2);
    const out = await makeThumbnail(input);
    expect(Array.from(out ?? [])).toEqual(Array.from(FAKE_JPEG));
    expect(posted).toHaveLength(1);
    expect(posted[0].msg.type).toBe('image/png');
    expect(posted[0].transfer).toEqual([posted[0].msg.buffer]);
    expect(input.every(b => b === 0)).toBe(true);
  });

  it('falls back to the main thread when the worker script fails to load', async () => {
    class BrokenWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      postMessage() { queueMicrotask(() => this.onerror?.()); }
      terminate() {}
    }
    vi.stubGlobal('Worker', BrokenWorker);
    vi.stubGlobal('OffscreenCanvas', class {});
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3, height: 2, close })));
    const toBlob = vi.fn((cb: BlobCallback) => cb(new Blob([FAKE_JPEG])));
    const getContext = vi.fn(() => ({ fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: '' }));
    const realCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'canvas') Object.assign(el, { getContext, toBlob });
      return el;
    });
    try {
      const out = await makeThumbnail(bytes(PNG_3x2));
      expect(Array.from(out ?? [])).toEqual(Array.from(FAKE_JPEG));
      expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.8);
      expect(close).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('without OffscreenCanvas uses the main thread, and fails quietly where nothing can decode', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('should not be built'); } });
    // jsdom: no createImageBitmap, no canvas 2D context.
    expect(await makeThumbnail(bytes(PNG_3x2))).toBeNull();
  });
});
