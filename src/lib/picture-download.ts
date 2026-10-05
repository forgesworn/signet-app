/**
 * Download one contact profile picture (a kind-0 `picture` URL), under the
 * contact-pictures safety rules. Only ever called after the user has agreed to
 * the download consent step — see `contact-pictures.ts`.
 *
 * - https only, and never a private, loopback, link-local or metadata host
 *   (`safe-url.ts`).
 * - No cookies or credentials, no redirects (a redirect could hop to an
 *   internal host the guard never saw), 10 s timeout.
 * - Body capped at 2 MB, measured on the bytes actually received.
 *
 * Web: `fetch` with a streamed read that aborts as soon as the cap is passed.
 * A host that sends no CORS header simply fails ("couldn't be downloaded").
 *
 * APK: `CapacitorHttp`, so CORS does not apply. Native code reads the whole
 * response before handing it back, so there the cap is enforced on the
 * received length rather than by aborting mid-stream (the read is still
 * bounded by the timeout). A redirect comes back as a 3xx status and fails.
 *
 * The Content-Type header is ignored: the format is decided later from the
 * bytes themselves (`image-header.ts`).
 */

import { CapacitorHttp } from '@capacitor/core';
import { isNativeApp } from './native';
import { isPrivateOrInternalHost } from './safe-url';

export const PICTURE_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
export const PICTURE_DOWNLOAD_TIMEOUT_MS = 10_000;
/** Longer than any real picture URL; refuses junk before parsing it. */
export const PICTURE_URL_MAX_CHARS = 2048;

/** The URL to fetch, or null when it is not one we will ever request. */
export function safePictureUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > PICTURE_URL_MAX_CHARS) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (isPrivateOrInternalHost(url.hostname)) return null;
  return url;
}

export interface PictureDownloadOptions {
  fetcher?: typeof fetch;
  /** Force the native or web leg (tests); defaults to `isNativeApp()`. */
  native?: boolean;
  nativeGet?: typeof CapacitorHttp.get;
  maxBytes?: number;
  timeoutMs?: number;
}

/** The picture's raw bytes, or null on ANY failure. Never throws. */
export async function downloadPictureBytes(rawUrl: string, opts: PictureDownloadOptions = {}): Promise<Uint8Array | null> {
  const url = safePictureUrl(rawUrl);
  if (!url) return null;
  const maxBytes = opts.maxBytes ?? PICTURE_MAX_DOWNLOAD_BYTES;
  const timeoutMs = opts.timeoutMs ?? PICTURE_DOWNLOAD_TIMEOUT_MS;
  const native = opts.native ?? isNativeApp();
  try {
    return native
      ? await downloadNative(url.href, maxBytes, timeoutMs, opts.nativeGet ?? CapacitorHttp.get.bind(CapacitorHttp))
      : await downloadWeb(url.href, maxBytes, timeoutMs, opts.fetcher ?? fetch.bind(globalThis));
  } catch {
    return null;
  }
}

async function downloadWeb(href: string, maxBytes: number, timeoutMs: number, fetcher: typeof fetch): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(href, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok || res.redirected || res.type === 'opaqueredirect') return null;
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) { controller.abort(); return null; }
    if (!res.body) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > maxBytes) { buf.fill(0); return null; }
      return buf;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        controller.abort();
        try { await reader.cancel(); } catch { /* already aborted */ }
        for (const c of chunks) c.fill(0);
        value.fill(0);
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; c.fill(0); }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadNative(
  href: string, maxBytes: number, timeoutMs: number, get: typeof CapacitorHttp.get,
): Promise<Uint8Array | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs + 1000); });
  try {
    const res = await Promise.race([
      get({
        url: href,
        responseType: 'arraybuffer',
        disableRedirects: true,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
        headers: { 'Cache-Control': 'no-cache' },
      }),
      timeout,
    ]);
    if (!res || res.status < 200 || res.status >= 300) return null;
    // Android hands back base64 for 'arraybuffer'; accept a real buffer too, under the same cap.
    if (res.data instanceof ArrayBuffer) {
      return res.data.byteLength > maxBytes ? null : new Uint8Array(res.data);
    }
    if (typeof res.data !== 'string') return null;
    // Base64 inflates by 4/3: refuse before decoding anything clearly too big.
    const b64 = res.data.replace(/\s+/g, '');
    if (Math.floor((b64.length * 3) / 4) > maxBytes + 3) return null;
    let binary: string;
    try { binary = atob(b64); } catch { return null; }
    if (binary.length > maxBytes) return null;
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } finally {
    clearTimeout(timer);
  }
}
