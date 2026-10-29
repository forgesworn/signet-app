// @vitest-environment node
// Real-decoder check: the bundled zxing wasm reads a QR rendered from the
// `qrcode` library, including an inverted one, and reports where it is.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';
import { beforeAll, describe, expect, it } from 'vitest';
import type { QrFrame, ZxingRead } from './qr-decode-core';

const require = createRequire(import.meta.url);

function render(text: string, scale: number, invert: boolean): QrFrame {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 4;
  const side = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const dark = mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.get(my, mx) === 1;
      const v = dark !== invert ? 0 : 255;
      const i = (y * side + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: side, height: side, data };
}

describe('zxing reader (real wasm)', () => {
  let read: ZxingRead;
  beforeAll(async () => {
    (globalThis as { self?: unknown }).self = { location: { href: 'file:///' } };
    const { loadZxingReader } = await import('./qr-zxing-reader');
    // Node has no fetch for file URLs, so hand the module the bytes directly.
    const wasmBinary = readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
    read = await loadZxingReader(undefined, { wasmBinary });
  }, 30_000);

  const url = 'https://mysignet.app/?auth=1&challenge=' + 'ab'.repeat(32) + '&origin=https%3A%2F%2Fexample.com&name=Example&callback=https%3A%2F%2Fexample.com%2Fcb&t=1700000000';

  it('decodes a long sign-in URL and reports its centre', async () => {
    const frame = render(url, 4, false);
    const hits = await read(frame);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe(url);
    expect(Math.abs(hits[0].cx - frame.width / 2)).toBeLessThan(frame.width * 0.1);
    expect(Math.abs(hits[0].cy - frame.height / 2)).toBeLessThan(frame.height * 0.1);
  }, 30_000);

  it('reads a 1024px frame in well under a second', async () => {
    const frame = render(url, 14, false);
    const t = performance.now();
    const hits = await read(frame);
    expect(hits[0]?.text).toBe(url);
    expect(performance.now() - t).toBeLessThan(1000);
  }, 30_000);

  it('decodes an inverted code', async () => {
    const hits = await read(render('hello inverted', 6, true));
    expect(hits.map(h => h.text)).toEqual(['hello inverted']);
  }, 30_000);
});
