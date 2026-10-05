import { describe, expect, it, vi } from 'vitest';
import { downloadPictureBytes, safePictureUrl, PICTURE_MAX_DOWNLOAD_BYTES } from './picture-download';

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

function okResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  return new Response(streamOf(chunks), { status: 200, headers });
}

describe('safePictureUrl', () => {
  it('accepts a public https URL', () => {
    expect(safePictureUrl('https://example.com/a.jpg')?.href).toBe('https://example.com/a.jpg');
  });

  it.each([
    'http://example.com/a.jpg',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'https://localhost/a.jpg',
    'https://127.0.0.1/a.jpg',
    'https://10.0.0.5/a.jpg',
    'https://192.168.1.1/a.jpg',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/a.jpg',
    'https://2130706433/a.jpg',
    'https://user:pass@example.com/a.jpg',
    'not a url',
    '',
  ])('refuses %s', (raw) => {
    expect(safePictureUrl(raw)).toBeNull();
  });

  it('refuses an over-long URL and non-strings', () => {
    expect(safePictureUrl(`https://example.com/${'a'.repeat(3000)}`)).toBeNull();
    expect(safePictureUrl(42)).toBeNull();
  });
});

describe('downloadPictureBytes (web)', () => {
  it('never fetches a refused URL', async () => {
    const fetcher = vi.fn();
    expect(await downloadPictureBytes('http://example.com/a.jpg', { native: false, fetcher })).toBeNull();
    expect(await downloadPictureBytes('https://192.168.0.1/a.jpg', { native: false, fetcher })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fetches without credentials, refusing redirects', async () => {
    const fetcher = vi.fn(async () => okResponse([new Uint8Array([1, 2, 3])]));
    const out = await downloadPictureBytes('https://example.com/a.jpg', { native: false, fetcher: fetcher as unknown as typeof fetch });
    expect(Array.from(out ?? [])).toEqual([1, 2, 3]);
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
  });

  it('treats a redirect (fetch rejects under redirect:error) as a failure', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await downloadPictureBytes('https://example.com/a.jpg', { native: false, fetcher: fetcher as unknown as typeof fetch })).toBeNull();
  });

  it('treats a CORS failure or non-2xx status as a failure', async () => {
    const notFound = vi.fn(async () => new Response('nope', { status: 404 }));
    expect(await downloadPictureBytes('https://example.com/a.jpg', { native: false, fetcher: notFound as unknown as typeof fetch })).toBeNull();
  });

  it('refuses a declared Content-Length over 2 MB without reading', async () => {
    const fetcher = vi.fn(async () => okResponse([new Uint8Array(10)], { 'content-length': String(PICTURE_MAX_DOWNLOAD_BYTES + 1) }));
    expect(await downloadPictureBytes('https://example.com/a.jpg', { native: false, fetcher: fetcher as unknown as typeof fetch })).toBeNull();
  });

  it('aborts a body that passes 2 MB, measured on the real bytes (lying Content-Length)', async () => {
    const chunk = new Uint8Array(512 * 1024).fill(7);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; controller.enqueue(chunk.slice()); },
    });
    const fetcher = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-length': '100' } }));
    expect(await downloadPictureBytes('https://example.com/a.jpg', { native: false, fetcher: fetcher as unknown as typeof fetch })).toBeNull();
    // 2 MB is four chunks; the fifth crosses the cap and the read stops there.
    expect(pulled).toBeLessThanOrEqual(6);
  });

  it('accepts a body of exactly 2 MB', async () => {
    const fetcher = vi.fn(async () => okResponse([new Uint8Array(PICTURE_MAX_DOWNLOAD_BYTES)]));
    const out = await downloadPictureBytes('https://example.com/a.jpg', { native: false, fetcher: fetcher as unknown as typeof fetch });
    expect(out?.length).toBe(PICTURE_MAX_DOWNLOAD_BYTES);
  });

  it('gives up after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
      const p = downloadPictureBytes('https://example.com/a.jpg', { native: false, fetcher: fetcher as unknown as typeof fetch, timeoutMs: 10_000 });
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('downloadPictureBytes (APK, CapacitorHttp)', () => {
  const b64 = (n: number) => btoa(String.fromCharCode(...new Uint8Array(n).fill(65)));

  it('asks for raw bytes with redirects disabled', async () => {
    const nativeGet = vi.fn(async () => ({ status: 200, data: btoa('\x01\x02'), headers: {}, url: '' }));
    const out = await downloadPictureBytes('https://example.com/a.jpg', { native: true, nativeGet: nativeGet as never });
    expect(Array.from(out ?? [])).toEqual([1, 2]);
    const opts = (nativeGet.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(opts.disableRedirects).toBe(true);
    expect(opts.responseType).toBe('arraybuffer');
  });

  it('treats a 3xx (redirect) as a failure', async () => {
    const nativeGet = vi.fn(async () => ({ status: 302, data: '', headers: { Location: 'https://127.0.0.1/' }, url: '' }));
    expect(await downloadPictureBytes('https://example.com/a.jpg', { native: true, nativeGet: nativeGet as never })).toBeNull();
  });

  it('refuses a received body over the cap', async () => {
    const nativeGet = vi.fn(async () => ({ status: 200, data: b64(101), headers: {}, url: '' }));
    expect(await downloadPictureBytes('https://example.com/a.jpg', { native: true, nativeGet: nativeGet as never, maxBytes: 100 })).toBeNull();
    const ok = vi.fn(async () => ({ status: 200, data: b64(100), headers: {}, url: '' }));
    expect((await downloadPictureBytes('https://example.com/a.jpg', { native: true, nativeGet: ok as never, maxBytes: 100 }))?.length).toBe(100);
  });

  it('never calls native for a refused URL', async () => {
    const nativeGet = vi.fn();
    expect(await downloadPictureBytes('https://localhost/a.jpg', { native: true, nativeGet: nativeGet as never })).toBeNull();
    expect(nativeGet).not.toHaveBeenCalled();
  });
});
