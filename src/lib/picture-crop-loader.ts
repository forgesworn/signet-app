/**
 * Opens a picked photo for the crop screen. The browser decodes it for the
 * preview with `imageOrientation: 'from-image'` (the crop screen sets it on the
 * element, matching the worker's decode of the final crop), so `width` and
 * `height` are those of the image AS ORIENTED. Swappable in tests: jsdom has
 * no image decoder.
 */
export interface CropPicture {
  /** An object URL for the photo; valid until `release()`. */
  src: string;
  /** Oriented size in pixels. */
  width: number;
  height: number;
  release: () => void;
}

export type CropPictureLoader = (file: Blob) => Promise<CropPicture>;

export const loadCropPicture: CropPictureLoader = (file) => new Promise<CropPicture>((resolve, reject) => {
  const src = URL.createObjectURL(file);
  const release = () => URL.revokeObjectURL(src);
  const img = new Image();
  img.onload = () => {
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) { release(); reject(new Error('empty image')); return; }
    resolve({ src, width, height, release });
  };
  img.onerror = () => { release(); reject(new Error('unreadable image')); };
  img.src = src;
});
