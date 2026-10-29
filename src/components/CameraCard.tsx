import { useState, useCallback, useEffect } from 'react';
import type { ResolvedIdentity } from '../lib/carousel-utils';
import { MiniIdBadge } from './MiniIdBadge';
import { QRScanner } from './QRScanner';

/** How long the card must stay live before the camera starts. */
export const CAMERA_AUTOSTART_DELAY_MS = 200;

interface Props {
  resolved: ResolvedIdentity;
  /** May return (or resolve to) an error to show under the viewfinder. */
  onQRScanned: (data: string) => string | void | Promise<string | void>;
  /**
   * True only for the card the user is actually looking at: the current
   * screen, not mid-transition. The carousel also mounts the incoming
   * neighbour (inert) during a drag and remounts the current one on commit,
   * so the camera must never start from mount alone.
   */
  live?: boolean;
}

export function CameraCard({ resolved, onQRScanned, live = false }: Props) {
  const [scannerActive, setScannerActive] = useState(false);
  // Set after a successful scan so a still-live card does not restart itself.
  const [scanDone, setScanDone] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);

  // Auto-start ~200 ms after the card becomes live (debounced: a card that
  // stops being live first never starts). Not live: camera off at once, and
  // the next time the card goes live it re-arms.
  useEffect(() => {
    if (!live) {
      setScannerActive(false);
      setScanDone(false);
      setPasteOpen(false);
      return;
    }
    if (scanDone) return;
    const timer = setTimeout(() => {
      setScanError(null);
      setScannerActive(true);
    }, CAMERA_AUTOSTART_DELAY_MS);
    return () => clearTimeout(timer);
  }, [live, scanDone]);

  const handleStartScan = useCallback(() => {
    setScanError(null);
    setScanDone(false);
    setScannerActive(true);
  }, []);

  const handleScan = useCallback((data: string) => {
    setScannerActive(false);
    setScanDone(true);
    setPasteOpen(false);
    setPasteValue('');
    setScanError(null);
    Promise.resolve(onQRScanned(data)).then(
      (error) => { if (typeof error === 'string' && error) setScanError(error); },
      () => {},
    );
  }, [onQRScanned]);

  if (scannerActive) {
    return (
      <div className="camera-view camera-view--live">
        <div className="cam-live-scanner">
          <QRScanner onScan={handleScan} active={scannerActive} fill bottomInset={56} />
        </div>
        <div className="cam-live-badge">
          <MiniIdBadge resolved={resolved} />
        </div>
        {pasteOpen ? (
          <div className="cam-paste-panel">
            <textarea
              className="input cam-paste"
              rows={3}
              placeholder="Paste QR link"
              aria-label="Paste QR link"
              value={pasteValue}
              onChange={e => setPasteValue(e.target.value)}
              data-testid="camera-card-paste-input"
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
                onClick={() => { setPasteOpen(false); setPasteValue(''); }}
                style={{ flex: 1, color: '#fff' }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="cam-live-controls">
            <button className="cam-paste-toggle" onClick={() => setPasteOpen(true)}>
              Paste a link
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="camera-view">
      <MiniIdBadge resolved={resolved} />
      <div className="cam-text">Scan QR Code</div>
      <div className="viewfinder" onClick={handleStartScan} style={{ cursor: 'pointer' }}>
        <div className="vf-corner tl" />
        <div className="vf-corner tr" />
        <div className="vf-corner bl" />
        <div className="vf-corner br" />
      </div>
      <div className="cam-sub">Sign in &middot; Verify &middot; Add contact</div>
      {scanError && <div className="cam-error" role="alert" data-testid="camera-card-scan-error">{scanError}</div>}
      {(scanDone || scanError) && (
        <button className="btn btn-primary cam-scan-again" onClick={handleStartScan}>
          Scan again
        </button>
      )}
    </div>
  );
}
