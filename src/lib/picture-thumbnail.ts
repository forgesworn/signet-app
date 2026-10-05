/**
 * Turn untrusted picture bytes (a download, or a file the user picked) into a
 * small re-encoded JPEG thumbnail — the ONLY form a contact picture is ever
 * stored or rendered in.
 *
 * 1. `checkImageHeader` first: JPEG/PNG/WebP by magic bytes only, and the
 *    header's dimensions within 8192 px a side / 40 MP, so nothing oversized
 *    or unexpected ever reaches a decoder.
 * 2. Decode + resize to at most 256 px + re-encode as JPEG ~0.8 in a Web
 *    Worker (createImageBitmap + OffscreenCanvas). Where the worker or
 *    OffscreenCanvas is unavailable, the same steps run on the main thread
 *    with a DOM canvas.
 * 3. The original bytes are zero-filled once the decoder has them; the
 *    result is checked to really be a JPEG.
 */

import {
  checkImageHeader, thumbnailSize, THUMBNAIL_JPEG_QUALITY, THUMBNAIL_MAX_SIDE_PX, sniffImageFormat,
  type ImageFormat,
} from './image-header';
import { CONTACT_PICTURE_MAX_STORED_BYTES } from './contact-picture-crypto';

const MIME: Record<ImageFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const WORKER_TIMEOUT_MS = 15_000;

type Decoder = (bytes: Uint8Array, mime: string) => Promise<Uint8Array | null>;

let worker: Worker | null = null;
let workerBroken = false;
let nextJob = 1;
const pending = new Map<number, (jpeg: Uint8Array | null) => void>();

function workerAvailable(): boolean {
  return !workerBroken && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

function failAll(): void {
  for (const resolve of pending.values()) resolve(null);
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  // Constructed lazily: never at import time (Vitest/jsdom has no Worker).
  const w = new Worker(new URL('./picture-thumbnail.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; jpeg?: ArrayBuffer }>) => {
    const resolve = pending.get(e.data?.id);
    if (!resolve) return;
    pending.delete(e.data.id);
    resolve(e.data.ok && e.data.jpeg instanceof ArrayBuffer ? new Uint8Array(e.data.jpeg) : null);
  };
  w.onerror = () => {
    // The worker script itself failed (e.g. not loadable here): use the
    // main-thread path from now on.
    workerBroken = true;
    w.terminate();
    worker = null;
    failAll();
  };
  worker = w;
  return w;
}

/** Off-main-thread decode. Resolves null on failure; `'unavailable'` when the worker never ran. */
async function decodeInWorker(bytes: Uint8Array, mime: string): Promise<Uint8Array | null | 'unavailable'> {
  let w: Worker;
  try { w = getWorker(); } catch { workerBroken = true; return 'unavailable'; }
  // Hand the worker its own copy (transferred, so it is not duplicated
  // again); the caller zero-fills the original.
  const copy = bytes.slice().buffer;
  const id = nextJob++;
  const brokenBefore = workerBroken;
  const result = await new Promise<Uint8Array | null>((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, WORKER_TIMEOUT_MS);
    pending.set(id, (jpeg) => { clearTimeout(timer); resolve(jpeg); });
    try {
      w.postMessage({ id, buffer: copy, type: mime }, [copy]);
    } catch {
      pending.delete(id);
      clearTimeout(timer);
      resolve(null);
    }
  });
  if (result === null && !brokenBefore && workerBroken) return 'unavailable';
  return result;
}

/** Main-thread fallback: same steps with a DOM canvas. */
export const decodeOnMainThread: Decoder = async (bytes, mime) => {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const size = thumbnailSize(bitmap.width, bitmap.height, THUMBNAIL_MAX_SIDE_PX);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', THUMBNAIL_JPEG_QUALITY));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } finally {
    bitmap.close?.();
  }
};

export interface ThumbnailOptions {
  /** Replace the worker/main-thread decoders (tests). */
  decode?: Decoder;
}

/**
 * The re-encoded thumbnail, or null when the bytes are refused or cannot be
 * decoded. Always zero-fills `bytes` before returning. Never throws.
 */
export async function makeThumbnail(bytes: Uint8Array, opts: ThumbnailOptions = {}): Promise<Uint8Array | null> {
  try {
    const header = checkImageHeader(bytes);
    if (!header.ok) return null;
    const mime = MIME[header.format];
    let jpeg: Uint8Array | null;
    if (opts.decode) {
      jpeg = await opts.decode(bytes, mime);
    } else if (workerAvailable()) {
      const r = await decodeInWorker(bytes, mime);
      jpeg = r === 'unavailable' ? await decodeOnMainThread(bytes, mime) : r;
    } else {
      jpeg = await decodeOnMainThread(bytes, mime);
    }
    if (!jpeg || jpeg.length === 0 || jpeg.length > CONTACT_PICTURE_MAX_STORED_BYTES || sniffImageFormat(jpeg) !== 'jpeg') return null;
    return jpeg;
  } catch {
    return null;
  } finally {
    bytes.fill(0);
  }
}

/** Test hook: forget the worker so a test can stub `Worker` afresh. */
export function resetThumbnailWorkerForTests(): void {
  if (worker) worker.terminate();
  worker = null;
  workerBroken = false;
  failAll();
}
