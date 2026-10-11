import { useEffect, useMemo, useState } from 'react';
import { QRCode } from './QRCode';
import { HANDSHAKE_FRAME_MS, handshakeFrames } from '../lib/handshake-optical';

export function HandshakeQR({ data, size = 280 }: { data: string; size?: number }) {
  const frames = useMemo(() => handshakeFrames(data, true), [data]);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
    if (frames.length === 1) return;
    const timer = setInterval(() => setIndex(i => (i + 1) % frames.length), HANDSHAKE_FRAME_MS);
    return () => clearInterval(timer);
  }, [frames]);
  return <QRCode data={frames[index % frames.length]} size={size} margin={4} />;
}
