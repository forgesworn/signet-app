import { useEffect, useState } from 'react';
import { computeAge } from '../lib/date-utils';
import { Icon } from '../components/Icon';
import { RecoveryWordsGrid } from '../components/RecoveryWordsGrid';

interface Props {
  onCreateDependant: (name: string, dateOfBirth?: string) => Promise<string>;
  onSwitchToDependant?: (dependantId: string) => void;
  onPairDevice?: (dependantId: string) => void;
  onTurnOnBunker?: () => void;
  bunkerServerEnabled: boolean;
  onBack: () => void;
  /** First time this identity has ever added a dependant — show the role-confirm framing. */
  showRoleConfirm: boolean;
  /** Recovery words to show on the backup step. Null when there is nothing to back up (nsec import) or it is already backed up. */
  recoveryWords: string[] | null;
  /** Set `identity.backedUp = true`. */
  onMarkBackedUp: () => Promise<void>;
}

type Step = 'form' | 'creating' | 'backup' | 'success' | 'error';

/** How long the recovery words stay on screen before they hide themselves. */
const WORDS_VISIBLE_MS = 90_000;

export function AddDependant({
  onCreateDependant,
  onSwitchToDependant,
  onPairDevice,
  onTurnOnBunker,
  bunkerServerEnabled,
  onBack,
  showRoleConfirm,
  recoveryWords,
  onMarkBackedUp,
}: Props) {
  const [step, setStep] = useState<Step>('form');
  const [name, setName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [nameError, setNameError] = useState('');
  const [dobError, setDobError] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // Backup step state — mirrors ActivateRealIdentity's pattern.
  const [wordsHidden, setWordsHidden] = useState(false);
  const [backedUpChecked, setBackedUpChecked] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState('');

  useEffect(() => {
    if (step !== 'backup' || wordsHidden) return;
    const timer = setTimeout(() => setWordsHidden(true), WORDS_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [step, wordsHidden]);

  const validate = (): boolean => {
    let valid = true;

    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('Please enter their name.');
      valid = false;
    } else {
      setNameError('');
    }

    if (dateOfBirth) {
      const dob = new Date(dateOfBirth);
      const now = new Date();
      if (isNaN(dob.getTime())) {
        setDobError('Please enter a valid date.');
        valid = false;
      } else if (dob >= now) {
        setDobError('Date of birth must be in the past.');
        valid = false;
      } else {
        const age = computeAge(dateOfBirth);
        if (age >= 18) {
          setDobError('This person is 18 or older. Dependant accounts are for under-18s only.');
          valid = false;
        } else {
          setDobError('');
        }
      }
    } else {
      setDobError('');
    }

    return valid;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setStep('creating');
    try {
      const id = await onCreateDependant(name.trim(), dateOfBirth || undefined);
      setCreatedId(id);
      setStep(recoveryWords && recoveryWords.length > 0 ? 'backup' : 'success');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setStep('error');
    }
  };

  async function handleBackupDone() {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupError('');
    try {
      await onMarkBackedUp();
      setStep('success');
    } catch (e) {
      setBackupError(e instanceof Error ? e.message : 'Could not save — please try again');
    } finally {
      setBackupBusy(false);
    }
  }

  if (step === 'form' || step === 'creating') {
    const busy = step === 'creating';
    return (
      <div className="fade-in" role="main">
        <div className="section">
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: 1.6 }}>
            Your child is about to get their own Signet identity. It's theirs — you're the guardian.
            You'll manage it until they're ready.
          </p>
        </div>

        <div className="section">
          <div style={{ marginBottom: 16 }}>
            <label
              htmlFor="dependant-name"
              style={{ display: 'block', fontWeight: 600, marginBottom: 6, fontSize: '0.9rem' }}
            >
              Their name or handle
            </label>
            <input
              id="dependant-name"
              className="input"
              type="text"
              placeholder="A name or handle"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={100}
              disabled={busy}
              autoFocus
              autoComplete="off"
            />
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 6, lineHeight: 1.5 }}>
              This names their first persona. You can add their real identity later when they need it.
            </p>
            {nameError && (
              <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 4 }}>
                {nameError}
              </p>
            )}
          </div>

          <div style={{ marginBottom: 24 }}>
            <label
              htmlFor="dependant-dob"
              style={{ display: 'block', fontWeight: 600, marginBottom: 6, fontSize: '0.9rem' }}
            >
              Date of birth <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.8rem' }}>(optional)</span>
            </label>
            <input
              id="dependant-dob"
              className="input"
              type="date"
              value={dateOfBirth}
              onChange={e => setDateOfBirth(e.target.value)}
              disabled={busy}
            />
            {dobError && (
              <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 4 }}>
                {dobError}
              </p>
            )}
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 6, lineHeight: 1.5 }}>
              Without it, sites can't see their age range.
            </p>
          </div>

          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: 1.5, marginBottom: 16 }}>
            Sites see their age as vouched by you, not verified. Some may later ask you to verify; that's when
            you'll be asked for your real identity.
          </p>

          {showRoleConfirm && (
            <div
              className="card"
              style={{ borderLeft: '3px solid var(--accent)', padding: 12, marginBottom: 16 }}
            >
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                <li>You will hold their keys. They come from your recovery words.</li>
                <li>Sites will ask you to approve things for them.</li>
                <li>One day they take these keys with them. That's a ceremony, not a delete.</li>
              </ul>
            </div>
          )}

          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={busy}
          >
            {busy ? 'Creating identity…' : showRoleConfirm ? "I'll hold their keys" : 'Create identity'}
          </button>
          <button
            className="btn btn-ghost"
            onClick={onBack}
            disabled={busy}
            style={{ marginTop: 8 }}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  if (step === 'backup') {
    const trimmedName = name.trim() || 'Their';
    const words = recoveryWords ?? [];
    return (
      <div className="fade-in" role="main">
        <div className="section">
          <h2 style={{ marginBottom: 8 }}>{trimmedName}'s keys are inside yours</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16, lineHeight: 1.6 }}>
            Their identity comes from your recovery words. Without them, neither of you can get back in on a
            new phone.
          </p>

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
            <RecoveryWordsGrid words={words} />
          )}

          {backupError && (
            <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
              {backupError}
            </div>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', marginBottom: 20, fontSize: '0.9rem' }}>
            <input
              type="checkbox"
              checked={backedUpChecked}
              onChange={e => setBackedUpChecked(e.target.checked)}
              style={{ width: 18, height: 18, flexShrink: 0, cursor: 'pointer' }}
            />
            I&rsquo;ve written these down somewhere safe
          </label>

          <button
            className="btn btn-primary"
            onClick={handleBackupDone}
            disabled={backupBusy || !backedUpChecked}
          >
            Done
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => setStep('success')}
            disabled={backupBusy}
            style={{ marginTop: 8 }}
          >
            Not here
          </button>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 6, lineHeight: 1.5 }}>
            Do this somewhere private. We'll keep reminding you.
          </p>
        </div>
      </div>
    );
  }

  if (step === 'success') {
    const trimmedName = name.trim();
    return (
      <div className="fade-in" role="main" style={{ textAlign: 'center' }}>
        <div
          aria-hidden="true"
          style={{
            width: 72,
            height: 80,
            margin: '0 auto 24px',
            position: 'relative',
          }}
        >
          {/* Shield shape built from CSS */}
          <div style={{
            width: 72,
            height: 72,
            background: 'var(--accent)',
            borderRadius: '50% 50% 4px 4px / 50% 50% 4px 4px',
            clipPath: 'polygon(50% 0%, 100% 20%, 100% 60%, 50% 100%, 0% 60%, 0% 20%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <div style={{
              width: 28,
              height: 28,
              border: '3px solid var(--on-accent)',
              borderRadius: '50% 50% 3px 3px / 50% 50% 3px 3px',
              clipPath: 'polygon(50% 0%, 100% 20%, 100% 60%, 50% 100%, 0% 60%, 0% 20%)',
            }} />
          </div>
        </div>

        <h2 style={{ marginBottom: 8 }}>
          {trimmedName}'s identity is ready.
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 24, lineHeight: 1.6 }}>
          What's next?
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'left' }}>
          {bunkerServerEnabled && onPairDevice && createdId && (
            <button
              className="btn btn-primary"
              onClick={() => onPairDevice(createdId)}
            >
              <Icon name="smartphone" size={15} className="icon-inline" />Pair their phone now
              <div style={{ fontWeight: 400, fontSize: '0.8rem', opacity: 0.85, marginTop: 2 }}>
                Show a QR code on this phone for {trimmedName}'s phone to scan.
              </div>
            </button>
          )}
          {!bunkerServerEnabled && onTurnOnBunker && (
            <button
              className="btn btn-primary"
              onClick={onTurnOnBunker}
            >
              <Icon name="settings" size={15} className="icon-inline" />Turn the Bunker on first
              <div style={{ fontWeight: 400, fontSize: '0.8rem', opacity: 0.85, marginTop: 2 }}>
                The Bunker is off in Security settings. Turn it on, then come back here.
              </div>
            </button>
          )}
          {onSwitchToDependant && createdId && (
            <button
              className="btn btn-secondary"
              onClick={() => onSwitchToDependant(createdId)}
            >
              <Icon name="user" size={15} className="icon-inline" />Hand this phone to {trimmedName}
              <div style={{ fontWeight: 400, fontSize: '0.8rem', opacity: 0.85, marginTop: 2 }}>
                Switch to their identity here. Use this if they're using your phone today.
              </div>
            </button>
          )}
          <button
            className="btn btn-ghost"
            onClick={onBack}
          >
            ✓ Done for now
            <div style={{ fontWeight: 400, fontSize: '0.8rem', opacity: 0.85, marginTop: 2 }}>
              You can pair their phone later from {trimmedName}'s settings.
            </div>
          </button>
        </div>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="fade-in" role="main" style={{ textAlign: 'center' }}>
        <h2 style={{ marginBottom: 8 }}>Something went wrong</h2>
        <div style={{
          padding: 12,
          background: 'var(--danger-light)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--danger)',
          fontSize: '0.9rem',
          marginBottom: 24,
        }}>
          {errorMessage}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-primary"
            onClick={() => { setStep('form'); setErrorMessage(''); }}
            style={{ flex: 1 }}
          >
            Try again
          </button>
          <button className="btn btn-secondary" onClick={onBack} style={{ flex: 1 }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return null;
}
