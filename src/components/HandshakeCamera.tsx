import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { isNativeApp, SignetNative } from '../lib/native';
import { HANDSHAKE_COPY } from '../lib/contacts-v2-copy';
import { createHandshakeFrameReader } from '../lib/handshake-optical';
import { createQrDecoderClient, type QrDecoderClient } from '../lib/qr-decoder-client';
import type { QrDecodeOutput, QrHit } from '../lib/qr-decode-core';

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
  return nearbyBox((minX + maxX) / 2, (minY + maxY) / 2, maxX - minX, maxY - minY, width, height);
}
function nearbyBox(cx: number, cy: number, w: number, h: number, width: number, height: number) {
  return w * h >= width * height * .12
    && Math.abs(cx - width / 2) <= width * .25 && Math.abs(cy - height / 2) <= height * .25;
}
/** Longest side of the frame handed to the decoder. */
export const HANDSHAKE_DECODE_SIDE = 1280;
/** Least gap between decodes; the next one waits for the last to finish. */
export const HANDSHAKE_SCAN_GAP_MS = 80;
/** The one code a full camera frame may be read for, or null. The decoder
 * reads every code in the frame, so any second code, even outside the square
 * preview, makes the frame ambiguous and it is refused. */
export function handshakeHit(hits: readonly QrHit[], width: number, height: number): QrHit | null {
  if (hits.length !== 1 || !hits[0].text) return null;
  const [hit] = hits, crop = handshakeCameraCrop(width, height);
  const x = hit.cx - crop.x, y = hit.cy - crop.y;
  // Never accept a code that runs outside the visible square.
  const visible = x - hit.w / 2 >= 0 && y - hit.h / 2 >= 0 && x + hit.w / 2 <= crop.size && y + hit.h / 2 <= crop.size;
  return visible && nearbyBox(x, y, hit.w, hit.h, crop.size, crop.size) ? hit : null;
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
    const probe = document.createElement('canvas'); probe.width = probe.height = 24;
    const readFrame = createHandshakeFrameReader();
    let client: QrDecoderClient | undefined;
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
    // jsQR returns one code at most, so without zxing a found code is masked
    // and the frame read again, as before. Ambiguous frames are never accepted.
    const secondCode = (ctx: CanvasRenderingContext2D, hit: QrHit) => {
      ctx.fillStyle = '#888';
      ctx.fillRect(hit.cx - hit.w / 2 - 5, hit.cy - hit.h / 2 - 5, hit.w + 10, hit.h + 10);
      const masked = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return !!jsQR(masked.data, masked.width, masked.height, { inversionAttempts: 'attemptBoth' });
    };
    const frame = async () => {
      if (cancelled) return;
      const v = video.current;
      if (v && v.readyState >= 2 && v.videoWidth && covered(v)) {
        stream?.getTracks().forEach(t => t.stop()); stream = undefined;
        timer = setTimeout(() => { void start(); }, COVERED_REST_MS);
        return;
      }
      // Keep the live preview after pinning a peer, without repeatedly decoding
      // the same QR while the signed exchange is being verified.
      if (!shouldRead.current || !v || v.readyState < 2 || !v.videoWidth) { timer = setTimeout(frame, 150); return; }
      const scale = Math.min(1, HANDSHAKE_DECODE_SIDE / Math.max(v.videoWidth, v.videoHeight));
      const width = Math.round(v.videoWidth * scale), height = Math.round(v.videoHeight * scale);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) { timer = setTimeout(frame, 150); return; }
      ctx.drawImage(v, 0, 0, width, height);
      const started = performance.now();
      client ??= createQrDecoderClient();
      let out: QrDecodeOutput = { results: [], decoder: 'jsqr' };
      try { out = await client.decode({ width, height, buffer: ctx.getImageData(0, 0, width, height).data.buffer }); } catch { /* treated as no code */ }
      if (cancelled) return;
      const hit = handshakeHit(out.results, width, height);
      if (hit && (out.decoder === 'zxing' || !secondCode(ctx, hit))) {
        const raw = readFrame(hit.text, performance.now());
        if (raw !== null) latest.current(raw);
      }
      // jsQR runs on the main thread once the worker is gone: keep the old pace.
      timer = setTimeout(frame, out.decoder === 'zxing' ? Math.max(0, HANDSHAKE_SCAN_GAP_MS - (performance.now() - started)) : 150);
    };
    const start = async () => {
      try {
        if (isNativeApp()) await SignetNative.requestCameraPermission();
        if (cancelled) return;
        const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (cancelled) { next.getTracks().forEach(t => t.stop()); return; }
        stream = next; startedAt = performance.now(); darkSince = null;
        if (video.current) { video.current.srcObject = stream; await video.current.play(); }
        void frame();
      } catch { if (!cancelled) setFailed(true); }
    };
    void start();
    return () => { cancelled = true; clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()); client?.destroy(); };
  }, [facing, active]);
  return <div className="handshake-camera">
    <video ref={video} autoPlay playsInline muted />
    {failed && <p role="alert">{HANDSHAKE_COPY.cameraError}</p>}
  </div>;
}
