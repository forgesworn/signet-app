import { useEffect, useRef, useCallback, useState } from 'react';
import { isNativeApp, SignetNative } from '../lib/native';
import { createQrDecoderClient, type QrDecoderClient } from '../lib/qr-decoder-client';
import { pickNearestCentre, qrBoxRegion, qrDecodeSize } from '../lib/qr-scan-geometry';

export { pickNearestCentre, qrBoxRegion, qrDecodeSize } from '../lib/qr-scan-geometry';

interface Props {
  onScan: (data: string) => void;
  active: boolean;
  compact?: boolean;
  /** Take 100% of the parent's width and height, with no min/max caps. */
  fill?: boolean;
  /** Extra space (px) kept clear under the overlay controls, for a host that overlays its own. */
  bottomInset?: number;
}

/** Minimum gap between the end of one decode and the start of the next. */
export const QR_SCAN_MIN_GAP_MS = 80;
/** With no code found and no touch for this long, the camera switches off to save battery. */
export const QR_SCANNER_IDLE_MS = 60_000;

export const QR_SCANNER_PREFERRED_ZOOM = 1.6;
export const QR_SCANNER_ZOOM_BUTTON_STEP = 0.2;
export const QR_SCANNER_DIGITAL_ZOOM_RANGE = { min: 1, max: 3.5, step: 0.1 };
export const QR_SCANNER_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30, max: 30 },
};

export function qrInitialZoom(range: { min: number; max: number } | null, preferred = QR_SCANNER_PREFERRED_ZOOM) {
  if (!range) return Math.max(1, preferred);
  return Math.max(range.min, Math.min(preferred, range.max));
}

export function qrNextZoom(
  current: number,
  range: { min: number; max: number; step?: number },
  direction: -1 | 1,
  buttonStep = QR_SCANNER_ZOOM_BUTTON_STEP,
) {
  const step = Math.max(range.step ?? buttonStep, buttonStep);
  const next = current + (direction * step);
  const bounded = Math.max(range.min, Math.min(range.max, next));
  return Number(bounded.toFixed(2));
}


/**
 * QR scanner: getUserMedia preview + an off-main-thread decoder (zxing-wasm in
 * a worker, jsQR as the fallback).
 *
 * Only the framing box (plus a margin) is decoded, so with several codes in
 * view the one the user is aiming at wins. One decode is in flight at a time;
 * the next frame is taken only after the previous result returns.
 *
 * Booth-friendly: requests a 1080p capture and, where the camera track exposes
 * a `zoom` capability, shows a zoom slider so a user can pull a QR on a far-off
 * screen closer without moving the phone.
 */
