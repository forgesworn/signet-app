import { useState, useEffect, useRef } from 'react';
import { authenticateBiometric, authenticatePIN, getAuthMethod } from '../lib/auth';
import { Z } from '../lib/z-index';
import { BrandMark } from '../components/BrandMark';
import {
  type PurposeContext,
  type PurposeIcon,
  type PurposeAccent,
  DEFAULT_PURPOSE_CONTEXT,
  resolvePurpose,
} from '../lib/auth-purposes';

interface Props {
  onUnlock: (encryptionKey: string) => void;
  onCancel?: () => void;
  /**
   * Optional purpose context. When supplied, overrides the default
   * "Unlock Signet" header with purpose-specific copy + icon + accent.
   * When omitted, behaves identically to pre-purpose-system AuthScreen.
   */
  purposeContext?: PurposeContext;
}

/**
 * Render a description string with `**bold**` tokens emphasised.
 * No markdown library — kept tiny and predictable. Safe with arbitrary
 * input because we only split + render text nodes; no HTML interpolation.
 */
function renderEmphasised(text: string): Array<string | { bold: string }> {
  const parts: Array<string | { bold: string }> = [];
  const regex = /\*\*([^*]+)\*\*/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push(text.slice(lastIdx, match.index));
    parts.push({ bold: match[1] });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}

function PurposeIconSvg({ icon, accentColor }: { icon: PurposeIcon; accentColor: string }) {
  // Compact icon set — kept inline to avoid an icon-library dep. All viewBox 0 0 24 24.
  const stroke = accentColor;
  switch (icon) {
    case 'lock':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" style={{ width: 32, height: 32 }}>
          <rect x="5" y="11" width="14" height="9" rx="2" stroke={stroke} strokeWidth="2" />
          <path d="M8 11V8a4 4 0 1 1 8 0v3" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'shield':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" style={{ width: 32, height: 32 }}>
          <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" stroke={stroke} strokeWidth="2" strokeLinejoin="round" />
        </svg>
      );
    case 'shield-warn':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" style={{ width: 32, height: 32 }}>
          <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" stroke={stroke} strokeWidth="2" strokeLinejoin="round" />
          <path d="M12 8v5" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
          <circle cx="12" cy="16" r="1" fill={stroke} />
        </svg>
      );
    case 'key-plus':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" style={{ width: 32, height: 32 }}>
          <circle cx="8" cy="12" r="4" stroke={stroke} strokeWidth="2" />
          <path d="M12 12h8M16 8v8" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'trash':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" style={{ width: 32, height: 32 }}>
          <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'scroll':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" style={{ width: 32, height: 32 }}>
          <path d="M6 4h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 1-2zM9 9h6M9 13h6M9 17h4" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'people':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" style={{ width: 32, height: 32 }}>
          <circle cx="9" cy="9" r="3" stroke={stroke} strokeWidth="2" />
          <circle cx="17" cy="10" r="2.5" stroke={stroke} strokeWidth="2" />
          <path d="M3 19c0-3 3-5 6-5s6 2 6 5M14 19c0-2 2.5-4 5-4s2 2 2 4" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'door':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" style={{ width: 32, height: 32 }}>
          <path d="M6 3h9a1 1 0 0 1 1 1v17H6V3z" stroke={stroke} strokeWidth="2" strokeLinejoin="round" />
          <circle cx="13" cy="12" r="0.8" fill={stroke} />
          <path d="M16 12h6M19 9l3 3-3 3" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}

function accentToColor(accent: PurposeAccent): string {
  switch (accent) {
    case 'neutral': return 'var(--accent)';       // matches the app's brand navy accent
    case 'soft': return 'var(--accent)';
    case 'warning': return 'var(--warning)';
    case 'destructive': return 'var(--danger)';
  }
}

function accentToBorderTreatment(accent: PurposeAccent): string {
  switch (accent) {
    case 'neutral':
    case 'soft':
      return 'transparent';
    case 'warning':
      return 'var(--warning)';              // visible halo, not alarming
    case 'destructive':
      return 'var(--danger)';               // full alarm
  }
}

