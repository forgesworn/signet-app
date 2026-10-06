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
 *    with a DOM canvas. ONE decode at a time, whatever the caller's download
 *    concurrency: a 40 MP image is ~160 MB of RGBA, and a single-colour one
 *    is a ~40 KB PNG. Where the engine supports it, createImageBitmap is
 *    asked to resize while decoding (`decodeResizeWidth`), so the full-size
 *    bitmap is never kept. A job that hangs past the timeout terminates the
 *    worker; the next job gets a fresh one.
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

/** `resizeWidth`: the width to ask createImageBitmap for (see `decodeResizeWidth`); undefined = decode as is. */
type Decoder = (bytes: Uint8Array, mime: string, resizeWidth?: number) => Promise<Uint8Array | null>;

/**
 * The `resizeWidth` to decode at, from the header's dimensions, or undefined
 * when the image is already small enough.
 *
 * Only the width is given, so the engine keeps the aspect ratio of the image
 * AS ORIENTED — the header's width × height is before any EXIF rotation, and
 * passing both would squash a rotated camera photo. Using the shorter header
 * side (capped at 256) means neither orientation is ever upscaled, and the
 * decoded bitmap is at most 256 × 8192 px; the exact thumbnail size is then
 * taken from the bitmap itself.
 */
export function decodeResizeWidth(width: number, height: number, maxSide: number = THUMBNAIL_MAX_SIDE_PX): number | undefined {
  if (Math.max(width, height) <= maxSide) return undefined;
  return Math.max(1, Math.min(width, height, maxSide));
}

/** createImageBitmap options for a resize-on-decode (ignored by engines without resize support). */
export function decodeOptions(resizeWidth: number | undefined): ImageBitmapOptions | undefined {
  return resizeWidth ? { resizeWidth, resizeQuality: 'high' } : undefined;
}

// One decode at a time. The chain never rejects, so one failure cannot stall the queue.
let decodeChain: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = decodeChain.then(task, task);
  decodeChain = run.then(() => undefined, () => undefined);
  return run;
}

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
async function decodeInWorker(bytes: Uint8Array, mime: string, resizeWidth?: number): Promise<Uint8Array | null | 'unavailable'> {
  let w: Worker;
  try { w = getWorker(); } catch { workerBroken = true; return 'unavailable'; }
  // Hand the worker its own copy (transferred, so it is not duplicated
  // again); the caller zero-fills the original.
  const copy = bytes.slice().buffer;
  const id = nextJob++;
  const brokenBefore = workerBroken;
  const result = await new Promise<Uint8Array | null>((resolve) => {
    const timer = setTimeout(() => {
      // The job hung (a decoder stuck on a hostile image). Kill the worker so
      // it stops holding that memory; the next job builds a fresh one. Not
      // `workerBroken`: the script loaded fine.
      pending.delete(id);
      if (worker === w) worker = null;
      w.terminate();
      failAll();
      resolve(null);
    }, WORKER_TIMEOUT_MS);
    pending.set(id, (jpeg) => { clearTimeout(timer); resolve(jpeg); });
    try {
      w.postMessage({ id, buffer: copy, type: mime, ...(resizeWidth ? { resizeWidth } : {}) }, [copy]);
    } catch {
      pending.delete(id);
      clearTimeout(timer);
      resolve(null);
    }
  });
  if (result === null && !brokenBefore && workerBroken) return 'unavailable';
  return result;
}

/** Main-thread fallback: same steps with a DOM canvas, bounded by the worker's timeout. */
export const decodeOnMainThread: Decoder = (bytes, mime, resizeWidth) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((_, reject) => {
    timer = setTimeout(() => reject(new Error('decode timed out')), WORKER_TIMEOUT_MS);
  });
  return Promise.race([decodeOnMainThreadUnbounded(bytes, mime, resizeWidth), timeout])
    .finally(() => clearTimeout(timer));
};

const decodeOnMainThreadUnbounded: Decoder = async (bytes, mime, resizeWidth) => {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const options = decodeOptions(resizeWidth);
  const bitmap = options ? await createImageBitmap(blob, options) : await createImageBitmap(blob);
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
    const resizeWidth = decodeResizeWidth(header.width, header.height);
    const jpeg = await oneAtATime(async (): Promise<Uint8Array | null> => {
      if (opts.decode) return opts.decode(bytes, mime, resizeWidth);
      if (workerAvailable()) {
        const r = await decodeInWorker(bytes, mime, resizeWidth);
        return r === 'unavailable' ? decodeOnMainThread(bytes, mime, resizeWidth) : r;
      }
      return decodeOnMainThread(bytes, mime, resizeWidth);
    });
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
  decodeChain = Promise.resolve();
  failAll();
}