export function QRScanner({ onScan, active, compact = false, fill = false, bottomInset = 0 }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scannedRef = useRef(false);
  const pausedRef = useRef(false);
  const kickRef = useRef<() => void>(() => {});
  const onScanRef = useRef(onScan);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [idle, setIdle] = useState(false);
  // Bumped by any touch on the controls, so the idle countdown starts again.
  const [touchedAt, setTouchedAt] = useState(0);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  // Zoom is progressive enhancement: only cameras whose track reports a `zoom`
  // capability use optical zoom. Everyone else gets a digital center-crop zoom.
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number; step: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [hardwareZoomSupported, setHardwareZoomSupported] = useState(false);
  const zoomRef = useRef(1);
  const hardwareZoomSupportedRef = useRef(false);
  zoomRef.current = zoom;
  hardwareZoomSupportedRef.current = hardwareZoomSupported;
  onScanRef.current = onScan;

  const stopCamera = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    trackRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const applyZoom = useCallback((value: number) => {
    const range = zoomRange ?? QR_SCANNER_DIGITAL_ZOOM_RANGE;
    const bounded = Number(Math.max(range.min, Math.min(range.max, value)).toFixed(2));
    zoomRef.current = bounded;
    setZoom(bounded);
    if (!hardwareZoomSupportedRef.current) return;
    // `zoom` is not in the standard MediaTrackConstraintSet type yet.
    const track = trackRef.current as (MediaStreamTrack & { applyConstraints?: (c: unknown) => Promise<void> }) | null;
    if (!track?.applyConstraints) return;
    try {
      void track.applyConstraints({ advanced: [{ zoom: bounded }] });
    } catch {
      // Camera rejected the constraint mid-stream — leave zoom where it was.
    }
  }, [zoomRange]);

  const stepZoom = useCallback((direction: -1 | 1) => {
    if (!zoomRange) return;
    setTouchedAt(Date.now());
    applyZoom(qrNextZoom(zoomRef.current, zoomRange, direction));
  }, [applyZoom, zoomRange]);

  const nudgeFocus = useCallback(() => {
    setTouchedAt(Date.now());
    const track = trackRef.current as (MediaStreamTrack & { applyConstraints?: (c: unknown) => Promise<void> }) | null;
    if (!track?.applyConstraints) return;
    void track.applyConstraints({
      advanced: [
        { focusMode: 'continuous' },
        { exposureMode: 'continuous' },
      ],
    }).catch(() => { /* unsupported on many mobile browsers */ });
  }, []);

  const togglePause = useCallback(() => {
    setTouchedAt(Date.now());
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (next) {
      // No further decode submissions; the preview keeps running.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    } else {
      kickRef.current();
    }
  }, []);

  // The app can stay alive in the background (always-on bunker suspends
  // auto-lock), so release the camera whenever the page is hidden.
  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Reset per-session state when the scanner is switched off.
  useEffect(() => {
    if (active) return;
    scannedRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    setIdle(false);
    setError(null);
    setZoomRange(null);
    setZoom(1);
    zoomRef.current = 1;
    setHardwareZoomSupported(false);
    hardwareZoomSupportedRef.current = false;
  }, [active]);

  // A camera left running with nothing to read is wasted battery and a lit
  // camera indicator: switch it off after a quiet minute, tap to wake.
  useEffect(() => {
    if (!active || hidden || idle) return;
    const timer = setTimeout(() => {
      if (!scannedRef.current) setIdle(true);
    }, QR_SCANNER_IDLE_MS);
    return () => clearTimeout(timer);
  }, [active, hidden, idle, touchedAt]);

  const wake = useCallback(() => {
    pausedRef.current = false;
    setPaused(false);
    setTouchedAt(Date.now());
    setIdle(false);
  }, []);

  useEffect(() => {
    if (!active || hidden || idle || scannedRef.current) {
      stopCamera();
      return;
    }

    let mounted = true;
    let inFlight = false;
    let client: QrDecoderClient | null = null;

    async function start() {
      try {
        if (isNativeApp()) {
          // The WebView can only be granted camera access if the Android app
          // itself holds CAMERA. Denial falls through to getUserMedia, which
          // fails with the normal permission error below.
          try { await SignetNative.requestCameraPermission(); } catch { /* fall through */ }
          if (!mounted) return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: QR_SCANNER_VIDEO_CONSTRAINTS,
          audio: false,
        });

        if (!mounted) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        setError(null);

        const track = stream.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        // Surface the zoom slider only when the device's camera supports it
        // (Android Chrome mostly does; iOS Safari historically does not).
        const caps = track?.getCapabilities?.() as Record<string, unknown> | undefined;
        const zoomCap = caps?.zoom as { min?: number; max?: number; step?: number } | undefined;
        if (zoomCap && typeof zoomCap.max === 'number') {
          const min = zoomCap.min ?? 1;
          const max = zoomCap.max;
          if (max > min) {
            setHardwareZoomSupported(true);
            hardwareZoomSupportedRef.current = true;
            setZoomRange({ min, max, step: zoomCap.step || 0.1 });
            const initialZoom = qrInitialZoom({ min, max });
            zoomRef.current = initialZoom;
            setZoom(initialZoom);
            void (track as MediaStreamTrack & { applyConstraints?: (c: unknown) => Promise<void> })
              .applyConstraints?.({ advanced: [{ zoom: initialZoom }] })
              .catch(() => { /* optical zoom is best-effort */ });
          }
        }
        if (!zoomCap || typeof zoomCap.max !== 'number' || (zoomCap.max ?? 1) <= (zoomCap.min ?? 1)) {
          setHardwareZoomSupported(false);
          hardwareZoomSupportedRef.current = false;
          setZoomRange(QR_SCANNER_DIGITAL_ZOOM_RANGE);
          const initialZoom = qrInitialZoom(QR_SCANNER_DIGITAL_ZOOM_RANGE);
          zoomRef.current = initialZoom;
          setZoom(initialZoom);
        }

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        if (!mounted) return;

        client = createQrDecoderClient();
        void scanFrame();
      } catch {
        if (mounted) setError('Could not access camera. Check permissions.');
      }
    }

    function schedule(delay: number) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { void scanFrame(); }, delay);
    }

    kickRef.current = () => {
      if (!mounted || !client || inFlight || scannedRef.current || pausedRef.current) return;
      schedule(0);
    };

    async function scanFrame() {
      timerRef.current = null;
      if (!mounted || !client || inFlight || scannedRef.current || pausedRef.current) return;

      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < video.HAVE_ENOUGH_DATA || !video.videoWidth || !video.videoHeight) {
        schedule(250);
        return;
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        schedule(250);
        return;
      }

      // Decode just the framing box (+ margin), mapped back into video pixels.
      const root = rootRef.current;
      const box = boxRef.current;
      const rootRect = root?.getBoundingClientRect();
      const boxRect = box?.getBoundingClientRect();
      const region = qrBoxRegion(
        { width: video.videoWidth, height: video.videoHeight },
        { width: video.clientWidth, height: video.clientHeight },
        rootRect && boxRect
          ? { left: boxRect.left - rootRect.left, top: boxRect.top - rootRect.top, width: boxRect.width, height: boxRect.height }
          : { left: 0, top: 0, width: 0, height: 0 },
        hardwareZoomSupportedRef.current ? 1 : zoomRef.current,
      );
      const size = qrDecodeSize(region.sw, region.sh);
      if (canvas.width !== size.width) canvas.width = size.width;
      if (canvas.height !== size.height) canvas.height = size.height;
      ctx.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, size.width, size.height);
      const image = ctx.getImageData(0, 0, size.width, size.height);

      inFlight = true;
      const started = performance.now();
      let out: Awaited<ReturnType<QrDecoderClient['decode']>> | null = null;
      try {
        out = await client.decode({ width: size.width, height: size.height, buffer: image.data.buffer as ArrayBuffer });
      } catch {
        out = null;
      }
      inFlight = false;
      if (!mounted) return;
      if (out && root) {
        root.setAttribute('data-decoder', out.decoder);
        root.setAttribute('data-last-decode-ms', String(Math.round(performance.now() - started)));
      }
      // Paused while this decode was running: drop it; resume restarts the loop.
      if (scannedRef.current || pausedRef.current) return;

      const hit = out ? pickNearestCentre(out.results, size.width, size.height) : null;
      if (hit && hit.text) {
        scannedRef.current = true;
        stopCamera();
        onScanRef.current(hit.text);
        return;
      }
      schedule(QR_SCAN_MIN_GAP_MS);
    }

    void start();
    return () => {
      mounted = false;
      kickRef.current = () => {};
      client?.destroy();
      stopCamera();
    };
  }, [active, hidden, idle, stopCamera]);

  const digitalPreviewZoom = hardwareZoomSupported ? 1 : zoom;
  const scannerHeight = fill ? '100%' : compact ? 'min(52vh, 390px)' : 'min(70vh, 540px)';
  const scannerMinHeight = fill ? 0 : compact ? 300 : 380;
  const showOverlay = active && !error && !idle;

  return (
    <div
      ref={rootRef}
      className={`qr-scanner${paused ? ' qr-scanner--paused' : ''}`}
      style={{
        position: 'relative',
        width: '100%',
        borderRadius: fill ? 0 : 'var(--radius-sm)',
        overflow: 'hidden',
        background: '#05070b',
        height: scannerHeight,
        minHeight: scannerMinHeight,
        maxHeight: fill ? undefined : compact ? 420 : 560,
      }}
    >
      {error && (
        <div style={{ padding: 16, textAlign: 'center', color: 'var(--danger)', fontSize: '0.9rem' }}>
          {error}
        </div>
      )}
      <video
        ref={videoRef}
        onClick={nudgeFocus}
        style={{
          width: '100%',
          height: '100%',
          minHeight: scannerMinHeight,
          display: 'block',
          objectFit: 'cover',
          transform: digitalPreviewZoom > 1 ? `scale(${digitalPreviewZoom})` : undefined,
          transformOrigin: 'center',
          cursor: active && !error ? 'crosshair' : undefined,
        }}
        playsInline
        muted
      />
      {active && !error && idle && (
        <div
          data-testid="qr-scanner-idle"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: 24,
            textAlign: 'center',
            color: '#fff',
          }}
        >
          <span role="status" style={{ fontSize: 14, lineHeight: 1.35, opacity: 0.85 }}>
            Camera off to save battery
          </span>
          <button type="button" className="btn btn-primary" onClick={wake} aria-label="Turn the camera back on">
            Scan
          </button>
        </div>
      )}
      {showOverlay && (
        <div
          ref={boxRef}
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 'min(74vw, 320px, calc(100% - 48px))',
            aspectRatio: '1 / 1',
            border: '2px solid rgba(255,255,255,0.7)',
            borderRadius: 12,
            boxShadow: '0 0 0 999px rgba(0,0,0,0.18)',
            pointerEvents: 'none',
            overflow: 'hidden',
          }}
        >
          {!paused && (
            <div className="qr-scan-sweep" aria-hidden="true" data-testid="qr-scan-line">
              <div className="qr-scan-line" />
            </div>
          )}
        </div>
      )}
      {showOverlay && (
        <div
          style={{
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: 12 + bottomInset,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            pointerEvents: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
            {paused && (
              <span
                role="status"
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: 'rgba(0,0,0,0.62)',
                  color: '#fff',
                  fontSize: 13,
                  lineHeight: 1.25,
                }}
              >
                Paused &mdash; line it up, then tap Scan
              </span>
            )}
            <button
              type="button"
              onClick={togglePause}
              aria-label={paused ? 'Resume scanning' : 'Pause scanning'}
              style={{
                flexShrink: 0,
                minWidth: 76,
                height: 44,
                padding: '0 16px',
                border: 0,
                borderRadius: 22,
                background: paused ? 'var(--accent)' : 'rgba(0,0,0,0.62)',
                color: '#fff',
                fontSize: 14,
                fontWeight: 600,
                pointerEvents: 'auto',
              }}
            >
              {paused ? 'Scan' : 'Pause'}
            </button>
          </div>
          {zoomRange && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 12px',
              background: 'rgba(0,0,0,0.62)',
              borderRadius: 8,
              pointerEvents: 'auto',
            }}>
              <button
                type="button"
                onClick={() => stepZoom(-1)}
                aria-label="Zoom out"
                disabled={zoom <= zoomRange.min}
                style={{
                  width: 40,
                  height: 40,
                  border: 0,
                  borderRadius: 8,
                  background: 'rgba(255,255,255,0.18)',
                  color: '#fff',
                  fontSize: 22,
                  fontWeight: 700,
                  lineHeight: 1,
                  opacity: zoom <= zoomRange.min ? 0.45 : 1,
                }}
              >
                -
              </button>
              <input
                type="range"
                min={zoomRange.min}
                max={zoomRange.max}
                step={zoomRange.step}
                value={zoom}
                onChange={e => { setTouchedAt(Date.now()); applyZoom(Number(e.target.value)); }}
                style={{ flex: 1, accentColor: 'var(--accent)', minWidth: 0 }}
                aria-label="Camera zoom"
              />
              <button
                type="button"
                onClick={() => stepZoom(1)}
                aria-label="Zoom in"
                disabled={zoom >= zoomRange.max}
                style={{
                  width: 40,
                  height: 40,
                  border: 0,
                  borderRadius: 8,
                  background: 'rgba(255,255,255,0.18)',
                  color: '#fff',
                  fontSize: 22,
                  fontWeight: 700,
                  lineHeight: 1,
                  opacity: zoom >= zoomRange.max ? 0.45 : 1,
                }}
              >
                +
              </button>
              <span style={{ color: '#fff', fontSize: 12, fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right' }}>
                {zoom.toFixed(1)}x
              </span>
            </div>
          )}
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  );
}
