import { useEffect, useState } from 'react';
import { QRCode } from '../components/QRCode';
import { PillToggle } from '../components/PillToggle';
import { SCANNER_IDLE_SECONDS_OPTIONS, DEFAULT_SCANNER_IDLE_SECONDS, DEFAULT_SCANNER_AUTO_START, scannerIdleLabel } from '../lib/scanner-settings';

interface Props {
  /** Bunker master switch (serve signing requests). */
  bunkerServerEnabled: boolean;
  onSetBunkerServerEnabled: (enabled: boolean) => void;
  /** Pairing URL for other devices; null when there is no key to serve or no valid relay. */
  bunkerUrl?: string | null;
  /** False in a dependant's context, which pairs through its own flow, so the URL block is hidden. Default true. */
  showPairingUrl?: boolean;
  /** False when this phone has no key the Bunker can serve right now, which is why `bunkerUrl` is null. Default true. */
  pairingKeyAvailable?: boolean;
  /** The key the Bunker serves is a real identity that isn't set up, so it is not handed out. */
  pairingKeyDormant?: boolean;
  /** Camera card: start the scanner when the user swipes to it. Default on. */
  scannerAutoStart?: boolean;
  onSetScannerAutoStart?: (enabled: boolean) => void;
  /** Camera card: switch the scanner off after this many idle seconds. */
  scannerIdleSeconds?: number;
  onSetScannerIdleSeconds?: (seconds: number) => void;
  /** Show the Bunker master switch and pairing URL. False on a paired-child install, which serves nothing and keeps only the camera card. Default true. */
  showBunker?: boolean;
  /** Scroll to and pulse a section on arrival ('bunker'). */
  focusSection?: string | null;
  onConsumeFocus?: () => void;
}

const noop = () => {};

/**
 * Bunker and scanner settings: how this phone serves signing requests and
 * how its camera behaves. Split out of Security & Backup so the lock and
 * recovery controls stay a short page.
 */
