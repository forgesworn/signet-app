import { useEffect, useId, useRef, useState } from 'react';
import {
  CANCEL_LABEL, CROP_HINT, CROP_LOADING_COPY, CROP_TITLE, OWN_PICTURE_UNREADABLE_COPY, USE_THIS_PICTURE_LABEL, ZOOM_LABEL,
} from '../lib/contacts-v2-copy';
import {
  clampCropRect, cropRectWithSide, defaultCropRect, panCropRect, sideFromSlider, sliderFromSide, toPictureCrop, zoomCropRect,
  type CropRect, type PictureCrop,
} from '../lib/picture-crop';
import { loadCropPicture, type CropPicture, type CropPictureLoader } from '../lib/picture-crop-loader';
import { Z } from '../lib/z-index';

/** The square frame: the screen width minus 32 px, capped at 360 px. */
const FRAME_MAX_PX = 360;
const FRAME_MARGIN_PX = 32;
/** Dimmed band above and below the square, so the photo can be seen to continue past it. */
const STAGE_PAD_PX = 28;
/** Wheel zoom: the factor per pixel of scroll (lines are scaled up to pixels). */
const WHEEL_ZOOM_PER_PX = 0.002;
const WHEEL_LINE_PX = 16;

type Point = { x: number; y: number };

/**
 * The crop screen for "your own picture": a square frame over the photo with a
 * circle inscribed (the avatar shows the circle; the whole square is saved).
 * Drag to move, pinch, mouse wheel or the Zoom slider to zoom. The photo always
 * covers the square, and zoom stops where the square spans 64 source pixels
 * (`picture-crop.ts` holds the geometry). `onUse` receives the square as
 * fractions of the oriented image.
 */
