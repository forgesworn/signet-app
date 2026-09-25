import { useEffect, useState } from 'react';
import { TypedNameConfirm } from '../components/TypedNameConfirm';
import { RecoveryWordsGrid } from '../components/RecoveryWordsGrid';
import { sanitizeDisplayName } from '../lib/text-sanitize';
import type { ActivationBackupStep } from '../lib/activation-backup-step';
import { resolveActivationCopy, type ActivationExplanationLine } from '../lib/activation-copy';
import type { ActivationTarget } from '../types/routing';

interface Props {
  /** Who the ceremony is acting for — the owner, or a named dependant (spec §7.6). */
  target: ActivationTarget;
  /** Which backup step follows the confirm — from `resolveActivationBackupStep`. */
  backupStep: ActivationBackupStep;
  /** Recovery words to show on the backup step. Empty when `backupStep` is 'none'. */
  recoveryWords: string[];
  /** Persist the name + set `naturalPersonActive`. Rejects on failure. */
  onActivate: (legalName: string) => Promise<void>;
  /** Set `identity.backedUp = true`. Only called on the 'first-backup' branch. */
  onMarkBackedUp: () => Promise<void>;
  /** Activation finished — return to the gated feature, or to the new card. */
  onDone: () => void;
  /** Left without activating. */
  onCancel: () => void;
}

type Step = 'name' | 'confirm' | 'backup';

/** How long the recovery words stay on screen before they hide themselves. */
const WORDS_VISIBLE_MS = 90_000;

/**
 * Real-identity activation (spec §7.1).
 *
 * Three steps, deliberately front-loaded with friction: an explanation of what
 * the real identity is and is not, the legal name, then a typed confirm of that
 * exact name. Activation writes ONLY the name and the flag — it derives no key
 * (the natural-person keypair has existed since creation, byte-identical) and
 * it does not touch `primaryKeypair`.
 *
 * The optional fourth screen is the recovery-words step: activating is the
 * moment the account starts carrying a legal name, so it is the moment to make
 * sure the user can get back in.
 */
export function ActivateRealIdentity({
  target,
  backupStep,
  recoveryWords,
  onActivate,
  onMarkBackedUp,
  onDone,
  onCancel,
}: Props) {
  const copy = resolveActivationCopy(target);
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [backedUpChecked, setBackedUpChecked] = useState(false);
  const [error, setError] = useState('');
  // Recovery words auto-hide after 90 s (security convention, same
  // window as Security settings and Get Verified). Hidden IN PLACE rather than
  // advanced past: this is the last step of activation, so auto-advancing would
  // either mark the backup acknowledged without the checkbox or drop the user
  // out of the flow. Tapping "Show them again" re-arms the same window.
  const [wordsHidden, setWordsHidden] = useState(false);

  useEffect(() => {
    if (step !== 'backup' || wordsHidden) return;
    const timer = setTimeout(() => setWordsHidden(true), WORDS_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [step, wordsHidden]);

  const cleanName = sanitizeDisplayName(name, 100).trim();

  async function handleConfirm() {
    if (busy || !cleanName) return;
    setBusy(true);
    setError('');
    try {
      await onActivate(cleanName);
      if (backupStep === 'none') {
        onDone();
        return;
      }
      setStep('backup');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not activate your real identity — please try again');
    } finally {
      setBusy(false);
    }
  }

  async function handleBackupDone() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      // The Lite reminder is informational: the user already holds a working
      // phrase and is not confirming anything, so `backedUp` must not move.
      if (backupStep === 'first-backup') await onMarkBackedUp();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save — please try again');
    } finally {
      setBusy(false);
    }
  }

  if (step === 'backup') {
    return (
      <div className="fade-in" role="main">
        <div className="section">
          <h2 style={{ marginBottom: 8 }}>Write down your recovery words</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16 }}>
            {recoveryWords.length} words. Write them down in order. They restore your whole Signet —
            every persona and dependant — on a new phone or a family Heartwood.
          </p>

          {backupStep === 'lite-reminder' && (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 12 }}>
              Your Lite phrase still works, but these words are the ones MySignet restores from.
            </p>
          )}

          {wordsHidden ? (
            <div className="card" style={{ marginBottom: 20 }}>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 12 }}>
                Words hidden after 90 seconds, in case someone is looking over your shoulder.
              </p>
              <button className="btn btn-secondary" onClick={() => setWordsHidden(false)}>
                Show them again
              </button>
            </div>
          ) : (
            <RecoveryWordsGrid words={recoveryWords} />
          )}

          {error && (
            <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
              {error}
            </div>
          )}

          {backupStep === 'first-backup' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', marginBottom: 20, fontSize: '0.9rem' }}>
              <input
                type="checkbox"
                checked={backedUpChecked}
                onChange={e => setBackedUpChecked(e.target.checked)}
                style={{ width: 18, height: 18, flexShrink: 0, cursor: 'pointer' }}
              />
              I&rsquo;ve written these down somewhere safe
            </label>
          )}

          <button
            className="btn btn-primary"
            onClick={handleBackupDone}
            disabled={busy || (backupStep === 'first-backup' && !backedUpChecked)}
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  if (step === 'confirm') {
    return (
      <div className="fade-in" role="main">
        <div className="section">
          {error && (
            <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
              {error}
            </div>
          )}
          <TypedNameConfirm
            expectedString={cleanName}
            heading={copy.confirmHeading}
            body={copy.confirmBody}
            helperText={copy.confirmHelper}
            confirmLabel={copy.confirmLabel}
            onConfirm={handleConfirm}
            onCancel={() => { setStep('name'); setError(''); }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" role="main">
      <div className="card section">
        <div className="section-title">{copy.explanationTitle}</div>
        {copy.explanationBody.map((line, i) => (
          <p
            key={i}
            style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: i === copy.explanationBody.length - 1 ? 0 : 12 }}
          >
            <ExplanationLine line={line} />
          </p>
        ))}
      </div>

      <div className="section">
        <label className="row-label" htmlFor="legal-name" style={{ fontWeight: 600 }}>
          {copy.nameLabel}
        </label>
        <input
          id="legal-name"
          className="input"
          type="text"
          placeholder={copy.namePlaceholder}
          value={name}
          onChange={e => setName(e.target.value.slice(0, 100))}
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
          style={{ marginTop: 8 }}
        />
        <button
          className="btn btn-primary"
          onClick={() => { setError(''); setStep('confirm'); }}
          disabled={!cleanName}
          style={{ marginTop: 16 }}
        >
          Continue
        </button>
        <button className="btn btn-ghost" onClick={onCancel} style={{ marginTop: 8 }}>
          Not now
        </button>
      </div>
    </div>
  );
}

/**
 * One explanation paragraph. The object form bolds `emphasis` at its first
 * occurrence in `text` — the copy's own word, matched verbatim, so nothing is
 * interpreted as markup. A plain string, or an emphasis that isn't in the
 * text, renders unchanged.
 */
function ExplanationLine({ line }: { line: ActivationExplanationLine }) {
  if (typeof line === 'string') return <>{line}</>;
  const at = line.text.indexOf(line.emphasis);
  if (at < 0) return <>{line.text}</>;
  return (
    <>
      {line.text.slice(0, at)}
      <strong>{line.emphasis}</strong>
      {line.text.slice(at + line.emphasis.length)}
    </>
  );
}
