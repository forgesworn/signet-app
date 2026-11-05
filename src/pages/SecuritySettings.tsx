import type { PurposeContext } from '../lib/auth-purposes';
import { useState, useEffect, useMemo } from 'react';
import type { SignetIdentity, SecurityTier } from '../types';
import { getAuthMethod, changePIN, enableBiometric, disableBiometric, isBiometricAvailable, hasPinFallback, biometricAcceptsDevicePin } from '../lib/auth';
import { securityMethodLabel } from '../lib/security-method-label';
import { BACKUP_WORDS_ON_SIGNER } from '../lib/local-key-only-copy';
import { toRecoveryWords } from '../lib/recovery-words';
import { RecoveryWordsGrid } from '../components/RecoveryWordsGrid';
import { Icon } from '../components/Icon';
import { PillToggle } from '../components/PillToggle';

const TIER_INFO: Record<SecurityTier, { label: string; description: string }> = {
  basic: { label: 'Basic', description: '1 word each — quick check' },
  standard: { label: 'Standard', description: '2 words each — approvals' },
  expert: { label: 'Expert', description: '3 words each — high security' },
};

interface Props {
  identity: SignetIdentity;
  securityTier: SecurityTier;
  onSetSecurityTier: (tier: SecurityTier) => void;
  onRequestAuth?: (ctx?: PurposeContext) => Promise<string | null>;
  onRequestFreshAuth?: (ctx?: PurposeContext) => Promise<string | null>;
  /** Whether identity names/avatars are blurred in the carousel until tapped (anti-shoulder-surf). Default-off; only explicit true enables blur. */
  blurIdentityNames: boolean;
  onSetBlurIdentityNames: (enabled: boolean) => void;
  /** Whether the NP-ceiling confirmation is active for Sign-in-with-Signet. */
  requireNpConfirmation: boolean;
  onSetRequireNpConfirmation: (enabled: boolean) => void;
  /** Whether sign-in flows default to persona when no consumer hint is sent. */
  preferPersonaForSignIns: boolean;
  onSetPreferPersonaForSignIns: (enabled: boolean) => void;
  /**
   * Pubkey of the persona the user pinned as their preferred sign-in default
   * Undefined → the built-in persona is used. Only shown/editable
   * when `preferPersonaForSignIns` is on.
   */
  preferredPersonaPubkey?: string;
  onSetPreferredPersonaPubkey: (pubkey: string | undefined) => void;
  onNavigateShamir: () => void;
  /**
   * True once the family has migrated to a Heartwood signer and this device
   * no longer holds the owner mnemonic. Both the "View my recovery words" button
   * and the Shamir split derive from that mnemonic, so they have nothing to
   * work with — say where the words live instead of offering affordances
   * that stall on "Unlocking..." forever (family-bunker §11.1.7). Defaults
   * false, so local-key installs are unchanged.
   */
  mnemonicOnSigner?: boolean;
  /**
   * One-shot section anchor — when set, the page scrolls the matching
   * sub-section into view on mount and pulses a brief highlight. Used by
   * the carousel settings rows ("PIN / Biometric", "Backup words") so the
   * user lands on that section rather than the page top. Honours 'lock' and
   * 'backup'; unknown values are no-ops. Consumed via onConsumeFocus to
   * avoid re-firing.
   */
  focusSection?: string | null;
  onConsumeFocus?: () => void;
}

