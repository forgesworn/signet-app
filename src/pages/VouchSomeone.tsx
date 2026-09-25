import { useState } from 'react';
import type { SigningBackend } from '../lib/signing-backend';
import { decodeNpub, shortNpub } from '../lib/signet';
import { publishEvent } from '../lib/relay-service';

type VouchMethod = 'in-person' | 'online';
type Step = 'form' | 'confirm' | 'publishing' | 'done' | 'error';

interface Props {
  activeBackend: SigningBackend;
  onBack: () => void;
}

function isValidHexPubkey(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function isValidNpub(value: string): boolean {
  return /^npub1[023456789acdefghjklmnpqrstuvwxyz]{6,}$/i.test(value);
}

function resolveHexPubkey(input: string): string | null {
  const trimmed = input.trim();
  if (isValidHexPubkey(trimmed)) return trimmed.toLowerCase();
  if (isValidNpub(trimmed)) {
    try {
      const bytes = decodeNpub(trimmed);
      if (bytes.length !== 32) return null;
      return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return null;
    }
  }
  return null;
}

export function VouchSomeone({ activeBackend, onBack }: Props) {
  const [step, setStep] = useState<Step>('form');
  const [inputValue, setInputValue] = useState('');
  const [method, setMethod] = useState<VouchMethod>('in-person');
  const [context, setContext] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [subjectPubkey, setSubjectPubkey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleInputChange = (value: string) => {
    setInputValue(value);
    setInputError(null);
  };

  const handleContinue = () => {
    const hex = resolveHexPubkey(inputValue);
    if (!hex) {
      setInputError('Enter a valid public address starting with npub1.');
      return;
    }
    if (hex === activeBackend.activePublicKeyHex.toLowerCase()) {
      setInputError('You cannot vouch for yourself.');
      return;
    }
    setSubjectPubkey(hex);
    setStep('confirm');
  };

  const handlePublish = async () => {
    if (!subjectPubkey) return;
    setStep('publishing');

    const voucherPubkey = activeBackend.activePublicKeyHex;
    const contextTrimmed = context.trim();

    const unsignedEvent = {
      pubkey: voucherPubkey,
      kind: 31000,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', `vouch:${subjectPubkey}`],
        ['type', 'vouch'],
        ['p', subjectPubkey],
        ['method', method],
        ['L', 'nip-va'],
        ['l', 'vouch', 'nip-va'],
        ...(contextTrimmed ? [['context', contextTrimmed]] : []),
      ],
      content: contextTrimmed,
    };

    try {
      const signed = await activeBackend.signEvent(unsignedEvent);
      const result = await publishEvent(signed);
      if (!result.ok) {
        setErrorMessage(result.message || 'Relay rejected the vouch event.');
        setStep('error');
        return;
      }
      setStep('done');
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to publish vouch.');
      setStep('error');
    }
  };

  if (step === 'done') {
    return (
      <div className="fade-in" role="main">
        <div className="section" style={{ textAlign: 'center', paddingTop: 32 }}>
          <div
            style={{
              fontSize: '3rem',
              marginBottom: 16,
            }}
            aria-hidden="true"
          >
            ✓
          </div>
          <h2 style={{ marginBottom: 8 }}>Vouch published</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 24, fontSize: '0.9rem' }}>
            Your vouch for{' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>{subjectPubkey ? shortNpub(subjectPubkey) : ''}</span>{' '}
            has been published to the relay.
          </p>
          <button className="btn btn-primary" onClick={onBack}>
            Done
          </button>
        </div>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="fade-in" role="main">
        <div
          className="card section"
          style={{ background: 'var(--danger-light)', borderColor: 'var(--danger)', marginTop: 24 }}
        >
          <h2 style={{ marginBottom: 8, color: 'var(--danger)' }}>Failed to publish</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16 }}>
            {errorMessage}
          </p>
          <button className="btn btn-secondary" onClick={() => setStep('confirm')}>
            Try again
          </button>
        </div>
        <div className="section">
          <button className="btn btn-ghost" onClick={onBack}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (step === 'publishing') {
    return (
      <div
        className="fade-in"
        role="main"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200 }}
      >
        <p style={{ color: 'var(--text-secondary)' }}>Publishing vouch…</p>
      </div>
    );
  }

  if (step === 'confirm' && subjectPubkey) {
    return (
      <div className="fade-in" role="main">
        <div className="card section">
          <div className="section-title">Confirm vouch</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
                Vouching for
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, wordBreak: 'break-all' }}>
                {shortNpub(subjectPubkey)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
                Method
              </div>
              <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>
                {method === 'in-person' ? 'In-person' : 'Online'}
              </div>
            </div>
            {context.trim() && (
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
                  Context
                </div>
                <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                  {context.trim()}
                </div>
              </div>
            )}
          </div>
        </div>

        <div
          className="card section"
          style={{ background: 'var(--warning-light)', borderColor: 'var(--warning)' }}
        >
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            By publishing this vouch you are attesting that you have personally verified this person's
            identity via the selected method. Vouches are public and permanent on the Nostr network.
          </p>
        </div>

        <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button className="btn btn-primary" onClick={handlePublish}>
            Publish vouch
          </button>
          <button className="btn btn-secondary" onClick={() => setStep('form')}>
            Back
          </button>
        </div>
      </div>
    );
  }

  // Default: form step
  return (
    <div className="fade-in" role="main">
      <div className="card section">
        <div className="section-title">Person to vouch for</div>
        <input
          className="input"
          type="text"
          placeholder="npub1…"
          value={inputValue}
          onChange={e => handleInputChange(e.target.value)}
          aria-label="Public npub of person to vouch for"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={200}
        />
        {inputError && (
          <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 6 }}>
            {inputError}
          </p>
        )}
      </div>

      <div className="card section">
        <div className="section-title">Verification method</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(['in-person', 'online'] as VouchMethod[]).map(m => (
            <label
              key={m}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 16px',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${method === m ? 'var(--accent)' : 'var(--border)'}`,
                background: method === m ? 'var(--accent-light)' : 'var(--bg-secondary)',
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="vouchMethod"
                value={m}
                checked={method === m}
                onChange={() => setMethod(m)}
                style={{ accentColor: 'var(--accent)' }}
              />
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                {m === 'in-person' ? 'In-person' : 'Online'}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="card section">
        <div className="section-title">Context (optional)</div>
        <textarea
          className="input"
          placeholder="How do you know this person? (max 280 characters)"
          value={context}
          onChange={e => setContext(e.target.value.slice(0, 280))}
          rows={3}
          style={{ resize: 'vertical', fontFamily: 'inherit' }}
          aria-label="Optional context for this vouch"
        />
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, textAlign: 'right' }}>
          {context.length}/280
        </div>
      </div>

      <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          className="btn btn-primary"
          onClick={handleContinue}
          disabled={!inputValue.trim()}
        >
          Review vouch
        </button>
        <button className="btn btn-secondary" onClick={onBack}>
          Cancel
        </button>
      </div>
    </div>
  );
}
