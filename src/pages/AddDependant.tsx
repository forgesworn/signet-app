import { useState } from 'react';
import { computeAge } from '../lib/date-utils';
import { Icon } from '../components/Icon';

interface Props {
  onCreateDependant: (name: string, dateOfBirth?: string) => Promise<string>;
  onSwitchToDependant?: (dependantId: string) => void;
  onPairDevice?: (dependantId: string) => void;
  onTurnOnBunker?: () => void;
  bunkerServerEnabled: boolean;
  onBack: () => void;
}

type Step = 'form' | 'creating' | 'success' | 'error';

export function AddDependant({
  onCreateDependant,
  onSwitchToDependant,
  onPairDevice,
  onTurnOnBunker,
  bunkerServerEnabled,
  onBack,
}: Props) {
  const [step, setStep] = useState<Step>('form');
  const [name, setName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [nameError, setNameError] = useState('');
  const [dobError, setDobError] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

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
      setStep('success');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setStep('error');
    }
  };

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
          </div>

          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={busy}
          >
            {busy ? 'Creating identity…' : 'Create identity'}
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