/** Compact inline PIN keypad for the Security settings section */
function SecurityPinPad({ title, value, error, saving, onDigit, onDelete, onNext, onCancel }: {
  title: string;
  value: string;
  error: string;
  saving: boolean;
  onDigit: (digit: string) => void;
  onDelete: () => void;
  onNext?: () => void;
  onCancel: () => void;
}) {
  const rows = [['1','2','3'],['4','5','6'],['7','8','9'],['','0','del']];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <p style={{ fontSize: '0.9rem', fontWeight: 600, margin: 0 }}>{title}</p>

      {/* PIN dots */}
      <div style={{ display: 'flex', gap: 12 }}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} style={{
            width: 12, height: 12, borderRadius: '50%',
            background: i < value.length ? 'var(--accent)' : 'var(--border)',
            transition: 'background 0.15s',
          }} />
        ))}
      </div>

      {error && (
        <p style={{ fontSize: '0.8rem', color: 'var(--danger)', margin: 0, textAlign: 'center' }}>{error}</p>
      )}

      {/* Keypad */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, width: '100%', maxWidth: 240 }}>
        {rows.map((row, ri) => row.map((key, ki) => {
          if (key === '') return <div key={`${ri}-${ki}`} />;
          if (key === 'del') return (
            <button key={`${ri}-${ki}`} onClick={onDelete} disabled={saving}
              style={{ height: 48, borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '1rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              ⌫
            </button>
          );
          return (
            <button key={`${ri}-${ki}`} onClick={() => onDigit(key)} disabled={saving || value.length >= 6}
              style={{ height: 48, borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '1.25rem', fontWeight: 600, cursor: 'pointer' }}>
              {key}
            </button>
          );
        }))}
      </div>

      <div style={{ display: 'flex', gap: 8, width: '100%', maxWidth: 240 }}>
        {onNext && value.length === 6 && (
          <button className="btn btn-primary" onClick={onNext} disabled={saving} style={{ flex: 1 }}>
            Next
          </button>
        )}
        <button className="btn btn-ghost" onClick={onCancel} disabled={saving} style={{ flex: 1 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function SecuritySettings({ identity, securityTier, onSetSecurityTier, onRequestAuth, onRequestFreshAuth, blurIdentityNames, onSetBlurIdentityNames, requireNpConfirmation, onSetRequireNpConfirmation, preferPersonaForSignIns, onSetPreferPersonaForSignIns, preferredPersonaPubkey, onSetPreferredPersonaPubkey, onNavigateShamir, mnemonicOnSigner = false, focusSection, onConsumeFocus }: Props) {
  const [showBackup, setShowBackup] = useState(false);
  const [copied, setCopied] = useState(false);
  // Pulse-highlight target for the focused section (e.g. 'bunker'). Cleared
  // after the animation so re-renders don't re-flash.
  const [highlighted, setHighlighted] = useState<string | null>(null);

  // The stored secret is still bare BIP-39; recovery words are the typed
  // envelope we *show*. An nsec-imported identity has no mnemonic and no
  // backup, so it renders nothing rather than throwing.
  const recoveryWords = useMemo(() => {
    if (!showBackup || !identity.mnemonic) return '';
    try {
      return toRecoveryWords(identity.mnemonic);
    } catch {
      return '';
    }
  }, [showBackup, identity.mnemonic]);

  useEffect(() => {
    if (!showBackup) return;
    const timer = setTimeout(() => setShowBackup(false), 90000);
    return () => clearTimeout(timer);
  }, [showBackup]);

  // Scroll to + highlight a sub-section when an outer flow asks us to focus
  // it (the carousel's "PIN / Biometric" and "Backup words" rows). One-shot:
  // consume the request via onConsumeFocus so back-nav and other re-renders
  // don't re-trigger.
  useEffect(() => {
    if (!focusSection) return;
    const id = focusSection === 'lock' ? 'security-section-lock'
      : focusSection === 'backup' ? 'security-section-backup'
      : null;
    if (!id) {
      onConsumeFocus?.();
      return;
    }
    // rAF so the layout has flushed; smooth scroll keeps the move legible.
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

  // Clear the pulse after the CSS animation completes (~2s).
  useEffect(() => {
    if (!highlighted) return;
    const t = setTimeout(() => setHighlighted(null), 2200);
    return () => clearTimeout(t);
  }, [highlighted]);

  // Security / PIN management state
  const [authMethod, setAuthMethod] = useState<'biometric' | 'pin' | null>(() => {
    const m = getAuthMethod();
    return m === 'biometric' || m === 'pin' ? m : null;
  });
  const [biometricSupported, setBiometricSupported] = useState(false);
  // Whether the biometric key also opens with the phone's own PIN (native,
  // Android 11+, set up since that became possible). Re-read when the method changes.
  const [devicePin, setDevicePin] = useState(false);
  useEffect(() => {
    let live = true;
    if (authMethod !== 'biometric') { setDevicePin(false); return; }
    void biometricAcceptsDevicePin().then(v => { if (live) setDevicePin(v); });
    return () => { live = false; };
  }, [authMethod]);
  const [changePinStep, setChangePinStep] = useState<'idle' | 'current' | 'new' | 'confirm'>('idle');
  const [currentPinEntry, setCurrentPinEntry] = useState('');
  const [newPinEntry, setNewPinEntry] = useState('');
  const [confirmPinEntry, setConfirmPinEntry] = useState('');
  const [pinChangeError, setPinChangeError] = useState('');
  const [pinChangeSaving, setPinChangeSaving] = useState(false);
  const [biometricToggling, setBiometricToggling] = useState(false);
  const [biometricError, setBiometricError] = useState('');
  // Surfaces the "PRF unavailable, fall-back used" advisory after a
  // successful but weaker biometric setup. See SetupBiometricResult in
  // auth.ts.
  const [biometricNotice, setBiometricNotice] = useState('');
  // When switching from biometric → PIN, we need the user to set a new PIN
  const [disableBioStep, setDisableBioStep] = useState<'idle' | 'new-pin' | 'confirm-pin'>('idle');
  const [disableBioPin, setDisableBioPin] = useState('');
  const [disableBioConfirm, setDisableBioConfirm] = useState('');

  useEffect(() => {
    void isBiometricAvailable().then(setBiometricSupported);
  }, []);

  return (
    <div className="fade-in" role="main">
      {/* Lock — PIN & biometrics: the thing the menu row promises, so it comes first. */}
      <div className="card section" id="security-section-lock" style={{ scrollMarginTop: 80, outline: highlighted === 'lock' ? '2px solid var(--accent)' : 'none', outlineOffset: 2, transition: 'outline-color 0.4s ease-out' }}>
        <div className="section-title">Lock</div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
          Currently using: <strong>{securityMethodLabel(authMethod, devicePin)}</strong>
        </p>

        {/* Change PIN flow */}
        {changePinStep === 'idle' && disableBioStep === 'idle' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* A native biometric install holds no PIN to change. */}
            {(authMethod !== 'biometric' || hasPinFallback()) && (
              <button className="btn btn-secondary" onClick={() => {
                setChangePinStep('current');
                setCurrentPinEntry('');
                setNewPinEntry('');
                setConfirmPinEntry('');
                setPinChangeError('');
              }}>
                Change PIN
              </button>
            )}

            {/* Biometric toggle */}
            {authMethod === 'pin' && biometricSupported && (
              <button
                className="btn btn-secondary"
                disabled={biometricToggling}
                onClick={async () => {
                  setBiometricToggling(true);
                  setBiometricError('');
                  setBiometricNotice('');
                  try {
                    const auth = onRequestFreshAuth ?? onRequestAuth;
                    if (!auth) return;
                    const key = await auth({ purpose: 'change-biometric', enabled: true });
                    if (!key) return;
                    const result = await enableBiometric(key);
                    if (result.ok) {
                      setAuthMethod('biometric');
                      if (!result.prfSupported) {
                        setBiometricNotice("Your device's biometric doesn't support hardware-backed encryption (PRF). Your identity is still protected, but offline extraction of browser data could enable brute-force. For maximum security, keep PIN as your primary unlock.");
                      }
                    } else {
                      setBiometricError('Biometric setup failed. Your device may not support it.');
                    }
                  } catch {
                    setBiometricError('Biometric setup failed.');
                  } finally {
                    setBiometricToggling(false);
                  }
                }}
              >
                {biometricToggling ? 'Setting up...' : 'Enable biometrics'}
              </button>
            )}

            {authMethod === 'biometric' && (
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setDisableBioStep('new-pin');
                  setDisableBioPin('');
                  setDisableBioConfirm('');
                  setBiometricError('');
                }}
              >
                Switch to PIN only
              </button>
            )}

            {biometricError && (
              <p style={{ fontSize: '0.8rem', color: 'var(--danger)', marginTop: 4 }}>{biometricError}</p>
            )}
            {biometricNotice && (
              <div
                style={{
                  marginTop: 8,
                  padding: '10px 12px',
                  background: 'var(--warning-light)',
                  border: '1px solid var(--warning)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '0.8rem',
                  lineHeight: 1.45,
                  color: 'var(--text-primary)',
                }}
              >
                <strong><Icon name="alertTriangle" size={14} className="icon-inline" />Limited hardware support.</strong> {biometricNotice}
              </div>
            )}
          </div>
        ) : changePinStep !== 'idle' ? (
          /* Inline PIN change keypad */
          <SecurityPinPad
            title={
              changePinStep === 'current' ? 'Enter current PIN' :
              changePinStep === 'new' ? 'Enter new PIN' :
              'Confirm new PIN'
            }
            value={
              changePinStep === 'current' ? currentPinEntry :
              changePinStep === 'new' ? newPinEntry :
              confirmPinEntry
            }
            error={pinChangeError}
            saving={pinChangeSaving}
            onDigit={(d) => {
              setPinChangeError('');
              if (changePinStep === 'current') {
                if (currentPinEntry.length >= 6) return;
                const next = currentPinEntry + d;
                setCurrentPinEntry(next);
                if (next.length === 6) {
                  // Verify current PIN immediately by attempting change with same pin
                  // We'll verify it properly when we have the new pin
                }
              } else if (changePinStep === 'new') {
                if (newPinEntry.length >= 6) return;
                const next = newPinEntry + d;
                setNewPinEntry(next);
                if (next.length === 6) {
                  setChangePinStep('confirm');
                }
              } else {
                if (confirmPinEntry.length >= 6) return;
                const next = confirmPinEntry + d;
                setConfirmPinEntry(next);
                if (next.length === 6) {
                  // Submit the change
                  if (next !== newPinEntry) {
                    setPinChangeError("PINs don't match. Try again.");
                    setNewPinEntry('');
                    setConfirmPinEntry('');
                    setChangePinStep('new');
                    return;
                  }
                  setPinChangeSaving(true);
                  setPinChangeError('');
                  void changePIN(currentPinEntry, next).then(ok => {
                    if (ok) {
                      setChangePinStep('idle');
                      setAuthMethod('pin');
                    } else {
                      setPinChangeError('Current PIN is incorrect.');
                      setCurrentPinEntry('');
                      setNewPinEntry('');
                      setConfirmPinEntry('');
                      setChangePinStep('current');
                    }
                  }).catch(() => {
                    setPinChangeError('Something went wrong. Please try again.');
                  }).finally(() => {
                    setPinChangeSaving(false);
                  });
                }
              }
            }}
            onDelete={() => {
              setPinChangeError('');
              if (changePinStep === 'current') setCurrentPinEntry(p => p.slice(0, -1));
              else if (changePinStep === 'new') setNewPinEntry(p => p.slice(0, -1));
              else setConfirmPinEntry(p => p.slice(0, -1));
            }}
            onNext={changePinStep === 'current' && currentPinEntry.length === 6 ? () => setChangePinStep('new') : undefined}
            onCancel={() => {
              setChangePinStep('idle');
              setCurrentPinEntry('');
              setNewPinEntry('');
              setConfirmPinEntry('');
              setPinChangeError('');
            }}
          />
        ) : (
          /* Disable biometric — set new PIN flow */
          <SecurityPinPad
            title={disableBioStep === 'new-pin' ? 'Choose a new PIN' : 'Confirm new PIN'}
            value={disableBioStep === 'new-pin' ? disableBioPin : disableBioConfirm}
            error={biometricError}
            saving={biometricToggling}
            onDigit={(d) => {
              setBiometricError('');
              if (disableBioStep === 'new-pin') {
                if (disableBioPin.length >= 6) return;
                const next = disableBioPin + d;
                setDisableBioPin(next);
                if (next.length === 6) {
                  setDisableBioStep('confirm-pin');
                }
              } else {
                if (disableBioConfirm.length >= 6) return;
                const next = disableBioConfirm + d;
                setDisableBioConfirm(next);
                if (next.length === 6) {
                  if (next !== disableBioPin) {
                    setBiometricError("PINs don't match. Try again.");
                    setDisableBioPin('');
                    setDisableBioConfirm('');
                    setDisableBioStep('new-pin');
                    return;
                  }
                  setBiometricToggling(true);
                  setBiometricError('');
                  const doDisable = async () => {
                    const auth = onRequestFreshAuth ?? onRequestAuth;
                    if (!auth) return;
                    const key = await auth({ purpose: 'change-biometric', enabled: false });
                    if (!key) return;
                    await disableBiometric(key, next);
                    setAuthMethod('pin');
                    setDisableBioStep('idle');
                  };
                  void doDisable().catch(() => {
                    setBiometricError('Failed to switch. Please try again.');
                  }).finally(() => {
                    setBiometricToggling(false);
                  });
                }
              }
            }}
            onDelete={() => {
              setBiometricError('');
              if (disableBioStep === 'new-pin') setDisableBioPin(p => p.slice(0, -1));
              else setDisableBioConfirm(p => p.slice(0, -1));
            }}
            onCancel={() => {
              setDisableBioStep('idle');
              setDisableBioPin('');
              setDisableBioConfirm('');
              setBiometricError('');
            }}
          />
        )}
      </div>

      {/* Backup Words */}
      <div className="card section" id="security-section-backup" style={{ scrollMarginTop: 80, outline: highlighted === 'backup' ? '2px solid var(--accent)' : 'none', outlineOffset: 2, transition: 'outline-color 0.4s ease-out' }}>
        <div className="section-title">Backup Words</div>
        {/*
          Once the mnemonic lives on a Heartwood signer this device has
          nothing to reveal: the "only way to recover" line is false and the
          reveal button would sit on "Unlocking..." forever (family-bunker
          §11.1.7). Replace BOTH with the shared on-signer line.
        */}
        {mnemonicOnSigner ? (
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
            {BACKUP_WORDS_ON_SIGNER}
          </p>
        ) : (
        <>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
          19 words. Write them down in order. They restore your whole Signet — every persona and dependant — on a new phone or a family Heartwood.
        </p>
        {!showBackup ? (
          <button className="btn btn-secondary" onClick={async () => {
            const auth = onRequestFreshAuth ?? onRequestAuth;
            if (!auth) return;
            const key = await auth({ purpose: 'reveal-recovery-words' });
            if (!key) return;
            setShowBackup(true);
          }}>
            View my recovery words
          </button>
        ) : !identity.encrypted && recoveryWords ? (
          <div>
            {/*
              The shared grid, not a second copy of it. It splits the typed
              envelope into format header and key and says the opening repeats
              on every backup — the reason this card existed as a plain list
              was the reason an owner mistook a fresh key for a repeat.
            */}
            <RecoveryWordsGrid words={recoveryWords.split(' ')} bare />
            <button className="btn btn-ghost" onClick={() => {
              navigator.clipboard?.writeText(recoveryWords);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
              // Clear clipboard after 60 seconds
              setTimeout(() => navigator.clipboard?.writeText(''), 60_000);
            }}>
              {copied ? 'Copied!' : 'Copy to clipboard'}
            </button>
            <button className="btn btn-ghost" onClick={() => setShowBackup(false)}>
              Hide
            </button>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 8 }}>
              Words auto-hide after 90 seconds. Clipboard clears after 60 seconds.
            </p>
          </div>
        ) : (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Unlocking...</div>
        )}
        </>
        )}
      </div>

      {/* Shamir Backup — splits the mnemonic (ShamirBackup reads
          identity.mnemonic), so it's hidden under the same on-signer gate. */}
      {!mnemonicOnSigner && (
        <div className="card section">
          <div className="section-title">Shamir Backup</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            Split your backup between trusted people so no single person can access your account.
          </p>
          <button className="btn btn-secondary" onClick={onNavigateShamir}>
            Manage Shamir Backup
          </button>
        </div>
      )}

      {/* Sign-in Privacy */}
      <div className="card section">
        <div className="section-title" style={{ marginBottom: 12 }}>Sign-in privacy</div>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
          <div>
            <div className="section-title" style={{ marginBottom: 0 }}>Blur identity names</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 6, marginBottom: 0 }}>
              Hides names and avatars in the carousel until you tap to reveal them. Reduces over-the-shoulder
              visibility of which identities you hold. This is a convenience screen — not an access control.
            </p>
          </div>
          <PillToggle
            enabled={blurIdentityNames}
            onToggle={onSetBlurIdentityNames}
            onLabel="Turn off identity blur"
            offLabel="Turn on identity blur"
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 4, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <div>
            <div className="section-title" style={{ marginBottom: 0 }}>Confirm real-name sign-ins</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 6, marginBottom: 0 }}>
              When a site asks you to sign in, an extra tap is required before your real-name
              identity is used. Recommended — stops a slip from broadcasting your real name to
              a game, forum, or chat.
            </p>
          </div>
          <PillToggle
            enabled={requireNpConfirmation}
            onToggle={onSetRequireNpConfirmation}
            onLabel="Disable real-name sign-in confirmation"
            offLabel="Enable real-name sign-in confirmation"
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <div>
            <div className="section-title" style={{ marginBottom: 0 }}>Prefer persona for sign-ins</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 6, marginBottom: 0 }}>
              When a site doesn't specify which identity it wants, default to your persona.
              Your real-name option is still available in the picker if you choose it.
            </p>
          </div>
          <PillToggle
            enabled={preferPersonaForSignIns}
            onToggle={onSetPreferPersonaForSignIns}
            onLabel="Stop preferring persona"
            offLabel="Prefer persona"
          />
        </div>
        {preferPersonaForSignIns && (() => {
          // Persona-family options the user can pin as their sign-in default.
          // Built-in persona first (matches the resolver's fallback order),
          // then non-hidden extras.
          const personaOptions = [
            ...(identity.persona?.publicKey
              ? [{ pubkey: identity.persona.publicKey, label: identity.persona.displayName || 'Persona' }]
              : []),
            ...(identity.extraPersonas ?? [])
              .filter(ep => !ep.hidden)
              .map(ep => ({ pubkey: ep.publicKey, label: ep.displayName || 'Persona' })),
          ];
          if (personaOptions.length === 0) return null;
          // Reflect the resolver's choice: the pinned pubkey if it still
          // exists, otherwise the built-in persona (first option).
          const selectedPubkey = personaOptions.some(o => o.pubkey === preferredPersonaPubkey)
            ? preferredPersonaPubkey
            : personaOptions[0].pubkey;
          return (
            <div style={{ marginTop: 12, paddingLeft: 4 }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
                Which persona should be the default?
              </div>
              <div role="radiogroup" aria-label="Preferred persona for sign-ins" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {personaOptions.map(opt => {
                  const checked = opt.pubkey === selectedPubkey;
                  return (
                    <label
                      key={opt.pubkey}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                        background: checked ? 'var(--accent-light)' : 'transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="radio"
                        name="preferred-persona"
                        checked={checked}
                        onChange={() => onSetPreferredPersonaPubkey(opt.pubkey)}
                      />
                      <span style={{ fontSize: '0.9rem' }}>{opt.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Verification Security — how many spoken words Signet Me uses. */}
      <div className="card section">
        <div className="section-title">Verification Security</div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
          How many words each person says during Signet Me. More words = harder to guess.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(['basic', 'standard', 'expert'] as const).map(tier => (
            <button
              key={tier}
              className={`btn ${securityTier === tier ? 'btn-tile-selected' : 'btn-secondary'}`}
              onClick={() => onSetSecurityTier(tier)}
              style={{ padding: '10px 16px', textAlign: 'left', justifyContent: 'flex-start' }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{TIER_INFO[tier].label}</div>
                <div style={{ fontSize: '0.8rem', fontWeight: 400, opacity: 0.8 }}>{TIER_INFO[tier].description}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

    </div>
  );
}
