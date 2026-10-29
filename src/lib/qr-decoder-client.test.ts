// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQrDecoderClient } from './qr-decoder-client';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('createQrDecoderClient', () => {
  it('decodes on the main thread with jsQR when Workers are unavailable', async () => {
    vi.stubGlobal('Worker', undefined);
    const client = createQrDecoderClient();
    const out = await client.decode({ width: 4, height: 4, buffer: new ArrayBuffer(64) });
    expect(out).toEqual({ results: [], decoder: 'jsqr' });
    client.destroy();
  });

  it('round-trips a frame through the worker, transferring the buffer', async () => {
    const posted: unknown[] = [];
    class FakeWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      postMessage(msg: { id: number }, transfer: unknown[]) {
        posted.push([msg, transfer]);
        queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, results: [{ text: 'x', cx: 1, cy: 2 }], decoder: 'zxing' } } as MessageEvent));
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker);
    const client = createQrDecoderClient();
    const buffer = new ArrayBuffer(16);
    const out = await client.decode({ width: 2, height: 2, buffer });
    expect(out).toEqual({ results: [{ text: 'x', cx: 1, cy: 2 }], decoder: 'zxing' });
    expect((posted[0] as [unknown, unknown[]])[1]).toEqual([buffer]);
    client.destroy();
  });

  it('answers pending frames empty and falls back to jsQR when the worker errors', async () => {
    let instance!: { onerror: (() => void) | null };
    class FakeWorker {
      onmessage = null;
      onerror: (() => void) | null = null;
      onmessageerror = null;
      constructor() { instance = this; }
      postMessage() {}
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeWorker);
    const client = createQrDecoderClient();
    const pending = client.decode({ width: 2, height: 2, buffer: new ArrayBuffer(16) });
    instance.onerror?.();
    expect(await pending).toEqual({ results: [], decoder: 'jsqr' });
    expect(await client.decode({ width: 2, height: 2, buffer: new ArrayBuffer(16) })).toEqual({ results: [], decoder: 'jsqr' });
    client.destroy();
  });
});
