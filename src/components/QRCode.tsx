import { useEffect, useRef } from 'react';
import QRCodeLib from 'qrcode';

interface Props {
  data: string;
  size?: number;
  margin?: number;
}

export function QRCode({ data, size = 200, margin = 1 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    QRCodeLib.toCanvas(canvasRef.current, data, {
      width: size,
      margin,
      color: { dark: '#1A1A2E', light: '#FFFFFF' },
    });
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
