import { describe, expect, it } from 'vitest';
import { checkImageHeader, readImageHeader, sniffImageFormat, MAX_IMAGE_SIDE_PX } from './image-header';

// Real files, generated with Pillow: JPEG/PNG 3×2, WebP lossy/lossless 3×2, WebP with alpha (VP8X) 5×4.
const B64 = {
  jpeg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDgqKKK8M/VD//Z',
  progressiveJpeg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAACAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVAQEBAAAAAAAAAAAAAAAAAAAEBv/aAAwDAQACEAMQAAABgANV/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABDz/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=',
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGM8wcXFwMDAwMDAxAADABByAOAp6i43AAAAAElFTkSuQmCC',
  webpLossy: 'UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoDAAIAAsBMJaACdLoAA5gA/u+ax9CjZRKpf/SbP+Js/4mz45gAAA==',
  webpLossless: 'UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAAAdQhSJXof+BiOh/AAA=',
  webpExtended: 'UklGRlwAAABXRUJQVlA4WAoAAAAQAAAABAAAAwAAQUxQSAoAAAABB1DAiAhERP8DVlA4ICwAAACQAQCdASoFAAQAAsBMJaACdLoAA5gA/u+ax9CjZRKpf/SbP+Js/4mz45gAAA==',
  gif: 'R0lGODdhAwACAIEAAMgKCgAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7',
};
const bytes = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const text = (s: string) => new TextEncoder().encode(s);

function pngWithSize(w: number, h: number): Uint8Array {
  const b = bytes(B64.png).slice();
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

describe('sniffImageFormat', () => {
  it('reads the magic bytes of each accepted format', () => {
    expect(sniffImageFormat(bytes(B64.jpeg))).toBe('jpeg');
    expect(sniffImageFormat(bytes(B64.png))).toBe('png');
    expect(sniffImageFormat(bytes(B64.webpLossy))).toBe('webp');
  });

  it('refuses GIF, SVG and anything else', () => {
    expect(sniffImageFormat(bytes(B64.gif))).toBeNull();
    expect(sniffImageFormat(text('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'))).toBeNull();
    expect(sniffImageFormat(text('<?xml version="1.0"?><svg/>'))).toBeNull();
    expect(sniffImageFormat(text('<html></html>'))).toBeNull();
    expect(sniffImageFormat(new Uint8Array())).toBeNull();
  });
});

describe('readImageHeader', () => {
  it.each([
    ['baseline JPEG', B64.jpeg, 'jpeg', 3, 2],
    ['progressive JPEG', B64.progressiveJpeg, 'jpeg', 3, 2],
    ['PNG', B64.png, 'png', 3, 2],
    ['WebP lossy (VP8)', B64.webpLossy, 'webp', 3, 2],
    ['WebP lossless (VP8L)', B64.webpLossless, 'webp', 3, 2],
    ['WebP extended (VP8X)', B64.webpExtended, 'webp', 5, 4],
  ])('%s', (_label, b64, format, width, height) => {
    expect(readImageHeader(bytes(b64))).toEqual({ format, width, height });
  });

  it('returns null for a truncated header of every format', () => {
    expect(readImageHeader(bytes(B64.jpeg).slice(0, 100))).toBeNull();
    expect(readImageHeader(bytes(B64.png).slice(0, 20))).toBeNull();
    expect(readImageHeader(bytes(B64.webpLossy).slice(0, 25))).toBeNull();
    expect(readImageHeader(bytes(B64.webpExtended).slice(0, 26))).toBeNull();
  });

  it('returns null for a JPEG that reaches its scan before a frame header', () => {
    expect(readImageHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });

  it('returns null for a JPEG with a broken marker chain', () => {
    expect(readImageHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0x12, 0x34]))).toBeNull();
  });
});

describe('checkImageHeader', () => {
  it('accepts small images of each format', () => {
    for (const b64 of [B64.jpeg, B64.png, B64.webpLossy, B64.webpLossless, B64.webpExtended]) {
      expect(checkImageHeader(bytes(b64)).ok).toBe(true);
    }
  });

  it('refuses GIF and SVG as unsupported', () => {
    expect(checkImageHeader(bytes(B64.gif))).toEqual({ ok: false, reason: 'unsupported' });
    expect(checkImageHeader(text('<svg/>'))).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('refuses a truncated header as unreadable', () => {
    expect(checkImageHeader(bytes(B64.png).slice(0, 12))).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('refuses a zero-sized image as unreadable', () => {
    expect(checkImageHeader(pngWithSize(0, 10))).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('refuses a side over 8192 px', () => {
    expect(checkImageHeader(pngWithSize(MAX_IMAGE_SIDE_PX, 1)).ok).toBe(true);
    expect(checkImageHeader(pngWithSize(MAX_IMAGE_SIDE_PX + 1, 1))).toEqual({ ok: false, reason: 'too-large' });
    expect(checkImageHeader(pngWithSize(1, 100_000))).toEqual({ ok: false, reason: 'too-large' });
  });

  it('refuses more than 40 megapixels even when each side fits', () => {
    expect(checkImageHeader(pngWithSize(8000, 5000)).ok).toBe(true); // exactly 40 MP
    expect(checkImageHeader(pngWithSize(8000, 5001))).toEqual({ ok: false, reason: 'too-large' });
  });

  it('refuses an oversized JPEG frame header', () => {
    const b = bytes(B64.jpeg).slice();
    // Find SOF0 (FF C0) and rewrite height/width to 9000×9000.
    let i = 2;
    while (!(b[i] === 0xff && b[i + 1] === 0xc0)) i += 1;
    b[i + 5] = 0x23; b[i + 6] = 0x28; b[i + 7] = 0x23; b[i + 8] = 0x28;
    expect(checkImageHeader(b)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('refuses an oversized VP8X canvas', () => {
    const b = bytes(B64.webpExtended).slice();
    // canvas width-1 / height-1 are 24-bit LE at 24 and 27: set 16384×16384.
    b[24] = 0xff; b[25] = 0x3f; b[26] = 0x00; b[27] = 0xff; b[28] = 0x3f; b[29] = 0x00;
    expect(checkImageHeader(b)).toEqual({ ok: false, reason: 'too-large' });
  });
});
