import { useEffect, useRef, useCallback, useState } from 'react';
import jsQR from 'jsqr';

interface Props {
  onScan: (data: string) => void;
  active: boolean;
  compact?: boolean;
}

export const QR_SCANNER_PREFERRED_ZOOM = 1.6;
export const QR_SCANNER_ZOOM_BUTTON_STEP = 0.2;
export const QR_SCANNER_DIGITAL_ZOOM_RANGE = { min: 1, max: 3.5, step: 0.1 };
export const QR_SCANNER_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30, max: 30 },
};

export function qrScanSourceRect(videoWidth: number, videoHeight: number, zoom: number) {
  const safeWidth = Math.max(0, videoWidth);
  const safeHeight = Math.max(0, videoHeight);
  const safeZoom = Number.isFinite(zoom) ? Math.max(1, Math.min(zoom, 6)) : 1;
  const width = safeWidth / safeZoom;
  const height = safeHeight / safeZoom;
  return {
    sx: (safeWidth - width) / 2,
    sy: (safeHeight - height) / 2,
    sw: width,
    sh: height,
  };
}

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
 * QR Scanner using native getUserMedia + jsQR decoder.
 * No html5-qrcode for camera — just the browser's video element
 * and jsQR for frame-by-frame decoding. No rendering bugs.
 *
 * Booth-friendly: requests a 720p capture (more pixels on a small/distant QR
 * than the ~640×480 default, so jsQR can lock on from arm's length) and, where
 * the camera track exposes a `zoom` capability, shows a zoom slider so a user
 * can pull a QR on a far-off booth screen closer without moving the phone.
 */
export function QRScanner({ onScan, active, compact = false }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scannedRef = useRef(false);
  const onScanRef = useRef(onScan);
  const [error, setError] = useState<string | null>(null);
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
    applyZoom(qrNextZoom(zoomRef.current, zoomRange, direction));
  }, [applyZoom, zoomRange]);

  const nudgeFocus = useCallback(() => {
    const track = trackRef.current as (MediaStreamTrack & { applyConstraints?: (c: unknown) => Promise<void> }) | null;
    if (!track?.applyConstraints) return;
    void track.applyConstraints({
      advanced: [
        { focusMode: 'continuous' },
        { exposureMode: 'continuous' },
      ],
    }).catch(() => { /* unsupported on many mobile browsers */ });
  }, []);

  useEffect(() => {
    if (!active) {
      stopCamera();
      scannedRef.current = false;
      setError(null);
      setZoomRange(null);
      setZoom(1);
      zoomRef.current = 1;
      setHardwareZoomSupported(false);
      hardwareZoomSupportedRef.current = false;
      return;
    }

    let mounted = true;
    scannedRef.current = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: QR_SCANNER_VIDEO_CONSTRAINTS,
          audio: false,
        });

        if (!mounted) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;

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

        scanFrame();
      } catch {
        if (mounted) setError('Could not access camera. Check permissions.');
      }
    }

    function scanFrame() {
      if (!mounted || scannedRef.current) return;

      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < video.HAVE_ENOUGH_DATA) {
        timerRef.current = setTimeout(scanFrame, 250);
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        timerRef.current = setTimeout(scanFrame, 250);
        return;
      }

      const digitalZoom = hardwareZoomSupportedRef.current ? 1 : zoomRef.current;
      const source = qrScanSourceRect(video.videoWidth, video.videoHeight, digitalZoom);
      ctx.drawImage(video, source.sx, source.sy, source.sw, source.sh, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'attemptBoth',
      });

      if (result && result.data && !scannedRef.current) {
        scannedRef.current = true;
        stopCamera();
        onScanRef.current(result.data);
        return;
      }

      // Scan several times per second so small laptop-screen QRs lock quickly.
      timerRef.current = setTimeout(scanFrame, 150);
    }

    start();
    return () => { mounted = false; stopCamera(); };
  }, [active, stopCamera]);

  const digitalPreviewZoom = hardwareZoomSupported ? 1 : zoom;
  const scannerHeight = compact ? 'min(52vh, 390px)' : 'min(70vh, 540px)';
  const scannerMinHeight = compact ? 300 : 380;

  return (
    <div style={{
      position: 'relative',
      width: '100%',
      borderRadius: 'var(--radius-sm)',
      overflow: 'hidden',
      background: '#05070b',
      height: scannerHeight,
      minHeight: scannerMinHeight,
      maxHeight: compact ? 420 : 560,
    }}>
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
      {active && !error && (
        <div style={{
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
        }} />
      )}
      {active && !error && zoomRange && (
        <div style={{
          position: 'absolute',
          bottom: 12,
          left: 12,
          right: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          background: 'rgba(0,0,0,0.62)',
          borderRadius: 8,
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
            onChange={e => applyZoom(Number(e.target.value))}
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
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  );
}
