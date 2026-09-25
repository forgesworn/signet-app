import { useMemo, useState } from 'react';
import type { DependantIdentity } from '../types';
import { generateMnemonic } from '../lib/signet';
import { createMigrationEvent } from 'signet-protocol';
import { publishEvent } from '../lib/relay-service';
import { toRecoveryWords } from '../lib/recovery-words';
import type { IndependenceGate } from '../lib/contacts-v2-independence-gate';
import { REMOVE_DEPENDANT_CONTACTS_LOADING_COPY } from '../lib/contacts-v2-copy';

interface Props {
  dependant: DependantIdentity;
  onComplete: (opts: {
    removeGuardian: boolean;
    rotateKeys: boolean;
    newMnemonic?: string;
  }) => Promise<void>;
  onBack: () => void;
  /**
   * Contact-transfer prerequisite (spec §7.8). Render-time gate for the
   * disabled Confirm button + inline reason — computed by the caller from
   * whatever it currently has loaded, which can be stale right after the
   * page mounts. Disables the final confirm.
   */
  contactsGate: IndependenceGate;
  /** Family contacts are still loading — the gate above may be stale/empty. */
  contactsLoading: boolean;
  /**
   * Fresh re-check run at the moment of confirm, since the ceremony is a
   * one-way door: `contactsGate` above is a render-time memo and can go
   * stale between page entry and the tap (another device adding a contact,
   * a slow initial load that raced the render). `handleConfirm` awaits this
   * and refuses — same as the render-time gate — if it comes back blocked.
   */
  onResolveGate: () => Promise<IndependenceGate>;
}

type Step = 1 | 2 | 3 | 4 | 5;