export function SigningSettings({ bunkerServerEnabled, onSetBunkerServerEnabled, bunkerUrl, showPairingUrl = true, pairingKeyAvailable = true, pairingKeyDormant = false, scannerAutoStart = DEFAULT_SCANNER_AUTO_START, onSetScannerAutoStart = noop, scannerIdleSeconds = DEFAULT_SCANNER_IDLE_SECONDS, onSetScannerIdleSeconds = noop, showBunker = true, focusSection, onConsumeFocus }: Props) {
  const [bunkerCopied, setBunkerCopied] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  // Scroll to + highlight a sub-section when an outer flow asks us to focus
  // it (e.g. dep-pairing "Open Bunker settings" → land on the master switch).
  useEffect(() => {
    if (!focusSection) return;
    const id = focusSection === 'bunker' ? 'security-section-bunker' : null;
    if (!id) {
      onConsumeFocus?.();
      return;
    }
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setHighlighted(focusSection);
      }
      onConsumeFocus?.();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusSection, onConsumeFocus]);

  useEffect(() => {
    if (!highlighted) return;
    const t = setTimeout(() => setHighlighted(null), 2200);
    return () => clearTimeout(t);
  }, [highlighted]);

  return (
    <div className="fade-in" role="main">
      {showBunker && (
      <div className="card section">
        <div
          id="security-section-bunker"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            paddingLeft: highlighted === 'bunker' ? 8 : 0,
            paddingRight: highlighted === 'bunker' ? 8 : 0,
            background: highlighted === 'bunker' ? 'var(--accent-light)' : 'transparent',
            transition: 'background 0.4s ease-out, padding 0.2s ease-out',
            scrollMarginTop: 80,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 0 }}>
              <div className="section-title" style={{ marginBottom: 0 }}>Bunker</div>
              <span
                style={{
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: bunkerServerEnabled ? 'var(--success-light)' : 'var(--bg-card-alt)',
                  color: bunkerServerEnabled ? 'var(--success)' : 'var(--text-secondary)',
                }}
                aria-label={bunkerServerEnabled ? 'Bunker is on' : 'Bunker is off'}
              >
                {bunkerServerEnabled ? 'On' : 'Off'}
              </span>
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 6, marginBottom: 0 }}>
              The master switch for serving signing requests. Turn it on so you can pair and serve:
            </p>
            <ul style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 6, marginBottom: 6, paddingLeft: 18, lineHeight: 1.5 }}>
              <li>pair a dependant's phone</li>
              <li>pair your desktop signet-app</li>
              <li>pair companion apps (any app using NIP-46)</li>
              <li>pair a third-party app that acts as a dependant</li>
            </ul>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 6, marginBottom: 0 }}>
              Once on, serving still isn't always-on — start a timed serve session from the Bunker
              tab to actually receive requests. Every request pops an approval prompt (allow once,
              allow always for that app, or deny). Off by default.
            </p>
          </div>
          <PillToggle
            enabled={bunkerServerEnabled}
            onToggle={onSetBunkerServerEnabled}
            onLabel="Turn the Bunker off"
            offLabel="Turn the Bunker on"
          />
        </div>
        {bunkerServerEnabled && showPairingUrl && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <div className="section-title" style={{ marginBottom: 4 }}>Bunker URL for pairing devices</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 6, marginBottom: 12 }}>
              Paste or scan this URL into another device (e.g. your desktop) to make this phone its signer.
            </p>
            {bunkerUrl ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <span style={{ flex: 1, fontSize: '0.8rem', fontFamily: 'var(--font-mono)', wordBreak: 'break-all', color: 'var(--text-primary)' }}>
                    {bunkerUrl}
                  </span>
                  <button
                    className="btn btn-ghost"
                    style={{ flexShrink: 0, width: 'auto', padding: '4px 12px' }}
                    onClick={() => {
                      navigator.clipboard?.writeText(bunkerUrl);
                      setBunkerCopied(true);
                      setTimeout(() => setBunkerCopied(false), 2000);
                      // Auto-clear clipboard after 60s, matching the other copy actions.
                      setTimeout(() => navigator.clipboard?.writeText(''), 60_000);
                    }}
                  >
                    {bunkerCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
                  <QRCode data={bunkerUrl} size={180} />
                </div>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, marginBottom: 0, textAlign: 'center' }}>
                  Each sign request still asks for your approval here.
                </p>
              </>
            ) : (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>
                {pairingKeyDormant
                  ? "No pairing URL right now: your primary key is your real identity, which isn't set up yet. Set it up, or switch your primary to your persona on its Advanced page."
                  : pairingKeyAvailable
                  ? 'Set a relay in Settings → Advanced first.'
                  : 'No pairing URL right now: this phone has no key the Bunker can serve. If you use a signer, check it is connected.'}
              </p>
            )}
          </div>
        )}
      </div>
      )}

      {/* Camera */}
      <div className="card section">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
          <div>
            <div className="section-title" style={{ marginBottom: 0 }}>Start the camera when I swipe to Scan</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 6, marginBottom: 0 }}>
              Off: the camera only opens when you tap. Nothing is recorded or sent either way.
            </p>
          </div>
          <PillToggle
            enabled={scannerAutoStart}
            onToggle={onSetScannerAutoStart}
            onLabel="Turn off camera auto-start"
            offLabel="Turn on camera auto-start"
          />
        </div>
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <div className="section-title" style={{ marginBottom: 0 }}>Turn the camera off after</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 6, marginBottom: 10 }}>
            &hellip;when no code is found and you haven&rsquo;t touched it.
          </p>
          <div role="radiogroup" aria-label="Turn the camera off after" style={{ display: 'flex', gap: 6 }}>
            {SCANNER_IDLE_SECONDS_OPTIONS.map(seconds => {
              const checked = seconds === scannerIdleSeconds;
              return (
                <label
                  key={seconds}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '8px 6px',
                    borderRadius: 8,
                    border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                    background: checked ? 'var(--accent-light)' : 'transparent',
                    cursor: 'pointer',
                    fontSize: '0.9rem',
                    position: 'relative',
                  }}
                >
                  <input
                    type="radio"
                    name="scanner-idle-seconds"
                    value={seconds}
                    checked={checked}
                    onChange={() => onSetScannerIdleSeconds(seconds)}
                    aria-label={scannerIdleLabel(seconds)}
                    style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
                  />
                  <span aria-hidden="true">{scannerIdleLabel(seconds)}</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
