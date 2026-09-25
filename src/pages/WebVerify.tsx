import { useState, useRef, useCallback } from 'react';
import type { ContactInvite } from '@forgesworn/signet-contacts';
import { QRScanner } from '../components/QRScanner';
import { useCamera } from '../hooks/useCamera';
import type { VerifyRequest } from '../lib/presentation';
import { routeQR } from '../lib/qr-router';
import { CONTACTS_GRANT_WRONG_SCANNER_COPY } from '../lib/contacts-v2-copy';
import type { AuthRequest, LoginRequest } from '../lib/qr-router';

interface Props {
  onVerifyRequest: (request: VerifyRequest) => void;
  onAuthRequest: (request: AuthRequest) => void;
  onLoginRequest: (request: LoginRequest) => void;
  onNostrConnect: (uri: string) => boolean;
  onBack: () => void;
  onContactInvite?: (invite: ContactInvite) => void;
}

async function decodeQRFromImage(file: File): Promise<string> {
  const { Html5Qrcode } = await import('html5-qrcode');
  const html5QrCode = new Html5Qrcode('qr-reader-hidden');
  const result = await html5QrCode.scanFileV2(file, false);
  return result.decodedText;
}

export function WebVerify({ onVerifyRequest, onAuthRequest, onLoginRequest, onNostrConnect, onBack, onContactInvite }: Props) {
  const [scannerActive, setScannerActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { hasPermission, error: cameraError, requestPermission } = useCamera();

  const handleQRData = useCallback((data: string) => {
    setScannerActive(false);
    const action = routeQR(data);
    switch (action.type) {
      case 'verify':
        setError(null);
        onVerifyRequest(action.request);
        break;
      case 'auth':
        setError(null);
        onAuthRequest(action.request);
        break;
      case 'login':
        setError(null);
        onLoginRequest(action.request);
        break;
      case 'contact-invite':
        if (onContactInvite) { setError(null); onContactInvite(action.invite); }
        else setError('Open this invite from your own contacts.');
        break;
      case 'contact':
        setError("This is a Nostr contact key, not a website verification. Use \"Add Family Member\" instead.");
        break;
      case 'nostr-connect':
        if (onNostrConnect(action.uri)) setError(null);
        else setError('Invalid NostrConnect request.');
        break;
      case 'heartwood-operator-import':
        setError('This is a Heartwood operator link — paste it under Settings → Advanced → Heartwood operator key.');
        break;
      // Pre-merge minor: both pairing carriers were MISSING from this switch,
      // and there was no `default` — so a pairing code scanned here read as a
      // successful scan that did nothing at all. Approval belongs on the home
      // screen's scanner, which has the identity and the directory roster
      // behind it; say which screen rather than "not recognised", which is
      // false.
      case 'contacts-pair-v2':
        setError(CONTACTS_GRANT_WRONG_SCANNER_COPY);
        break;
      case 'companion-pair':
        setError(CONTACTS_GRANT_WRONG_SCANNER_COPY);
        break;
      case 'unknown':
        setError("This QR code isn't recognised by Signet.");
        break;
      default:
        // Exhaustiveness: a NEW `QRAction` kind added later lands here rather
        // than silently doing nothing, which is what the missing pairing
        // cases did.
        setError("This QR code isn't recognised by Signet.");
        break;
    }
  }, [onVerifyRequest, onAuthRequest, onLoginRequest, onNostrConnect, onContactInvite]);

  const handleScanCamera = useCallback(async () => {
    setError(null);
    if (hasPermission === null || hasPermission === false) {
      await requestPermission();
    }
    setScannerActive(true);
  }, [hasPermission, requestPermission]);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input so the same file can be re-selected if needed
    e.target.value = '';
    setError(null);
    setDecoding(true);
    try {
      const data = await decodeQRFromImage(file);
      handleQRData(data);
    } catch {
      setError("Couldn't read a QR code from that image. Try a clearer photo.");
    } finally {
      setDecoding(false);
    }
  }, [handleQRData]);

  const handleChoosePhoto = useCallback(() => {
    setError(null);
    setScannerActive(false);
    fileInputRef.current?.click();
  }, []);

  const handleCancelScan = useCallback(() => {
    setScannerActive(false);
    setError(null);
  }, []);

  const handlePasteSubmit = useCallback(() => {
    const trimmed = pasteValue.trim();
    if (trimmed) handleQRData(trimmed);
  }, [handleQRData, pasteValue]);

  const pastePanel = (
    <div className="section" style={{ marginTop: 8 }}>
      <label
        htmlFor="web-verify-paste"
        style={{
          display: 'block',
          fontSize: '0.8rem',
          fontWeight: 700,
          color: 'var(--text-muted)',
          marginBottom: 6,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        Paste QR link
      </label>
      <textarea
        id="web-verify-paste"
        className="input"
        rows={3}
        placeholder="nostrconnect://... or https://mysignet.app/?nostrconnect=..."
        value={pasteValue}
        onChange={e => setPasteValue(e.target.value)}
        style={{ resize: 'none', fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}
        data-testid="paste-link-input"
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          className="btn btn-primary"
          onClick={handlePasteSubmit}
          disabled={!pasteValue.trim()}
          style={{ flex: 1 }}
        >
          Submit
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => { setPasteValue(''); setError(null); }}
          disabled={!pasteValue}
          style={{ flex: 1 }}
        >
          Clear
        </button>
      </div>
    </div>
  );

  return (
    <div className="fade-in" role="main">
      {/* Hidden div required by html5-qrcode for file scanning */}
      <div id="qr-reader-hidden" style={{ display: 'none' }} />

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFileChange}
        aria-label="Choose image containing QR code"
      />

      {!scannerActive ? (
        <>
          <div className="section" style={{ marginBottom: 8 }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 24 }}>
              Point your camera at a Signet QR — it'll take you to the right place.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <button
                className="btn btn-primary"
                onClick={handleScanCamera}
                disabled={decoding}
              >
                Scan QR code
              </button>
              <button
                className="btn btn-secondary"
                onClick={handleChoosePhoto}
                disabled={decoding}
              >
                {decoding ? 'Reading image…' : 'Choose from photos'}
              </button>
            </div>
          </div>

          {pastePanel}

          {cameraError && (
            <div
              className="card section"
              style={{
                background: 'var(--warning-light)',
                borderColor: 'var(--warning)',
              }}
            >
              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
                {cameraError}
              </p>
            </div>
          )}

          {error && (
            <div
              className="card section"
              style={{
                background: 'var(--danger-light)',
                borderColor: 'var(--danger)',
              }}
            >
              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
                {error}
              </p>
            </div>
          )}

          <div
            className="card section"
            style={{ border: '1px dashed var(--border)', background: 'none' }}
          >
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: 0 }}>
              Nothing is shared until you approve. You'll see exactly what the site is asking for on the next screen.
            </p>
          </div>

          <div className="section">
            <button className="btn btn-ghost" onClick={onBack}>
              Back
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="section" style={{ marginBottom: 8 }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
              Point your camera at the QR code on the website.
            </p>
          </div>

          <div className="section">
            <QRScanner onScan={handleQRData} active={scannerActive} />
          </div>

          {pastePanel}

          {error && (
            <div
              className="card section"
              style={{
                background: 'var(--danger-light)',
                borderColor: 'var(--danger)',
              }}
            >
              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
                {error}
              </p>
            </div>
          )}

          <div className="section">
            <button className="btn btn-ghost" onClick={handleCancelScan}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
