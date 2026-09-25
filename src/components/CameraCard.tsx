import { useState, useCallback } from 'react';
import type { ResolvedIdentity } from '../lib/carousel-utils';
import { MiniIdBadge } from './MiniIdBadge';
import { QRScanner } from './QRScanner';

interface Props {
  resolved: ResolvedIdentity;
  onQRScanned: (data: string) => void;
}

export function CameraCard({ resolved, onQRScanned }: Props) {
  const [scannerActive, setScannerActive] = useState(false);
  const [pasteValue, setPasteValue] = useState('');

  const handleStartScan = useCallback(() => {
    setScannerActive(true);
  }, []);

  const handleScan = useCallback((data: string) => {
    setScannerActive(false);
    setPasteValue('');
    onQRScanned(data);
  }, [onQRScanned]);

  return (
    <div className="camera-view">
      <MiniIdBadge resolved={resolved} />

      {scannerActive ? (
        <div style={{ width: '100%', padding: 12, boxSizing: 'border-box' }}>
          <QRScanner onScan={handleScan} active={scannerActive} compact />
          <div style={{ marginTop: 10 }}>
            <textarea
              className="input"
              rows={3}
              placeholder="Paste QR link"
              aria-label="Paste QR link"
              value={pasteValue}
              onChange={e => setPasteValue(e.target.value)}
              data-testid="camera-card-paste-input"
              style={{
                resize: 'none',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8rem',
                background: 'rgba(255,255,255,0.92)',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const trimmed = pasteValue.trim();
                  if (trimmed) handleScan(trimmed);
                }}
                disabled={!pasteValue.trim()}
                style={{ flex: 1 }}
              >
                Submit
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => { setScannerActive(false); setPasteValue(''); }}
                style={{ flex: 1, color: '#fff' }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="cam-text">Scan QR Code</div>
          <div className="viewfinder" onClick={handleStartScan} style={{ cursor: 'pointer' }}>
            <div className="vf-corner tl" />
            <div className="vf-corner tr" />
            <div className="vf-corner bl" />
            <div className="vf-corner br" />
          </div>
          <div className="cam-sub">Sign in &middot; Verify &middot; Add contact</div>
        </>
      )}
    </div>
  );
}
