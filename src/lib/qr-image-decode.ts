// Reads a QR code from a still image (a photo the user picks) with the same
// off-thread decoder as the live camera.
import { createQrDecoderClient, type QrDecoderClient } from './qr-decoder-client';
import { pickNearestCentre, qrDecodeSize } from './qr-scan-geometry';

/** Longest side a picked photo is scaled to before decoding. */
export const QR_PHOTO_MAX_SIDE = 2048;

interface Deps {
  loadBitmap?: (image: Blob) => Promise<ImageBitmap>;
  createClient?: () => QrDecoderClient;
}

async function loadBitmap(image: Blob): Promise<ImageBitmap> {
  // Honour the photo's EXIF rotation where the engine supports the option.
  try { return await createImageBitmap(image, { imageOrientation: 'from-image' }); }
  catch { return createImageBitmap(image); }
}

/** The text of the code nearest the middle of the image, or null if none is found. */
export async function decodeQrFromImage(image: Blob, deps: Deps = {}): Promise<string | null> {
  const bitmap = await (deps.loadBitmap ?? loadBitmap)(image);
  const client = (deps.createClient ?? createQrDecoderClient)();
  try {
    const { width, height } = qrDecodeSize(bitmap.width, bitmap.height, QR_PHOTO_MAX_SIDE);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const out = await client.decode({ width, height, buffer: ctx.getImageData(0, 0, width, height).data.buffer });
    return pickNearestCentre(out.results.filter(h => h.text), width, height)?.text ?? null;
  } finally {
    bitmap.close();
    client.destroy();
  }
}
