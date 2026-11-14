import { useEffect, useRef } from 'react';
import { drawCanvas, encode } from '@forgesworn/qr';

interface Props {
  data: string;
  size?: number;
  margin?: number;
}

export function QRCode({ data, size = 200, margin = 1 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    try {
      // Error correction M, as the previous encoder defaulted.
      drawCanvas(canvas, encode(data, { ecc: 'M' }), { width: size, margin, dark: '#1A1A2E', light: '#FFFFFF' });
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
    } catch {
      // Too long for a QR code or no 2D context: leave the canvas blank.
    }
  }, [data, size, margin]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        borderRadius: 'var(--radius)',
        background: '#FFFFFF',
        padding: 8,
        border: '1px solid var(--border)',
      }}
    />
  );
}
