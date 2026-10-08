import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { isNativeApp, SignetNative } from '../lib/native';
import { HANDSHAKE_COPY } from '../lib/contacts-v2-copy';

/** Only a central, nearby QR, and no second QR in the same frame. */
export function nearbyQR(location: { topLeftCorner: { x: number; y: number }; topRightCorner: { x: number; y: number }; bottomRightCorner: { x: number; y: number }; bottomLeftCorner: { x: number; y: number } }, width: number, height: number) {
  const corners = Object.values(location);
  const minX = Math.min(...corners.map(p => p.x)), maxX = Math.max(...corners.map(p => p.x));
  const minY = Math.min(...corners.map(p => p.y)), maxY = Math.max(...corners.map(p => p.y));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return (maxX - minX) * (maxY - minY) >= width * height * .12
    && Math.abs(cx - width / 2) <= width * .25 && Math.abs(cy - height / 2) <= height * .25;
}
export function HandshakeCamera({ facing, active, reading = true, onScan }: { facing: 'user' | 'environment'; active: boolean; reading?: boolean; onScan(data: string): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const latest = useRef(onScan); latest.current = onScan;
  const shouldRead = useRef(reading); shouldRead.current = reading;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active) return;
    let cancelled = false, stream: MediaStream | undefined, timer: ReturnType<typeof setTimeout>;
    setFailed(false);
    const canvas = document.createElement('canvas');
    const frame = () => {
      if (cancelled) return;
      const v = video.current;
      // Keep the live preview after pinning a peer, without repeatedly decoding
      // the same QR while the signed exchange is being verified.
      if (shouldRead.current && v && v.readyState >= 2 && v.videoWidth) {
        const scale = Math.min(1, 1280 / v.videoWidth);
        canvas.width = Math.round(v.videoWidth * scale); canvas.height = Math.round(v.videoHeight * scale);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const qr = jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' });
          if (qr && nearbyQR(qr.location, data.width, data.height)) {
            // Mask this code and decode again. Ambiguous frames are never accepted.
            const points = [qr.location.topLeftCorner, qr.location.topRightCorner, qr.location.bottomRightCorner, qr.location.bottomLeftCorner];
            const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
            ctx.fillStyle = '#888'; ctx.fillRect(x - 5, y - 5, Math.max(...points.map(p => p.x)) - x + 10, Math.max(...points.map(p => p.y)) - y + 10);
            const masked = ctx.getImageData(0, 0, canvas.width, canvas.height);
            if (!jsQR(masked.data, masked.width, masked.height, { inversionAttempts: 'attemptBoth' })) latest.current(qr.data);
          }
        }
      }
      timer = setTimeout(frame, 150);
    };
    void (async () => {
      try {
        if (isNativeApp()) await SignetNative.requestCameraPermission();
        if (cancelled) return;
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        if (video.current) { video.current.srcObject = stream; await video.current.play(); }
        frame();
      } catch { if (!cancelled) setFailed(true); }
    })();
    return () => { cancelled = true; clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()); };
  }, [facing, active]);
  return <div className="handshake-camera">
    <video ref={video} autoPlay playsInline muted />
    {failed && <p role="alert">{HANDSHAKE_COPY.cameraError}</p>}
  </div>;
}