export function AuthScreen({ onUnlock, onCancel, purposeContext }: Props) {
  const method = getAuthMethod();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPinFallback, setShowPinFallback] = useState(method === 'pin');
  const [attempts, setAttempts] = useState(() => {
    // Clamp to non-negative so a devtools write of `-999999` can't bypass
    // the 5-strike lockout. Real protection is AES-256-GCM decryption; this
    // counter is a UX gate, but still harden against trivial bypass.
    try {
      const raw = parseInt(localStorage.getItem('signet-pin-attempts') || '0', 10);
      return Number.isFinite(raw) && raw >= 0 ? raw : 0;
    } catch { return 0; }
  });
  const [lockedUntil, setLockedUntil] = useState<number | null>(() => {
    try {
      const v = localStorage.getItem('signet-pin-locked');
      if (!v) return null;
      const parsed = parseInt(v, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    } catch { return null; }
  });

  // Persist attempts and lockedUntil to localStorage
  useEffect(() => {
    try { localStorage.setItem('signet-pin-attempts', String(attempts)); } catch { /* ignore */ }
  }, [attempts]);

  useEffect(() => {
    try {
      if (lockedUntil !== null) {
        localStorage.setItem('signet-pin-locked', String(lockedUntil));
      } else {
        localStorage.removeItem('signet-pin-locked');
      }
    } catch { /* ignore */ }
  }, [lockedUntil]);

  // Auto-trigger biometric on mount
  useEffect(() => {
    if (method === 'biometric') {
      void triggerBiometric();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function triggerBiometric() {
    setLoading(true);
    setError('');
    try {
      const key = await authenticateBiometric();
      if (key) {
        onUnlock(key);
      } else {
        setError('Biometric authentication failed. Try again or use your PIN.');
      }
    } catch {
      setError('Biometric authentication failed. Try again or use your PIN.');
    } finally {
      setLoading(false);
    }
  }

  // Ref-based re-entrancy guard for submitPIN. `disabled={loading}` on the
  // keypad blocks new digit clicks, but on mobile the touchstart→click chain
  // can fire BEFORE React commits the loading=true state — leaving a
  // microsecond window where a fast double-tap or stray touchend can land a
  // second submit on the same in-flight PBKDF2. We saw a "first attempt
  // doesn't unlock, second succeeds" report (2026-05-16) that fits a
  // double-submit shape (first call's onUnlock racing with the second
  // call's state setters). Holding `submittingRef` across the await
  // means only one submitPIN runs at a time regardless of click timing.
  const submittingRef = useRef(false);

  function handlePinDigit(digit: string) {
    if (loading) return;
    if (lockedUntil !== null && lockedUntil > Date.now()) return;
    if (pin.length >= 6) return;
    const next = pin + digit;
    setPin(next);
    if (next.length === 6) {
      void submitPIN(next);
    }
  }

  function handlePinDelete() {
    if (loading) return;
    setPin(p => p.slice(0, -1));
    setError('');
  }

  async function submitPIN(value: string) {
    // Re-entrancy guard — see submittingRef comment above.
    if (submittingRef.current) return;
    // Check lockout before attempting authentication
    if (lockedUntil !== null && lockedUntil > Date.now()) {
      const secondsLeft = Math.ceil((lockedUntil - Date.now()) / 1000);
      setError(`Locked for ${secondsLeft} seconds. Please wait.`);
      setPin('');
      return;
    }

    submittingRef.current = true;
    setLoading(true);
    setError('');
    try {
      const key = await authenticatePIN(value);
      if (key) {
        setAttempts(0);
        setLockedUntil(null);
        onUnlock(key);
      } else {
        const newAttempts = attempts + 1;
        setAttempts(newAttempts);
        if (newAttempts >= 15) {
          setLockedUntil(Date.now() + 60 * 60 * 1000); // 1 hour
          setError('Too many failed attempts. Locked for 1 hour.');
        } else if (newAttempts >= 10) {
          setLockedUntil(Date.now() + 5 * 60 * 1000); // 5 minutes
          setError('Too many failed attempts. Locked for 5 minutes.');
        } else if (newAttempts >= 5) {
          setLockedUntil(Date.now() + 30 * 1000); // 30 seconds
          setError('Too many failed attempts. Locked for 30 seconds.');
        } else {
          setError('Incorrect PIN. Please try again.');
        }
        setPin('');
      }
    } catch {
      setError('Something went wrong. Please try again.');
      setPin('');
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  }

  const keypadRows = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['', '0', 'del'],
  ];

  // Resolve purpose context — defaults to unlock-app for callers that haven't migrated.
  const resolved = resolvePurpose(purposeContext ?? DEFAULT_PURPOSE_CONTEXT);
  const accentColor = accentToColor(resolved.accent);
  const borderColor = accentToBorderTreatment(resolved.accent);
  const isPurposeOverride = (purposeContext?.purpose ?? 'unlock-app') !== 'unlock-app';

  // Tier 0 (default unlock-app) keeps the original Signet mark + "MySignet" branding.
  // Tier 1/2 swap to a purpose-specific icon and drop the branding so the
  // user's eye lands on the action being authorised, not the app identity.
  const iconBlock = isPurposeOverride ? (
    <div style={{
      width: 64, height: 64, borderRadius: 12, marginBottom: 16,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `color-mix(in srgb, ${accentColor} 10%, transparent)`,     // 10% accent tint
      border: `1px solid color-mix(in srgb, ${accentColor} 25%, transparent)`, // 25% accent border
    }}>
      <PurposeIconSvg icon={resolved.icon} accentColor={accentColor} />
    </div>
  ) : (
    <div style={{ marginBottom: 16 }}>
      <BrandMark variant="stacked" size={72} />
    </div>
  );

  // PIN-keypad mode override: when user is in PIN entry, use the more direct
  // "Enter your PIN" header for unlock-app (matching pre-purpose-system copy).
  // For purpose overrides, keep the purpose's title — it's the more useful info.
  const titleText = isPurposeOverride
    ? resolved.title
    : (showPinFallback ? 'Enter your PIN' : 'Unlock Signet');
  const descText = isPurposeOverride
    ? resolved.description
    : (showPinFallback ? 'Enter your 6-digit PIN to continue' : 'Use your fingerprint or face to unlock');

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg-primary)',
      zIndex: Z.auth,
      padding: '24px',
      // Halo around the whole overlay for warning/destructive purposes — high-flinch signal.
      boxShadow: borderColor !== 'transparent' ? `inset 0 0 0 4px ${borderColor}` : 'none',
    }}>
      <div style={{ textAlign: 'center', marginBottom: 40, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {iconBlock}
        <h1 style={{ marginBottom: 8 }}>
          {titleText}
        </h1>
        <p style={{ color: 'var(--text-secondary)', maxWidth: 360, lineHeight: 1.4 }}>
          {renderEmphasised(descText).map((part, i) =>
            typeof part === 'string'
              ? <span key={i}>{part}</span>
              : <strong key={i} style={{ color: 'var(--text-primary)' }}>{part.bold}</strong>,
          )}
        </p>
      </div>

      {/* Biometric mode */}
      {!showPinFallback && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, width: '100%', maxWidth: 320 }}>
          {error && (
            <div style={{
              padding: '10px 16px',
              background: 'var(--danger-light)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--danger)',
              fontSize: '0.9rem',
              textAlign: 'center',
              width: '100%',
            }}>
              {error}
            </div>
          )}
          <button
            className="btn btn-primary"
            style={{ width: '100%', fontSize: '1rem', padding: '14px' }}
            onClick={() => void triggerBiometric()}
            disabled={loading}
          >
            {loading ? 'Waiting for biometric...' : 'Unlock with biometrics'}
          </button>
          <button
            className="btn btn-ghost"
            style={{ width: '100%' }}
            onClick={() => { setShowPinFallback(true); setError(''); }}
          >
            Use PIN instead
          </button>
        </div>
      )}

      {/* PIN keypad mode */}
      {showPinFallback && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, width: '100%', maxWidth: 320 }}>
          {/* PIN dots */}
          <div style={{ display: 'flex', gap: 16 }}>
            {Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: i < pin.length ? 'var(--accent)' : 'var(--border)',
                  transition: 'background 0.06s',
                }}
              />
            ))}
          </div>

          {/* Reserved slot for verifying/error message — fixed minHeight so
           the keypad doesn't shift when either indicator appears. The
           "screen kinda moves a little bit" reported on 2026-05-16 was the
           keypad jumping ~40px down as the verifying indicator inserted on
           the 6th-digit tap; reserving space here keeps the keypad anchored
           regardless of which state is showing. Empty when neither is set. */}
          <div style={{
            width: '100%',
            minHeight: 40,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            {loading && !error && (
              <div
                aria-live="polite"
                style={{
                  padding: '10px 16px',
                  background: 'var(--accent-light)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--accent-text)',
                  fontSize: '0.9rem',
                  textAlign: 'center',
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    border: '2px solid var(--accent)',
                    borderTopColor: 'transparent',
                    animation: 'authpin-spin 0.8s linear infinite',
                    display: 'inline-block',
                  }}
                />
                Verifying…
                <style>{`@keyframes authpin-spin { to { transform: rotate(360deg); } }`}</style>
              </div>
            )}
            {error && (
              <div style={{
                padding: '10px 16px',
                background: 'var(--danger-light)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--danger)',
                fontSize: '0.9rem',
                textAlign: 'center',
                width: '100%',
              }}>
                {error}
              </div>
            )}
          </div>

          {/* Keypad */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, width: '100%' }}>
            {keypadRows.map((row, ri) =>
              row.map((key, ki) => {
                if (key === '') {
                  return <div key={`${ri}-${ki}`} />;
                }
                if (key === 'del') {
                  return (
                    <button
                      key={`${ri}-${ki}`}
                      className="signet-pinpad-key"
                      onClick={handlePinDelete}
                      disabled={loading}
                      aria-label="Delete"
                      style={{
                        height: 64,
                        borderRadius: 'var(--radius)',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-secondary)',
                        color: 'var(--text-primary)',
                        fontSize: '1.25rem',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      ⌫
                    </button>
                  );
                }
                return (
                  <button
                    key={`${ri}-${ki}`}
                    className="signet-pinpad-key"
                    onClick={() => handlePinDigit(key)}
                    disabled={loading || pin.length >= 6}
                    style={{
                      height: 64,
                      borderRadius: 'var(--radius)',
                      border: '1px solid var(--border)',
                      background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)',
                      fontSize: '1.5rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {key}
                  </button>
                );
              })
            )}
          </div>

          {method === 'biometric' && (
            <button
              className="btn btn-ghost"
              style={{ width: '100%' }}
              onClick={() => { setShowPinFallback(false); setPin(''); setError(''); }}
            >
              Use biometrics instead
            </button>
          )}
        </div>
      )}

      {/* Cancel — only shown when used as an overlay prompt */}
      {onCancel && (
        <button
          className="btn btn-ghost"
          style={{ marginTop: 24, width: '100%', maxWidth: 320 }}
          onClick={onCancel}
        >
          Cancel
        </button>
      )}

      {/* No "Reset app" affordance on the unlock screen — by design.
       Reset is destructive (clears auth + wipes IndexedDB) and irreversible.
       Exposing it here means anyone holding a locked device can tap their
       way to "Erase everything" without ever proving they own the
       identity. Reset stays available via the in-app Delete Identity
       path, which is gated behind a fresh-auth unlock. Removed 2026-05-16
       after live testing flagged the unlock-screen exposure as too risky. */}
    </div>
  );
}
