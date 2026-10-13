import { useEffect, useMemo, useState } from 'react';
import type { ContactRecord, DependantIdentity } from '../types';
import { generateMnemonic } from '../lib/signet';
import { toRecoveryWords } from '../lib/recovery-words';
import type { IndependenceGate } from '../lib/contacts-v2-independence-gate';
import { REMOVE_DEPENDANT_CONTACTS_LOADING_COPY } from '../lib/contacts-v2-copy';
import type { GuardianCopyChoice, IndependenceOptions, IndependenceReview } from '../lib/independence-transfer';
import { RecoveryWordsGrid } from '../components/RecoveryWordsGrid';

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
  onCreateIndependentWords?: () => Promise<string>;
  onLoadTransferContacts?: () => Promise<{ contacts: ContactRecord[]; revision: string }>;
  onTransfer?: (opts: IndependenceOptions & { reviewRevision: string }) => Promise<void>;
  transferProblem?: string | null;
  recoveryRelays?: string[];
}

type Step = 1 | 2 | 3 | 4 | 5 | 6;

export function TransitionCeremony({ dependant, onComplete, onBack, contactsGate, contactsLoading, onResolveGate,
  onCreateIndependentWords, onLoadTransferContacts, onTransfer, transferProblem, recoveryRelays = [] }: Props) {
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
  const [reviewContacts, setReviewContacts] = useState<ContactRecord[] | null>(null);
  const [reviewRevision, setReviewRevision] = useState('');
  const [review, setReview] = useState<IndependenceReview>({});
  const [guardianCopy, setGuardianCopy] = useState<GuardianCopyChoice | null>(null);
  const [wordsVisible, setWordsVisible] = useState(true);
  const [wordsPreparing, setWordsPreparing] = useState(false);
  const transferring = rotateKeys === true && !!onTransfer;
  useEffect(() => {
    if (!newMnemonic || !wordsVisible || step !== 3) return;
    const timer = setTimeout(() => setWordsVisible(false), 90_000);
    return () => clearTimeout(timer);
  }, [newMnemonic, wordsVisible, step]);

  const hasDerivedKeys = /^dependant-(0|[1-9][0-9]*)$/.test(dependant.derivationPath);

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

  async function handleKeyDecision(rotate: boolean) {
    if (wordsPreparing) return;
    if (rotate) {
      setWordsPreparing(true);
      setConfirmError('');
      try {
        const mnemonic = onCreateIndependentWords ? await onCreateIndependentWords() : generateMnemonic();
        setNewMnemonic(mnemonic);
        setMnemonicConfirmed(false);
        setWordsVisible(true);
      } catch (error) {
        setConfirmError(error instanceof Error ? error.message : 'Could not prepare recovery words');
        return;
      } finally { setWordsPreparing(false); }
    } else {
      setNewMnemonic('');
      setMnemonicConfirmed(false);
    }
    setRotateKeys(rotate);
  }

  async function loadTransferReview() {
    setStep(6); setReviewContacts(null); setReview({}); setConfirmError('');
    try {
      const loaded = await onLoadTransferContacts!();
      setReviewContacts(loaded.contacts.filter(c => c.lifecycle !== 'removed'));
      setReviewRevision(loaded.revision);
    } catch (error) { setConfirmError(error instanceof Error ? error.message : 'Could not load contacts'); }
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
      if (transferring) {
        if (!removeGuardian || !guardianCopy || !reviewRevision || !mnemonicConfirmed || transferProblem) throw new Error('Finish the handover review first.');
        await onTransfer!({ removeGuardian: true, rotateKeys: true, newMnemonic, guardianCopy, review, reviewRevision });
        setNewMnemonic('');
        setStep(5);
        return;
      }
      // Re-check the contact-transfer gate against fresh data before doing
      // anything irreversible — `contactsGate` is a render-time memo and can
      // be stale by the time the user actually taps Confirm.
      const freshGate = await onResolveGate();
      if (!freshGate.allowed) {
        setConfirmError(freshGate.reason ?? '');
        return;
      }

      if (rotateKeys) throw new Error('Independent recovery transfer is unavailable. Your existing identity is unchanged.');

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
            Choose whether {name} will manage their own identity. For independent keys, you will
            review their contacts and verify recovery before the family copy changes.
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
            {name} will need to visit a professional verifier for new credentials without the guardian
            link. Existing credentials keep their original signatures.
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
          {transferProblem && <p role="note">{transferProblem}</p>}
          {!removeGuardian && <p role="note">Choose Remove guardian authority to use independent keys.</p>}
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
              disabled={wordsPreparing || !!transferProblem || !removeGuardian || !onTransfer}
              style={{ padding: '16px', textAlign: 'left', justifyContent: 'flex-start' }}
            >
              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Generate independent keys</div>
                <div style={{ fontSize: '0.85rem', fontWeight: 400, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {name} gets new recovery words. Their contacts move after recovery is verified.
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
              {wordsVisible ? <RecoveryWordsGrid words={words} bare /> : (
                <button className="btn btn-secondary" onClick={() => setWordsVisible(true)}>Show recovery words again</button>
              )}

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
                Write these down privately with {name}. They restore the new identity and its contacts.
                Anyone who has these words can control the new identity.
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
          {wordsPreparing && <p role="status">Preparing recovery words…</p>}
          {confirmError && <p role="alert">{confirmError}</p>}
          {canProceedFromStep3() && (
            <button className="btn btn-primary" onClick={() => { if (transferring && onLoadTransferContacts) void loadTransferReview(); else setStep(4); }}>
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

  if (step === 6) {
    return <div className="fade-in" role="main">
      <div className="section">
        <h2>Take contacts with them</h2>
        <p>Review these choices with {name}. Each choice becomes their own decision. Old contact proofs
          will need fresh verification; connected apps and credentials must be set up again.</p>
        <p>Contact names, methods, notes and saved pictures move with the directory. Guardian rules and app grants do not.</p>
      </div>
      {reviewContacts === null && !confirmError && <p role="status">Loading contacts…</p>}
      {reviewContacts?.length === 0 && <p>No active contacts to review.</p>}
      {reviewContacts?.map(contact => <div className="section card" key={contact.contactId}>
        <label>
          <span style={{ display: 'block', fontWeight: 600 }}>{contact.displayName || 'Unnamed contact'}</span>
          <select aria-label={`Trust for ${contact.displayName || contact.contactId}`} value={review[contact.contactId]?.tier ?? ''}
            onChange={e => { const tier = e.target.value as IndependenceReview[string]['tier'];
              setReview(old => ({ ...old, [contact.contactId]: { tier, keepBlocked: old[contact.contactId]?.keepBlocked ?? true } })); }}>
            <option value="" disabled>Choose with {name}</option>
            <option value="kin">Kin — close circle</option><option value="kith">Kith — acquaintance</option>
            <option value="ken">Ken — recognised</option><option value="remove">Remove contact</option>
          </select>
        </label>
        {contact.blocks.some(b => !b.liftedByOperationId) && <label style={{ display: 'block', marginTop: 12 }}>
          <input type="checkbox" checked={review[contact.contactId]?.keepBlocked ?? true}
            onChange={e => setReview(old => ({ ...old, [contact.contactId]: { ...old[contact.contactId],
              tier: old[contact.contactId]?.tier, keepBlocked: e.target.checked } }))} /> Keep blocked, under {name}'s control
        </label>}
      </div>)}
      <div className="section">
        <fieldset><legend>Your family contact copy after handover</legend>
          <label style={{ display: 'block' }}><input type="radio" name="guardian-copy" checked={guardianCopy === 'archive'} onChange={() => setGuardianCopy('archive')} /> Keep a read-only encrypted archive</label>
          <label style={{ display: 'block' }}><input type="radio" name="guardian-copy" checked={guardianCopy === 'delete'} onChange={() => setGuardianCopy('delete')} /> Delete it from this device</label>
        </fieldset>
        <p>Copies already held by other people or apps cannot be erased by this choice.</p>
        {confirmError && <p role="alert">{confirmError}</p>}
        <button className="btn btn-secondary" onClick={() => void loadTransferReview()}>Reload contacts</button>
        <button className="btn btn-primary" disabled={!reviewContacts || !guardianCopy || reviewContacts.some(c => !review[c.contactId]?.tier)} onClick={() => setStep(4)}>Continue</button>
        <button className="btn btn-ghost" onClick={() => setStep(3)}>Back</button>
      </div>
    </div>;
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
                  Their contacts and profile names will be encrypted under the new recovery words and restored from a relay before handover completes.
                </p>
              )}
            </div>
          )}
        </div>
        {transferring && <div className="section">
          <p>Your family copy: {guardianCopy === 'archive' ? 'read-only encrypted archive' : 'delete'}.</p>
          <p>{name} will restore with the new words on their own device, reconnect apps and renew credentials with a verifier.</p>
          {recoveryRelays.length > 0 && <p>When restoring, use these relay servers: {recoveryRelays.join(', ')}. Write them down with the recovery words.</p>}
          {!removeGuardian && <p role="alert">Choose Remove guardian authority to complete an independent handover.</p>}
          {transferProblem && <p role="alert">{transferProblem}</p>}
        </div>}

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
            disabled={confirming || contactsLoading || (transferring ? (!removeGuardian || !guardianCopy || !reviewRevision || !!transferProblem) : !contactsGate.allowed)}
          >
            {confirming ? 'Confirming…' : 'Confirm ceremony'}
          </button>
          {contactsLoading && (
            <p role="note" className="field-hint" style={{ marginTop: 8 }}>{REMOVE_DEPENDANT_CONTACTS_LOADING_COPY}</p>
          )}
          {!transferring && !contactsLoading && !contactsGate.allowed && contactsGate.reason && (
            <p role="note" className="field-hint" style={{ marginTop: 8 }}>{contactsGate.reason}</p>
          )}
          <button
            className="btn btn-ghost"
            onClick={() => { setConfirmError(''); setStep(transferring ? 6 : hasDerivedKeys ? 3 : 2); }}
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
          {effectiveRotateKeys && recoveryRelays.length > 0 && <p>Recovery relay servers: {recoveryRelays.join(', ')}</p>}

          {effectiveRotateKeys ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: 1.6, margin: '0 auto', maxWidth: 320 }}>
              {name}'s contacts and profile names were restored successfully using their new recovery words.
              They can now restore on their own device. Reconnect apps and visit a verifier for new credentials.
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
