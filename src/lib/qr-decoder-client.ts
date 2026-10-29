// Main-thread handle on the QR decode worker, with a jsQR-on-main-thread
// fallback if the worker cannot start or stops answering.
import { QrDecoder, type QrDecodeOutput } from './qr-decode-core';

export interface QrDecoderClient {
  /** Takes ownership of `buffer` (it is transferred to the worker). */
  decode(frame: { width: number; height: number; buffer: ArrayBuffer }): Promise<QrDecodeOutput>;
  destroy(): void;
}

/** A worker that stays silent this long is treated as dead. */
export const QR_WORKER_TIMEOUT_MS = 10_000;

interface Pending {
  resolve: (out: QrDecodeOutput) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createQrDecoderClient(): QrDecoderClient {
  // jsQR only: zxing's wasm is not loaded on the main thread.
  const mainThread = new QrDecoder();
  const pending = new Map<number, Pending>();
  let worker: Worker | null = null;
  let nextId = 1;

  const empty: QrDecodeOutput = { results: [], decoder: 'jsqr' };

  function dropWorker() {
    if (worker) { worker.terminate(); worker = null; }
    for (const p of pending.values()) { clearTimeout(p.timer); p.resolve(empty); }
    pending.clear();
  }

  if (typeof Worker !== 'undefined') {
    try {
      const w = new Worker(new URL('./qr-decode.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (event: MessageEvent<{ id: number } & QrDecodeOutput>) => {
        const entry = pending.get(event.data.id);
        if (!entry) return;
        pending.delete(event.data.id);
        clearTimeout(entry.timer);
        entry.resolve({ results: event.data.results, decoder: event.data.decoder });
      };
      w.onerror = dropWorker;
      w.onmessageerror = dropWorker;
      worker = w;
    } catch {
      worker = null;
    }
  }

  return {
    decode({ width, height, buffer }) {
      if (!worker) {
        return mainThread.decode({ width, height, data: new Uint8ClampedArray(buffer) });
      }
      const id = nextId++;
      return new Promise<QrDecodeOutput>((resolve) => {
        const timer = setTimeout(dropWorker, QR_WORKER_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        try {
          worker!.postMessage({ id, width, height, buffer }, [buffer]);
        } catch {
          dropWorker();
        }
      });
    },
    destroy() {
      dropWorker();
    },
  };
}
