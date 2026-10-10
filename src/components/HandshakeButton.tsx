import { useEffect, useRef } from 'react';
import { JigsawIcon } from './JigsawIcon';
import { Icon } from './Icon';
import { useRadioStatus } from '../hooks/useRadioStatus';
import { HANDSHAKE_COPY } from '../lib/contacts-v2-copy';
export function HandshakeButton({ onStart }: { onStart(choose: boolean): void }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(null);
  const held = useRef(false);
  const origin = useRef<{ x: number; y: number }>(null);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => clear, []);
  const radio = useRadioStatus();
  const describe = radio && [radio.nfc !== 'none' && `NFC ${radio.nfc}.`, radio.bluetooth !== 'none' && `Bluetooth ${radio.bluetooth === 'denied' ? 'not allowed' : radio.bluetooth}.`]
    .filter(Boolean).join(' ');
  return <button type="button" className="btn btn-secondary handshake-button" aria-description={describe || undefined}
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
    {radio && (radio.nfc !== 'none' || radio.bluetooth !== 'none') && <span className="handshake-radios">
      {radio.nfc !== 'none' && <Icon name="nfc" size={16} className={`handshake-radio${radio.nfc === 'on' ? '' : ' is-off'}`} />}
      {radio.bluetooth !== 'none' && <Icon name="bluetooth" size={16} className={`handshake-radio${radio.bluetooth === 'on' ? '' : ' is-off'}`} />}
    </span>}
  </button>;
}
