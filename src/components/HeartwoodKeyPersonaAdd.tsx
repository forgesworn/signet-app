import { useState } from 'react';
import { QRScanner } from './QRScanner';
import { useScannerSettings } from './ScannerSettingsContext';
import { parseHeartwoodKeyUri } from '../lib/heartwood-key-persona';

interface Props {
  /** Binds this phone on the identity, checks it signs, saves the persona. Throws with user-facing copy. */
  onAdd: (bunkerUri: string, displayName: string) => Promise<void>;
  onClose: () => void;
}

const NOT_A_KEY_CODE = "That code isn't a bunker:// connection with a pairing secret. In Sapwood, add an app, choose the identity under \"It will sign as\", and scan the code it shows.";

/**
 * "Add a key from my Heartwood": a persona whose key is a separate identity
 * on the paired Heartwood (another slot, e.g. an nsec imported there).
 */
export function HeartwoodKeyPersonaAdd({ onAdd, onClose }: Props) {
  const scannerSettings = useScannerSettings();
  const [scanning, setScanning] = useState(scannerSettings.autoStart);
  const [uri, setUri] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const parsed = parseHeartwoodKeyUri(uri);

  const handleScan = (data: string) => {
    setScanning(false);
    if (!parseHeartwoodKeyUri(data)) { setError(NOT_A_KEY_CODE); return; }
    setUri(data.trim());
    setError('');
  };

  const handleAdd = async () => {
    if (!parsed) { setError(NOT_A_KEY_CODE); return; }
    if (!name.trim()) { setError('Give this persona a name.'); return; }
    setBusy(true);
    setError('');
    try {
      await onAdd(uri.trim(), name.trim());
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'var(--scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-label="Add a key from my Heartwood" className="card section" style={{ maxWidth: 480, width: '100%', maxHeight: '100%', minHeight: 0, marginBottom: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ minHeight: 0, overflowY: 'auto' }}>
          <h3 style={{ marginTop: 0, marginBottom: 8 }}>Add a key from my Heartwood</h3>
          {done ? (
            <>
              <p style={{ fontSize: '0.9rem', marginBottom: 12 }}>
                <strong>{name.trim()}</strong> is added. Your Heartwood signs for it; its key isn't on this phone.
              </p>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
                Your recovery words don't bring this key back. Keep its own backup safe.
              </p>
              <button className="btn btn-primary" onClick={onClose} style={{ width: '100%' }}>Done</button>
            </>
          ) : (
            <>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
                For a key kept as its own identity on your Heartwood, such as an nsec you imported there. In Sapwood, add an app, choose that identity under "It will sign as", then scan the code here.
              </p>
              {error && (
                <div role="alert" style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.85rem' }}>
                  {error}
                </div>
              )}
              {scanning && !busy && !parsed ? (
                <div style={{ marginBottom: 12 }}>
                  <QRScanner active compact onScan={handleScan} />
                </div>
              ) : !parsed && (
                <button className="btn btn-secondary" onClick={() => { setError(''); setScanning(true); }} style={{ width: '100%', marginBottom: 12 }} disabled={busy}>
                  {error ? 'Scan again' : 'Scan QR code'}
                </button>
              )}
              <label htmlFor="heartwood-key-uri" style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 6 }}>
                {parsed ? 'Connection' : 'Or paste it'}
              </label>
              <textarea
                id="heartwood-key-uri"
                className="input"
                rows={3}
                placeholder="bunker://..."
                value={uri}
                onChange={e => { setUri(e.target.value); setError(''); }}
                disabled={busy}
                style={{ resize: 'none', fontFamily: 'var(--font-mono)', fontSize: '0.8rem', marginBottom: 12 }}
                autoComplete="off"
                spellCheck={false}
              />
              <label htmlFor="heartwood-key-name" style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 6 }}>
                Persona name
              </label>
              <input
                id="heartwood-key-name"
                className="input"
                placeholder="Name or handle"
                value={name}
                onChange={e => { setName(e.target.value); setError(''); }}
                maxLength={100}
                disabled={busy}
                style={{ marginBottom: 12 }}
              />
              {busy && (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: 12, textAlign: 'center' }}>
                  Waiting for your Heartwood. If it asks, press its button to approve.
                </p>
              )}
              <button className="btn btn-primary" onClick={handleAdd} disabled={busy || !parsed || !name.trim()} style={{ width: '100%', marginBottom: 8 }}>
                {busy ? 'Connecting…' : 'Add persona'}
              </button>
              <button className="btn btn-ghost" onClick={onClose} disabled={busy} style={{ width: '100%' }}>Cancel</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
