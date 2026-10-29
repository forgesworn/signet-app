/// <reference lib="webworker" />
// Dedicated worker: decodes cropped camera frames off the main thread.
// In:  { id, width, height, buffer }  (RGBA, buffer transferred)
// Out: { id, results, decoder }
import { QrDecoder } from './qr-decode-core';
import { loadZxingReader } from './qr-zxing-reader';

const decoder = new QrDecoder({ loadZxing: () => loadZxingReader() });
// Compile the wasm while the camera is still starting.
void decoder.warm();

self.onmessage = async (event: MessageEvent<{ id: number; width: number; height: number; buffer: ArrayBuffer }>) => {
  const { id, width, height, buffer } = event.data;
  try {
    const out = await decoder.decode({ width, height, data: new Uint8ClampedArray(buffer) });
    self.postMessage({ id, results: out.results, decoder: out.decoder });
  } catch {
    self.postMessage({ id, results: [], decoder: decoder.kind });
  }
};
