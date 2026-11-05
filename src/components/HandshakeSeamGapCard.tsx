import { useState } from 'react';
import { HANDSHAKE_COPY } from '../lib/contacts-v2-copy';
import { SEAM_GAP_DEFAULT_MM, SEAM_GAP_MAX_MM, validSeamGapMm } from '../lib/handshake-seam-gap';

/** The Jigsaw edge distance for this handset. Only a valid number (0 to 30 mm) is saved; "Use default" clears it. */
export function HandshakeSeamGapCard({ mm, onSet }: { mm?: number; onSet: (mm: number | undefined) => void }) {
  const [text, setText] = useState(mm === undefined ? '' : String(mm));
  return <div className="card section">
    <div className="section-title">{HANDSHAKE_COPY.settingsTitle}</div>
    <label className="field-label" htmlFor="handshake-seam-gap">{HANDSHAKE_COPY.seamGap}</label>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input id="handshake-seam-gap" className="input" type="number" inputMode="decimal" min={0} max={SEAM_GAP_MAX_MM} step={0.5}
        placeholder={SEAM_GAP_DEFAULT_MM.toFixed(1)} value={text} style={{ maxWidth: 120 }}
        onChange={e => {
          setText(e.target.value);
          const n = e.target.value.trim() === '' ? NaN : Number(e.target.value);
          if (validSeamGapMm(n)) onSet(n);
        }}
        // A value that was not saved is not left on screen as if it had been.
        onBlur={() => setText(mm === undefined ? '' : String(mm))} />
      <span>{HANDSHAKE_COPY.seamGapUnit}</span>
      <button type="button" className="btn btn-secondary btn-sm" disabled={mm === undefined && text === ''}
        onClick={() => { setText(''); onSet(undefined); }}>{HANDSHAKE_COPY.useDefault}</button>
    </div>
    <p className="field-hint">{HANDSHAKE_COPY.seamGapHint}</p>
  </div>;
}
