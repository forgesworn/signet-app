// zxing-wasm reader, bundled locally. Only imported by the decode worker, so
// the ~1 MiB wasm and its glue never enter the main bundle.
import { prepareZXingModule, readBarcodes, type ZXingModuleOverrides } from 'zxing-wasm/reader';
// Vite emits the wasm as a hashed asset on our own origin and gives its URL.
// zxing-wasm's default loader points at jsDelivr; locateFile below replaces it.
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import { qrHitBox, type QrHit, type ZxingRead } from './qr-decode-core';

const MAX_SYMBOLS = 4;

export async function loadZxingReader(
  url: string = wasmUrl,
  extraOverrides: ZXingModuleOverrides = {},
): Promise<ZxingRead> {
  const resolved = new URL(url, self.location.href).href;
  // fireImmediately compiles the module now and rejects if the wasm cannot be
  // fetched or compiled, which is what lets the caller fall back to jsQR.
  await prepareZXingModule({
    overrides: {
      ...extraOverrides,
      locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? resolved : prefix + path),
    },
    fireImmediately: true,
  });
  return async (frame) => {
    const image = typeof ImageData === 'undefined'
      ? ({ data: frame.data, width: frame.width, height: frame.height } as unknown as ImageData)
      : new ImageData(frame.data as Uint8ClampedArray<ArrayBuffer>, frame.width, frame.height);
    const found = await readBarcodes(image, {
      formats: ['QRCode'],
      maxNumberOfSymbols: MAX_SYMBOLS,
      tryInvert: true,
      tryHarder: true,
      tryRotate: false, // QR finder patterns make QR rotation-invariant already
      tryDownscale: true,
    });
    const hits: QrHit[] = [];
    for (const r of found) {
      // An empty code is kept: the Handshake counts every code in view.
      if (!r.isValid) continue;
      const p = r.position;
      hits.push({ text: r.text, ...qrHitBox([p.topLeft, p.topRight, p.bottomRight, p.bottomLeft]) });
    }
    return hits;
  };
}