export function TransitionCeremony({ dependant, onComplete, onBack, contactsGate, contactsLoading, onResolveGate }: Props) {
  const [step, setStep] = useState<Step>(1);

  // Decision 1 — remove guardian authority
  const [removeGuardian, setRemoveGuardian] = useState<boolean | null>(null);

  // Decision 2 — key rotation (only if derived keys)
  const [rotateKeys, setRotateKeys] = useState<boolean | null>(null);
  const [newMnemonic, setNewMnemonic] = useState<string>('');
  const [mnemonicConfirmed, setMnemonicConfirmed] = useState(false);

  // Confirmation / publishing state
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState('');

  const hasDerivedKeys = Boolean(dependant.derivationPath);

  const recoveryWords = useMemo(() => {
    if (!newMnemonic) return '';
    try {
      return toRecoveryWords(newMnemonic);
    } catch {
      return '';
    }
  }, [newMnemonic]);

  function handleBeginCeremony() {
    setStep(2);
  }

  function handleGuardianDecision(remove: boolean) {
    setRemoveGuardian(remove);
    if (hasDerivedKeys) {
      setStep(3);
    } else {
      setStep(4);
    }
  }

  function handleKeyDecision(rotate: boolean) {
    if (rotate) {
      const mnemonic = generateMnemonic();
      setNewMnemonic(mnemonic);
      setMnemonicConfirmed(false);
    } else {
      setNewMnemonic('');
      setMnemonicConfirmed(false);
    }
    setRotateKeys(rotate);
  }

  function canProceedFromStep3(): boolean {
    if (rotateKeys === null) return false;
    if (rotateKeys && !mnemonicConfirmed) return false;
    return true;
  }

  async function handleConfirm() {
    if (confirming) return;
    setConfirming(true);
    setConfirmError('');

    try {
      // Re-check the contact-transfer gate against fresh data before doing
      // anything irreversible — `contactsGate` is a render-time memo and can
      // be stale by the time the user actually taps Confirm.
      const freshGate = await onResolveGate();
      if (!freshGate.allowed) {
        setConfirmError(freshGate.reason ?? '');
        return;
      }

      // If key rotation was chosen, publish a migration event signed by the old key
      if (rotateKeys && newMnemonic) {
        // Derive the new natural-person public key from the new mnemonic
        // The migration event is signed by the old (current) natural-person private key
        const { createSignetIdentity } = await import('signet-protocol');
        const newTree = createSignetIdentity(newMnemonic);
        const { bytesToHex } = await import('@noble/hashes/utils.js');
        const newNpPub = bytesToHex(newTree.naturalPerson.identity.publicKey);

        const migrationEvent = await createMigrationEvent(
          dependant.naturalPerson.privateKey,
          newNpPub,
        );

        // Best-effort publish — don't fail the ceremony if the relay is unreachable
        publishEvent(migrationEvent).catch(() => {});
      }

      await onComplete({
        removeGuardian: removeGuardian ?? false,
        rotateKeys: rotateKeys ?? false,
        newMnemonic: rotateKeys && newMnemonic ? newMnemonic : undefined,
      });

      setStep(5);
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setConfirming(false);
    }
  }

  const name = dependant.displayName || 'this person';

  // ── Step 1: Introduction ──────────────────────────────────────────────────

  if (step === 1) {
    return (
      <div className="fade-in" role="main">
        <div className="section">
          <h2 style={{ marginBottom: 12 }}>{name}'s independence ceremony</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: 1.6, marginBottom: 0 }}>
            This ceremony transitions {name} to an independent Signet identity. You'll make two
            decisions — both are reversible until confirmed.
          </p>
        </div>

        <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button className="btn btn-primary" onClick={handleBeginCeremony}>
            Begin ceremony
          </button>
          <button className="btn btn-ghost" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    );
  }

  // ── Step 2: Decision 1 — Guardian authority ───────────────────────────────

  if (step === 2) {
    return (
      <div className="fade-in" role="main">
        <div className="section">
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 4 }}>
            Decision 1 of {hasDerivedKeys ? '2' : '1'}
          </div>
          <h2 style={{ marginBottom: 12 }}>Guardian authority</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 0 }}>
            Removing guardian authority means {name}'s credentials will no longer carry your guardian
            tag. They'll need to visit a professional verifier to get new credentials without the
            guardian link.
          </p>
        </div>

        <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button
            className="btn btn-secondary"
            onClick={() => handleGuardianDecision(true)}
            style={{ padding: '16px', textAlign: 'left', justifyContent: 'flex-start' }}
          >
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Remove guardian authority</div>
              <div style={{ fontSize: '0.85rem', fontWeight: 400, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                A professional verifier will issue new credentials without your guardian tag
              </div>
            </div>
          </button>

          <button
            className="btn btn-secondary"
            onClick={() => handleGuardianDecision(false)}
            style={{ padding: '16px', textAlign: 'left', justifyContent: 'flex-start' }}
          >
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Keep guardian authority</div>
              <div style={{ fontSize: '0.85rem', fontWeight: 400, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                You remain {name}'s guardian. Choose this for dependants who need ongoing support.
              </div>
            </div>
          </button>
        </div>

        <div className="section">
          <button className="btn btn-ghost" onClick={() => setStep(1)}>
            Back
          </button>
        </div>
      </div>
    );
  }

  // ── Step 3: Decision 2 — Key derivation (only if derived keys exist) ──────

  if (step === 3) {
    const words = recoveryWords ? recoveryWords.split(' ') : [];

    return (
      <div className="fade-in" role="main">
        <div className="section">
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 4 }}>
            Decision 2 of 2
          </div>
          <h2 style={{ marginBottom: 12 }}>Key derivation</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 0 }}>
            Your mnemonic can derive {name}'s private keys. This means you can always recover their
            identity — but you could also sign as them.
          </p>
        </div>

        {rotateKeys === null && (
          <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <button
              className="btn btn-secondary"
              onClick={() => handleKeyDecision(true)}
              style={{ padding: '16px', textAlign: 'left', justifyContent: 'flex-start' }}
            >
              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Generate independent keys</div>
                <div style={{ fontSize: '0.85rem', fontWeight: 400, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {name} gets their own mnemonic. You can no longer derive their keys. This is a clean break.
                </div>
              </div>
            </button>

            <button
              className="btn btn-secondary"
              onClick={() => handleKeyDecision(false)}
              style={{ padding: '16px', textAlign: 'left', justifyContent: 'flex-start' }}
            >
              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Keep recovery access</div>
                <div style={{ fontSize: '0.85rem', fontWeight: 400, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  You retain the ability to recover {name}'s identity from your mnemonic. Choose this
                  if {name} wants a safety net.
                </div>
              </div>
            </button>
          </div>
        )}

        {rotateKeys === true && newMnemonic && (
          <div className="section">
            <div className="card" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 12, fontSize: '0.9rem' }}>
                {name}'s new recovery words
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
                {words.map((word, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', width: 20, textAlign: 'right' }}>
                      {i + 1}
                    </span>
                    <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{word}</span>
                  </div>
                ))}
              </div>

              <div
                style={{
                  background: 'var(--warning-light)',
                  border: '1px solid var(--warning)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  fontSize: '0.85rem',
                  color: 'var(--warning)',
                  lineHeight: 1.5,
                  marginBottom: 16,
                }}
              >
                Write these down. {name} will need them. Once confirmed, you will no longer be able
                to derive their keys.
              </div>

              <label
                style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', fontSize: '0.9rem' }}
              >
                <input
                  type="checkbox"
                  checked={mnemonicConfirmed}
                  onChange={e => setMnemonicConfirmed(e.target.checked)}
                  style={{ marginTop: 2, flexShrink: 0 }}
                />
                I have written down {name}'s 19 recovery words
              </label>
            </div>

            <button
              className="btn btn-ghost"
              onClick={() => { setRotateKeys(null); setNewMnemonic(''); setMnemonicConfirmed(false); }}
              style={{ marginBottom: 0 }}
            >
              Choose differently
            </button>
          </div>
        )}

        {rotateKeys === false && (
          <div className="section">
            <div
              className="card"
              style={{
                background: 'var(--accent-light)',
                border: '1px solid var(--accent)',
                fontSize: '0.9rem',
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
                marginBottom: 16,
              }}
            >
              Recovery access retained. You can still derive {name}'s keys from your mnemonic.
            </div>
            <button
              className="btn btn-ghost"
              onClick={() => { setRotateKeys(null); setMnemonicConfirmed(false); }}
            >
              Choose differently
            </button>
          </div>
        )}

        <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {canProceedFromStep3() && (
            <button className="btn btn-primary" onClick={() => setStep(4)}>
              Continue
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => { setRemoveGuardian(null); setRotateKeys(null); setNewMnemonic(''); setMnemonicConfirmed(false); setStep(2); }}>
            Back
          </button>
        </div>
      </div>
    );
  }

  // ── Step 4: Confirmation ──────────────────────────────────────────────────

  if (step === 4) {
    const effectiveRemoveGuardian = removeGuardian ?? false;
    const effectiveRotateKeys = rotateKeys ?? false;

    return (
      <div className="fade-in" role="main">
        <div className="section">
          <h2 style={{ marginBottom: 12 }}>Confirm ceremony</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: 0 }}>
            Review your decisions before confirming. This cannot be undone.
          </p>
        </div>

        <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card">
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 4 }}>
              Guardian authority
            </div>
            <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>
              {effectiveRemoveGuardian
                ? 'Remove guardian authority'
                : 'Keep guardian authority'}
            </div>
            {effectiveRemoveGuardian && (
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginTop: 6, marginBottom: 0, lineHeight: 1.5 }}>
                {name} will need to visit a professional verifier to get new credentials without your
                guardian tag.
              </p>
            )}
          </div>

          {hasDerivedKeys && (
            <div className="card">
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Key derivation
              </div>
              <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>
                {effectiveRotateKeys
                  ? 'Generate independent keys'
                  : 'Keep recovery access'}
              </div>
              {effectiveRotateKeys && (
                <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginTop: 6, marginBottom: 0, lineHeight: 1.5 }}>
                  A migration event will be published. {name}'s new identity will be activated.
                </p>
              )}
            </div>
          )}
        </div>

        {confirmError && (
          <div className="section">
            <div
              style={{
                padding: 12,
                background: 'var(--danger-light)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--danger)',
                fontSize: '0.9rem',
              }}
            >
              {confirmError}
            </div>
          </div>
        )}

        <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={confirming || contactsLoading || !contactsGate.allowed}
          >
            {confirming ? 'Confirming…' : 'Confirm ceremony'}
          </button>
          {contactsLoading && (
            <p role="note" className="field-hint" style={{ marginTop: 8 }}>{REMOVE_DEPENDANT_CONTACTS_LOADING_COPY}</p>
          )}
          {!contactsLoading && !contactsGate.allowed && contactsGate.reason && (
            <p role="note" className="field-hint" style={{ marginTop: 8 }}>{contactsGate.reason}</p>
          )}
          <button
            className="btn btn-ghost"
            onClick={() => { setConfirmError(''); setStep(hasDerivedKeys ? 3 : 2); }}
            disabled={confirming}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  // ── Step 5: Complete ──────────────────────────────────────────────────────

  if (step === 5) {
    const effectiveRotateKeys = rotateKeys ?? false;

    return (
      <div className="fade-in" role="main" style={{ textAlign: 'center' }}>
        <div style={{ marginBottom: 32 }}>
          {/* Simple success mark */}
          <div
            aria-hidden="true"
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 24px',
            }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--on-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>

          <h2 style={{ marginBottom: 12 }}>Ceremony complete</h2>

          {effectiveRotateKeys ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: 1.6, margin: '0 auto', maxWidth: 320 }}>
              A migration event has been published. {name}'s new identity is active.
            </p>
          ) : (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: 1.6, margin: '0 auto', maxWidth: 320 }}>
              {name}'s autonomy preferences have been updated.
            </p>
          )}
        </div>

        <button className="btn btn-primary" onClick={onBack}>
          Done
        </button>
      </div>
    );
  }

  return null;
}
