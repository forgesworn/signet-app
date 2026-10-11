import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { isNativeApp, SignetNative } from '../lib/native';
import { HANDSHAKE_COPY } from '../lib/contacts-v2-copy';
import { createHandshakeFrameReader } from '../lib/handshake-optical';

/** Match the square object-fit: cover preview, retaining the full image for
 * the separate ambiguity check. Never accept a code outside the visible view. */
export function handshakeCameraCrop(width: number, height: number) {
  const size = Math.min(width, height);
  return { x: (width - size) / 2, y: (height - size) / 2, size };
}

/** Only a central, nearby QR, and no second QR in the same frame. */
export function nearbyQR(location: { topLeftCorner: { x: number; y: number }; topRightCorner: { x: number; y: number }; bottomRightCorner: { x: number; y: number }; bottomLeftCorner: { x: number; y: number } }, width: number, height: number) {
  const corners = Object.values(location);
  const minX = Math.min(...corners.map(p => p.x)), maxX = Math.max(...corners.map(p => p.x));
  const minY = Math.min(...corners.map(p => p.y)), maxY = Math.max(...corners.map(p => p.y));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return (maxX - minX) * (maxY - minY) >= width * height * .12
    && Math.abs(cx - width / 2) <= width * .25 && Math.abs(cy - height / 2) <= height * .25;
}
/** Mean brightness of an RGBA frame below which the lens is taken as covered. */
export const COVERED_LUMA = 18;
/** Some phones (the OnePlus 8T) silence NFC while a camera runs. Back to back,
 * the rear camera is pressed against the other phone and sees black: then the
 * camera stops for a while so the NFC tap can work, and starts again after. */
export const COVERED_AFTER_MS = 450, COVERED_REST_MS = 4000, COVERED_WARMUP_MS = 1000;
export function frameIsDark(rgba: Uint8ClampedArray): boolean {
  let sum = 0, n = 0;
  for (let i = 0; i + 2 < rgba.length; i += 4) { sum += rgba[i] * .299 + rgba[i + 1] * .587 + rgba[i + 2] * .114; n++; }
  return n > 0 && sum / n < COVERED_LUMA;
}
export function HandshakeCamera({ facing, active, reading = true, onScan }: { facing: 'user' | 'environment'; active: boolean; reading?: boolean; onScan(data: string): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const latest = useRef(onScan); latest.current = onScan;
  const shouldRead = useRef(reading); shouldRead.current = reading;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active) return;
    let cancelled = false, stream: MediaStream | undefined, timer: ReturnType<typeof setTimeout>;
    let startedAt = 0, darkSince: number | null = null;
    setFailed(false);
    const canvas = document.createElement('canvas');
    const fullCanvas = document.createElement('canvas');
    const probe = document.createElement('canvas'); probe.width = probe.height = 24;
    const readFrame = createHandshakeFrameReader();
    const covered = (v: HTMLVideoElement) => {
      const now = performance.now();
      if (now - startedAt < COVERED_WARMUP_MS) return false;
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(v, 0, 0, probe.width, probe.height);
      if (!frameIsDark(ctx.getImageData(0, 0, probe.width, probe.height).data)) { darkSince = null; return false; }
      darkSince ??= now;
      return now - darkSince >= COVERED_AFTER_MS;
    };
    const frame = () => {
      if (cancelled) return;
      const v = video.current;
      if (v && v.readyState >= 2 && v.videoWidth && covered(v)) {
        stream?.getTracks().forEach(t => t.stop()); stream = undefined;
        timer = setTimeout(() => { void start(); }, COVERED_REST_MS);
        return;
      }
      // Keep the live preview after pinning a peer, without repeatedly decoding
      // the same QR while the signed exchange is being verified.
      if (shouldRead.current && v && v.readyState >= 2 && v.videoWidth) {
        const crop = handshakeCameraCrop(v.videoWidth, v.videoHeight);
        const scale = Math.min(1, 1280 / crop.size);
        canvas.width = Math.round(crop.size * scale); canvas.height = canvas.width;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(v, crop.x, crop.y, crop.size, crop.size, 0, 0, canvas.width, canvas.height);
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const qr = jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' });
          if (qr && nearbyQR(qr.location, data.width, data.height)) {
            // Mask this code and decode again. Ambiguous frames are never accepted.
            const points = [qr.location.topLeftCorner, qr.location.topRightCorner, qr.location.bottomRightCorner, qr.location.bottomLeftCorner];
            const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
            // Look for any second QR in the full camera image, including the
            // area cropped out of the square preview. Keep the size gate.
            const fullScale = Math.min(1, 1280 / v.videoWidth);
            fullCanvas.width = Math.round(v.videoWidth * fullScale); fullCanvas.height = Math.round(v.videoHeight * fullScale);
            const full = fullCanvas.getContext('2d', { willReadFrequently: true });
            if (full) {
              full.drawImage(v, 0, 0, fullCanvas.width, fullCanvas.height);
              full.fillStyle = '#888';
              full.fillRect((crop.x + x / scale) * fullScale - 5, (crop.y + y / scale) * fullScale - 5,
                (Math.max(...points.map(p => p.x)) - x) / scale * fullScale + 10,
                (Math.max(...points.map(p => p.y)) - y) / scale * fullScale + 10);
              const masked = full.getImageData(0, 0, fullCanvas.width, fullCanvas.height);
              if (!jsQR(masked.data, masked.width, masked.height, { inversionAttempts: 'attemptBoth' })) {
                const raw = readFrame(qr.data, performance.now());
                if (raw !== null) latest.current(raw);
              }
            }
          }
        }
      }
      timer = setTimeout(frame, 150);
    };
    const start = async () => {
      try {
        if (isNativeApp()) await SignetNative.requestCameraPermission();
        if (cancelled) return;
        const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (cancelled) { next.getTracks().forEach(t => t.stop()); return; }
        stream = next; startedAt = performance.now(); darkSince = null;
        if (video.current) { video.current.srcObject = stream; await video.current.play(); }
        frame();
      } catch { if (!cancelled) setFailed(true); }
    };
    void start();
    return () => { cancelled = true; clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()); };
  }, [facing, active]);
  return <div className="handshake-camera">
    <video ref={video} autoPlay playsInline muted />
    {failed && <p role="alert">{HANDSHAKE_COPY.cameraError}</p>}
  </div>;
}
