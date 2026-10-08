/**
 * Decode + downscale + re-encode one contact picture off the main thread.
 * The caller has already passed the bytes through `checkImageHeader`
 * (format and dimensions), so this only ever decodes a small JPEG/PNG/WebP.
 * The thumbnail size comes from the decoded bitmap (EXIF orientation applied).
 * Replies with a fresh JPEG at most 256 px a side; the original bytes are
 * zero-filled here as soon as the decoder has them.
 *
 * With a `crop` (fractions of the oriented image) the bitmap is decoded with
 * `imageOrientation: 'from-image'` and that square is drawn onto a 256 x 256
 * canvas instead.
 */
import { thumbnailSize, THUMBNAIL_JPEG_QUALITY, THUMBNAIL_MAX_SIDE_PX } from './image-header';
import { CROP_OUTPUT_PX, cropSourceRect, isValidPictureCrop, type PictureCrop } from './picture-crop';

/** `resizeWidth`: decode straight to this width (aspect kept by the engine), so the full-size bitmap is never kept. */
interface Job { id: number; buffer: ArrayBuffer; type: string; resizeWidth?: number; crop?: PictureCrop }

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Job>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (e: MessageEvent<Job>) => {
  const { id, buffer, type, resizeWidth, crop } = e.data;
  void (async () => {
    const bytes = new Uint8Array(buffer);
    try {
      const blob = new Blob([bytes], { type });
      if (crop !== undefined && !isValidPictureCrop(crop)) throw new Error('bad crop');
      const resize: ImageBitmapOptions = typeof resizeWidth === 'number' && resizeWidth > 0
        ? { resizeWidth, resizeQuality: 'high' } : {};
      const bitmap = crop
        ? await createImageBitmap(blob, { imageOrientation: 'from-image', ...resize })
        : typeof resizeWidth === 'number' && resizeWidth > 0
          ? await createImageBitmap(blob, resize)
          : await createImageBitmap(blob);
      bytes.fill(0);
      try {
        const size = crop ? { width: CROP_OUTPUT_PX, height: CROP_OUTPUT_PX } : thumbnailSize(bitmap.width, bitmap.height, THUMBNAIL_MAX_SIDE_PX);
        const canvas = new OffscreenCanvas(size.width, size.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size.width, size.height);
        if (crop) {
          const { sx, sy, s } = cropSourceRect(bitmap.width, bitmap.height, crop);
          ctx.drawImage(bitmap, sx, sy, s, s, 0, 0, size.width, size.height);
        } else {
          ctx.drawImage(bitmap, 0, 0, size.width, size.height);
        }
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
