// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeResizeWidth, makeThumbnail, resetThumbnailWorkerForTests } from './picture-thumbnail';
import { thumbnailSize } from './image-header';

const PNG_3x2 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGM8wcXFwMDAwMDAxAADABByAOAp6i43AAAAAElFTkSuQmCC';
const GIF = 'R0lGODdhAwACAIEAAMgKCgAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7';
const bytes = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

function pngOf(width: number, height: number): Uint8Array {
  const b = bytes(PNG_3x2).slice();
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function hugePng(): Uint8Array {
  const b = bytes(PNG_3x2).slice();
  new DataView(b.buffer).setUint32(16, 20000);
  new DataView(b.buffer).setUint32(20, 20000);
  return b;
}

afterEach(() => {
  vi.useRealTimers();
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

describe('decodeResizeWidth', () => {
  it('does not resize an image already within 256 px', () => {
    expect(decodeResizeWidth(256, 100)).toBeUndefined();
    expect(decodeResizeWidth(3, 2)).toBeUndefined();
  });

  it('asks for the shorter side capped at 256, so neither EXIF orientation is squashed or upscaled', () => {
    expect(decodeResizeWidth(4000, 3000)).toBe(256);
    expect(decodeResizeWidth(3000, 4000)).toBe(256);
    expect(decodeResizeWidth(8192, 100)).toBe(100);
    expect(decodeResizeWidth(100, 8192)).toBe(100);
  });
});

describe('makeThumbnail: bounded decode', () => {
  it('passes the resize-on-decode width to the decoder', async () => {
    const decode = vi.fn(async () => FAKE_JPEG.slice());
    await makeThumbnail(pngOf(4000, 3000), { decode });
    expect(decode).toHaveBeenCalledWith(expect.any(Uint8Array), 'image/png', 256);
    await makeThumbnail(bytes(PNG_3x2), { decode });
    expect(decode).toHaveBeenLastCalledWith(expect.any(Uint8Array), 'image/png', undefined);
  });

  it('decodes one image at a time, and a failed decode does not stall the queue', async () => {
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const decode = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active -= 1;
      if (decode.mock.calls.length === 1) throw new Error('decoder blew up');
      return FAKE_JPEG.slice();
    });
    const runs = [0, 1, 2].map(() => makeThumbnail(bytes(PNG_3x2), { decode }));
    for (let i = 0; i < 3; i += 1) {
      await vi.waitFor(() => expect(releases.length).toBe(i + 1));
      // Nothing else has started while this one is still decoding.
      expect(decode).toHaveBeenCalledTimes(i + 1);
      releases[i]();
    }
    const out = await Promise.all(runs);
    expect(peak).toBe(1);
    expect(out[0]).toBeNull();
    expect(out[1]).not.toBeNull();
    expect(out[2]).not.toBeNull();
  });

  it('sends the resize width to the worker', async () => {
    const posted: { resizeWidth?: number }[] = [];
    class FakeWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      postMessage(msg: { id: number; resizeWidth?: number }) {
        posted.push(msg);
        const jpeg = FAKE_JPEG.slice().buffer;
        queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok: true, jpeg } } as MessageEvent));
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('OffscreenCanvas', class {});
    await makeThumbnail(pngOf(3000, 4000));
    expect(posted[0].resizeWidth).toBe(256);
  });

  it('terminates a worker whose job hangs past the timeout, and builds a fresh one for the next job', async () => {
    vi.useFakeTimers();
    const built: HangingWorker[] = [];
    class HangingWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      terminated = false;
      constructor() { built.push(this); }
      postMessage(msg: { id: number }) {
        // The first worker never answers; any later one does.
        if (built.length === 1) return;
        const jpeg = FAKE_JPEG.slice().buffer;
        queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok: true, jpeg } } as MessageEvent));
      }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', HangingWorker);
    vi.stubGlobal('OffscreenCanvas', class {});

    const first = makeThumbnail(bytes(PNG_3x2));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await first).toBeNull();
    expect(built).toHaveLength(1);
    expect(built[0].terminated).toBe(true);

    const second = await makeThumbnail(bytes(PNG_3x2));
    expect(built).toHaveLength(2);
    expect(built[1].terminated).toBe(false);
    expect(Array.from(second ?? [])).toEqual(Array.from(FAKE_JPEG));
  });
});