export function ContactPictureCrop({ file, onUse, onCancel, loadPicture = loadCropPicture }: {
  file: Blob;
  onUse: (crop: PictureCrop) => void;
  onCancel: () => void;
  /** Swappable in tests (jsdom has no image decoder). */
  loadPicture?: CropPictureLoader;
}) {
  const [picture, setPicture] = useState<CropPicture | null>(null);
  const [failed, setFailed] = useState(false);
  const [rect, setRect] = useState<CropRect | null>(null);
  const [frame, setFrame] = useState(() => Math.min(FRAME_MAX_PX, Math.max(120, window.innerWidth - FRAME_MARGIN_PX)));
  const rectRef = useRef<CropRect | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const squareRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const sliderId = useId();
  // Held in a ref so an inline loader in a test does not re-open the photo every render.
  const loaderRef = useRef(loadPicture);
  loaderRef.current = loadPicture;

  const commit = (next: CropRect) => {
    rectRef.current = next;
    setRect(next);
  };

  // Size the frame from the space the screen (or the desktop phone frame) really gives it.
  useEffect(() => {
    const width = rootRef.current?.clientWidth || window.innerWidth;
    setFrame(Math.min(FRAME_MAX_PX, Math.max(120, width - FRAME_MARGIN_PX)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let opened: CropPicture | null = null;
    setPicture(null);
    setFailed(false);
    rectRef.current = null;
    setRect(null);
    loaderRef.current(file).then(
      p => {
        if (cancelled) { p.release(); return; }
        opened = p;
        setPicture(p);
        commit(defaultCropRect(p.width, p.height));
      },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => {
      cancelled = true;
      opened?.release();
    };
  }, [file]);

  /** Where a client point sits in the square, as fractions (0..1) of it. */
  const anchorOf = (p: Point): Point => {
    const box = squareRef.current?.getBoundingClientRect();
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
    return { x: clamp01((p.x - (box?.left ?? 0)) / frame), y: clamp01((p.y - (box?.top ?? 0)) / frame) };
  };

  // React attaches `onWheel` as a passive listener, which cannot stop the page scrolling: attach it natively.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !picture) return undefined;
    const onWheel = (e: WheelEvent) => {
      const current = rectRef.current;
      if (!current) return;
      e.preventDefault();
      const px = e.deltaMode === 1 ? e.deltaY * WHEEL_LINE_PX : e.deltaY;
      commit(zoomCropRect(picture.width, picture.height, current, Math.exp(-px * WHEEL_ZOOM_PER_PX), anchorOf({ x: e.clientX, y: e.clientY })));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picture, frame]);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const before = pointers.current.get(e.pointerId);
    const current = rectRef.current;
    if (!before || !current || !picture) return;
    const after = { x: e.clientX, y: e.clientY };
    if (pointers.current.size === 1) {
      commit(panCropRect(picture.width, picture.height, current, after.x - before.x, after.y - before.y, frame));
      pointers.current.set(e.pointerId, after);
      return;
    }
    // Two fingers: the midpoint pans, the change in their distance zooms about the midpoint.
    const pts = [...pointers.current.entries()].slice(0, 2);
    const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const gap = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
    const was = pts.map(([, p]) => p);
    const now = pts.map(([id, p]) => (id === e.pointerId ? after : p));
    pointers.current.set(e.pointerId, after);
    const m0 = mid(was[0], was[1]);
    const m1 = mid(now[0], now[1]);
    const d0 = gap(was[0], was[1]);
    const d1 = gap(now[0], now[1]);
    let next = panCropRect(picture.width, picture.height, current, m1.x - m0.x, m1.y - m0.y, frame);
    if (d0 > 0 && d1 > 0) next = zoomCropRect(picture.width, picture.height, next, d1 / d0, anchorOf(m1));
    commit(next);
  }

  function onPointerEnd(e: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }

  const scale = rect ? frame / rect.side : 1;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${sliderId}-title`}
      style={{
        position: 'fixed', inset: 0, zIndex: Z.modal, background: 'var(--bg-primary)', overflowY: 'auto',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: 16, boxSizing: 'border-box',
      }}
    >
      <h2 id={`${sliderId}-title`} style={{ margin: 0 }}>{CROP_TITLE}</h2>
      {failed && <p role="alert">{OWN_PICTURE_UNREADABLE_COPY}</p>}
      {!failed && !picture && <p role="status">{CROP_LOADING_COPY}</p>}
      {picture && rect && (
        <>
          <div
            ref={stageRef}
            data-testid="crop-stage"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            style={{
              position: 'relative', width: '100%', height: frame + STAGE_PAD_PX * 2, overflow: 'hidden',
              touchAction: 'none', background: '#000', cursor: 'grab', userSelect: 'none',
            }}
          >
            <div
              ref={squareRef}
              data-testid="crop-square"
              style={{ position: 'absolute', left: '50%', top: STAGE_PAD_PX, width: frame, height: frame, marginLeft: -frame / 2 }}
            >
              <img
                src={picture.src}
                alt=""
                draggable={false}
                style={{
                  position: 'absolute', left: -rect.x * scale, top: -rect.y * scale,
                  width: picture.width * scale, height: picture.height * scale, maxWidth: 'none',
                  imageOrientation: 'from-image', pointerEvents: 'none', userSelect: 'none',
                }}
              />
              {/* Outside the square 60% dark; the square's corners outside the circle 30% dark, and still saved. */}
              <div
                aria-hidden
                style={{
                  position: 'absolute', inset: 0, pointerEvents: 'none', outline: '1px solid #fff',
                  boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.6)',
                  background: 'radial-gradient(circle closest-side, transparent 99.5%, rgba(0, 0, 0, 0.3) 100%)',
                }}
              />
              <div
                aria-hidden
                style={{ position: 'absolute', inset: 0, pointerEvents: 'none', boxSizing: 'border-box', borderRadius: '50%', border: '2px solid #fff' }}
              />
            </div>
          </div>
          <p className="field-hint" style={{ margin: 0, maxWidth: frame }}>{CROP_HINT}</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: frame }}>
            <label htmlFor={sliderId}>{ZOOM_LABEL}</label>
            <input
              id={sliderId}
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={sliderFromSide(picture.width, picture.height, rect.side)}
              style={{ flex: 1 }}
              onChange={e => {
                const side = sideFromSlider(picture.width, picture.height, Number(e.target.value));
                commit(cropRectWithSide(picture.width, picture.height, rect, side));
              }}
            />
          </div>
        </>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn btn-primary"
          disabled={!picture || !rect}
          onClick={() => {
            if (!picture || !rect) return;
            onUse(toPictureCrop(picture.width, picture.height, clampCropRect(picture.width, picture.height, rect)));
          }}
        >
          {USE_THIS_PICTURE_LABEL}
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>{CANCEL_LABEL}</button>
      </div>
    </div>
  );
}
