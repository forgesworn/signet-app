// Pure pieces of the QR decoding pipeline, shared by the worker and the
// main-thread fallback. No DOM, no worker globals: everything environmental
// (the zxing loader, jsQR) is injected so each branch can be unit-tested.
import jsQR from 'jsqr';

/** Raw RGBA pixels of a (cropped) camera frame. */
export interface QrFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** One decoded code: its text and the centre of the symbol in frame pixels. */
export interface QrHit {
  text: string;
  cx: number;
  cy: number;
}

export type QrDecoderKind = 'zxing' | 'jsqr';

export interface QrDecodeOutput {
  results: QrHit[];
  decoder: QrDecoderKind;
}

/** Reads every QR code in a frame (multi-symbol, inversion enabled). */
export type ZxingRead = (frame: QrFrame) => Promise<QrHit[]>;

export type JsqrInversion = 'dontInvert' | 'onlyInvert';

/**
 * jsQR is a single-pass, single-polarity decoder: `attemptBoth` runs it twice
 * on every frame. Instead, alternate polarity across successive frames, which
 * halves the per-frame cost and still catches an inverted code within two.
 */
export function jsqrInversionForFrame(frameIndex: number): JsqrInversion {
  return frameIndex % 2 === 0 ? 'dontInvert' : 'onlyInvert';
}

type JsqrFn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: JsqrInversion },
) => { data: string; location: { topLeftCorner: Point; bottomRightCorner: Point; topRightCorner: Point; bottomLeftCorner: Point } } | null;

interface Point { x: number; y: number }

export interface QrDecoderOptions {
  /** Resolves the zxing reader, or rejects (wasm blocked, module failed to start). Omit for jsQR only. */
  loadZxing?: () => Promise<ZxingRead>;
  jsqr?: JsqrFn;
}

type ZxingState = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * Chooses a decoder per frame: zxing while it works, jsQR the moment it does
 * not (failed init, or a read that throws), and keeps using jsQR from then on.
 */
export class QrDecoder {
  private state: ZxingState;
  private reader: ZxingRead | null = null;
  private loading: Promise<void> | null = null;
  private frames = 0;
  private readonly loadZxing: (() => Promise<ZxingRead>) | undefined;
  private readonly jsqr: JsqrFn;

  constructor(options: QrDecoderOptions = {}) {
    this.loadZxing = options.loadZxing;
    this.jsqr = options.jsqr ?? (jsQR as unknown as JsqrFn);
    this.state = this.loadZxing ? 'idle' : 'failed';
  }

  /** Start zxing initialisation early so the first frame does not pay for it. */
  warm(): Promise<void> {
    if (this.state !== 'idle' || !this.loadZxing) return this.loading ?? Promise.resolve();
    this.state = 'loading';
    this.loading = this.loadZxing().then(
      (reader) => { this.reader = reader; this.state = 'ready'; },
      () => { this.state = 'failed'; },
    );
    return this.loading;
  }

  get kind(): QrDecoderKind {
    return this.state === 'ready' ? 'zxing' : 'jsqr';
  }

  async decode(frame: QrFrame): Promise<QrDecodeOutput> {
    if (this.state === 'idle' || this.state === 'loading') await this.warm();
    if (this.state === 'ready' && this.reader) {
      try {
        return { results: await this.reader(frame), decoder: 'zxing' };
      } catch {
        this.state = 'failed';
        this.reader = null;
      }
    }
    return { results: this.decodeWithJsqr(frame), decoder: 'jsqr' };
  }

  private decodeWithJsqr(frame: QrFrame): QrHit[] {
    const inversionAttempts = jsqrInversionForFrame(this.frames++);
    const hit = this.jsqr(frame.data, frame.width, frame.height, { inversionAttempts });
    if (!hit || !hit.data) return [];
    const { topLeftCorner: a, topRightCorner: b, bottomRightCorner: c, bottomLeftCorner: d } = hit.location;
    return [{ text: hit.data, cx: (a.x + b.x + c.x + d.x) / 4, cy: (a.y + b.y + c.y + d.y) / 4 }];
  }
}
