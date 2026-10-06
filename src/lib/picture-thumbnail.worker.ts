/**
 * Decode + downscale + re-encode one contact picture off the main thread.
 * The caller has already passed the bytes through `checkImageHeader`
 * (format and dimensions), so this only ever decodes a small JPEG/PNG/WebP.
 * The thumbnail size comes from the decoded bitmap (EXIF orientation applied).
 * Replies with a fresh JPEG at most 256 px a side; the original bytes are
 * zero-filled here as soon as the decoder has them.
 */
import { thumbnailSize, THUMBNAIL_JPEG_QUALITY, THUMBNAIL_MAX_SIDE_PX } from './image-header';

/** `resizeWidth`: decode straight to this width (aspect kept by the engine), so the full-size bitmap is never kept. */
interface Job { id: number; buffer: ArrayBuffer; type: string; resizeWidth?: number }

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Job>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (e: MessageEvent<Job>) => {
  const { id, buffer, type, resizeWidth } = e.data;
  void (async () => {
    const bytes = new Uint8Array(buffer);
    try {
      const blob = new Blob([bytes], { type });
      const bitmap = typeof resizeWidth === 'number' && resizeWidth > 0
        ? await createImageBitmap(blob, { resizeWidth, resizeQuality: 'high' })
        : await createImageBitmap(blob);
      bytes.fill(0);
      try {
        const size = thumbnailSize(bitmap.width, bitmap.height, THUMBNAIL_MAX_SIDE_PX);
        const canvas = new OffscreenCanvas(size.width, size.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size.width, size.height);
        ctx.drawImage(bitmap, 0, 0, size.width, size.height);
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMBNAIL_JPEG_QUALITY });
        const jpeg = await blob.arrayBuffer();
        scope.postMessage({ id, ok: true, jpeg }, [jpeg]);
      } finally {
        bitmap.close();
      }
    } catch {
      bytes.fill(0);
      scope.postMessage({ id, ok: false });
    }
  })();
};
