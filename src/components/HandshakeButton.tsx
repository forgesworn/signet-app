import { useEffect, useRef } from 'react';
import { JigsawIcon } from './JigsawIcon';
import { HANDSHAKE_COPY } from '../lib/contacts-v2-copy';
export function HandshakeButton({ onStart }: { onStart(choose: boolean): void }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(null);
  const held = useRef(false);
  const origin = useRef<{ x: number; y: number }>(null);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => clear, []);
  return <button type="button" className="btn btn-secondary handshake-button"
    onPointerDown={e => {
      e.stopPropagation(); clear(); held.current = false; origin.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => { held.current = true; onStart(true); }, 550);
    }}
    onPointerMove={e => { if (origin.current && Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > 12) { clear(); held.current = true; } }}
    onPointerUp={clear} onPointerCancel={() => { clear(); held.current = true; }} onPointerLeave={clear}
    onTouchStart={e => e.stopPropagation()} onTouchEnd={e => e.stopPropagation()}
    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); clear(); if (!held.current) { held.current = true; onStart(true); } }}
    onKeyDown={e => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); onStart(true); } }}
    onClick={e => { e.stopPropagation(); clear(); if (!held.current) onStart(false); held.current = false; }}>
    <JigsawIcon />{HANDSHAKE_COPY.title}
  </button>;
}
