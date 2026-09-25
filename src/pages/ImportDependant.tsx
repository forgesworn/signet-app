import { useState } from 'react';
import { useCamera } from '../hooks/useCamera';
import { QRScanner } from '../components/QRScanner';
import { decodeNpub, validateMnemonic, parseQRPayload, importFromMnemonic, shortNpub } from '../lib/signet';
import { computeAge } from '../lib/date-utils';

interface Props {
  onImportDependant: (opts: {
    displayName: string;
    dateOfBirth?: string;
    publicKey: string;
    mnemonic?: string;
  }) => Promise<void>;
  onSwitchToDependant?: () => void;
  onBack: () => void;
}

type ImportMethod = 'scan-qr' | 'enter-pubkey' | 'mnemonic';
type Step = 'choose-method' | 'scan' | 'enter-pubkey' | 'enter-mnemonic' | 'details' | 'confirm' | 'saving' | 'success' | 'error';

export function ImportDependant({ onImportDependant, onSwitchToDependant, onBack }: Props) {
  const { hasPermission, error: cameraError, requestPermission } = useCamera();

  const [step, setStep] = useState<Step>('choose-method');
  const [importMethod, setImportMethod] = useState<ImportMethod | null>(null);

  // Input state
  const [pubkeyInput, setPubkeyInput] = useState('');
  const [mnemonicInput, setMnemonicInput] = useState('');
  const [showPasteInput, setShowPasteInput] = useState(false);
  const [pasteValue, setPasteValue] = useState('');

  // Resolved identity
  const [resolvedPubkey, setResolvedPubkey] = useState('');
  const [resolvedMnemonic, setResolvedMnemonic] = useState<string | undefined>(undefined);

  // Details form
  const [displayName, setDisplayName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');

  // Validation errors
  const [pubkeyError, setPubkeyError] = useState('');
  const [mnemonicError, setMnemonicError] = useState('');
  const [nameError, setNameError] = useState('');
  const [dobError, setDobError] = useState('');

  const [scanError, setScanError] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function tryParsePubkey(raw: string): string | null {
    const trimmed = raw.trim();
    // npub1…
    if (trimmed.startsWith('npub1')) {
      try {
        const bytes = decodeNpub(trimmed);
        const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
        return hex;
      } catch {
        return null;
      }
    }
    // 64-char hex
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    return null;
  }

  // ── QR scanning ──────────────────────────────────────────────────────────────

  const handleQRScan = (data: string) => {
    try {
      // Try parsing as a Signet QR payload first
      const payload = parseQRPayload(data);
      if (payload?.pubkey) {
        setResolvedPubkey(payload.pubkey);
        setResolvedMnemonic(undefined);
        setImportMethod('scan-qr');
        setStep('details');
        return;
      }
    } catch { /* fall through */ }

    // Try treating the raw string as an npub or hex pubkey
    const pubkey = tryParsePubkey(data);
    if (pubkey) {
      setResolvedPubkey(pubkey);
      setResolvedMnemonic(undefined);
      setImportMethod('scan-qr');
      setStep('details');
      return;
    }

    setScanError('Could not read QR code. Please try again.');
  };

  // ── Enter pubkey submit ───────────────────────────────────────────────────────

  const handlePubkeySubmit = () => {
    const pubkey = tryParsePubkey(pubkeyInput);
    if (!pubkey) {
      setPubkeyError('Please enter a valid public address starting with npub1.');
      return;
    }
    setPubkeyError('');
    setResolvedPubkey(pubkey);
    setResolvedMnemonic(undefined);
    setImportMethod('enter-pubkey');
    setStep('details');
  };

  // ── Mnemonic submit ───────────────────────────────────────────────────────────

  const handleMnemonicSubmit = () => {
    const words = mnemonicInput.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      setMnemonicError('Please enter a 12 or 24 word mnemonic.');
      return;
    }
    if (!validateMnemonic(mnemonicInput.trim())) {
      setMnemonicError('These words are not a valid mnemonic. Please check and try again.');
      return;
    }
    setMnemonicError('');

    // Derive the NP public key from the mnemonic.
    let pubkey: string;
    try {
      const tempIdentity = importFromMnemonic(mnemonicInput.trim(), '', 'natural-person', false);
      pubkey = tempIdentity.naturalPerson.publicKey;
    } catch {
      setMnemonicError('Failed to derive keys from mnemonic. Please try again.');
      return;
    }

    setResolvedPubkey(pubkey);
    setResolvedMnemonic(mnemonicInput.trim());
    setImportMethod('mnemonic');
    setStep('details');
  };

  // ── Details validation ────────────────────────────────────────────────────────

  const validateDetails = (): boolean => {
    let valid = true;

    const trimmedName = displayName.trim();
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

  // ── Confirm & import ──────────────────────────────────────────────────────────

  const handleImport = async () => {
    setStep('saving');
    try {
      await onImportDependant({
        displayName: displayName.trim(),
        dateOfBirth: dateOfBirth || undefined,
        publicKey: resolvedPubkey,
        mnemonic: resolvedMnemonic,
      });
      setStep('success');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setStep('error');
    }
  };

  // ── Step: choose method ───────────────────────────────────────────────────────

  if (step === 'choose-method') {
    return (
      <div className="fade-in" role="main">
        <div className="section">
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: 1.6 }}>
            Import an existing Signet identity and manage it as a dependant.
            The child's public key and reputation will be preserved.
          </p>
        </div>

        <div className="section">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              className="btn btn-primary"
              onClick={() => {
                setImportMethod('scan-qr');
                setScanError('');
                if (hasPermission === null) {
                  requestPermission().then(() => setStep('scan'));
                } else {
                  setStep('scan');
                }
              }}
            >
              Scan QR code
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setImportMethod('enter-pubkey');
                setPubkeyInput('');
                setPubkeyError('');
                setStep('enter-pubkey');
              }}
            >
              Enter npub or public key
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setImportMethod('mnemonic');
                setMnemonicInput('');
                setMnemonicError('');
                setStep('enter-mnemonic');
              }}
            >
              Import with mnemonic
            </button>
          </div>

          <button className="btn btn-ghost" onClick={onBack} style={{ marginTop: 16 }}>
            Back
          </button>
        </div>
      </div>
    );
  }

  // ── Step: scan ────────────────────────────────────────────────────────────────

  if (step === 'scan') {
    return (
      <div className="fade-in" role="main">
        <h2 style={{ marginBottom: 16 }}>Scan their QR code</h2>

        {cameraError && (
          <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
            {cameraError}
          </div>
        )}
        {scanError && (
          <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
            {scanError}
          </div>
        )}

        <QRScanner onScan={handleQRScan} active={hasPermission === true} />

        {hasPermission === null && (
          <button className="btn btn-primary" onClick={requestPermission} style={{ marginTop: 16 }}>
            Allow camera access
          </button>
        )}

        {!showPasteInput ? (
          <button
            className="btn btn-ghost"
            onClick={() => setShowPasteInput(true)}
            style={{ marginTop: 12, fontSize: '0.85rem' }}
          >
            Can't scan? Paste the code
          </button>
        ) : (
          <div style={{ marginTop: 12 }}>
            <textarea
              className="input"
              rows={3}
              placeholder="Paste QR payload or npub here"
              value={pasteValue}
              onChange={e => setPasteValue(e.target.value)}
              style={{ resize: 'none', fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const trimmed = pasteValue.trim();
                  if (trimmed) handleQRScan(trimmed);
                }}
                disabled={!pasteValue.trim()}
                style={{ flex: 1 }}
              >
                Submit
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => { setShowPasteInput(false); setPasteValue(''); }}
                style={{ flex: 1 }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <button
          className="btn btn-ghost"
          onClick={() => { setStep('choose-method'); setScanError(''); setShowPasteInput(false); setPasteValue(''); }}
          style={{ marginTop: 12 }}
        >
          Back
        </button>
      </div>
    );
  }

  // ── Step: enter pubkey ────────────────────────────────────────────────────────

  if (step === 'enter-pubkey') {
    return (
      <div className="fade-in" role="main">
        <h2 style={{ marginBottom: 8 }}>Enter their public key</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16 }}>
          Enter their public address, starting with npub1.
        </p>

        {pubkeyError && (
          <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
            {pubkeyError}
          </div>
        )}

        <input
          className="input"
          type="text"
          placeholder="npub1…"
          value={pubkeyInput}
          onChange={e => setPubkeyInput(e.target.value)}
          autoFocus
          autoComplete="off"
          style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}
        />

        <button
          className="btn btn-primary"
          onClick={handlePubkeySubmit}
          disabled={!pubkeyInput.trim()}
          style={{ marginTop: 16 }}
        >
          Continue
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => { setStep('choose-method'); setPubkeyError(''); }}
          style={{ marginTop: 8 }}
        >
          Back
        </button>
      </div>
    );
  }

  // ── Step: enter mnemonic ──────────────────────────────────────────────────────

  if (step === 'enter-mnemonic') {
    return (
      <div className="fade-in" role="main">
        <h2 style={{ marginBottom: 8 }}>Enter their mnemonic</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16 }}>
          Enter the 12 or 24 word backup phrase for the child's Signet identity.
          This gives you full key access and the ability to sign on their behalf.
        </p>

        {mnemonicError && (
          <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
            {mnemonicError}
          </div>
        )}

        <textarea
          className="input"
          rows={5}
          placeholder="word1 word2 word3 …"
          value={mnemonicInput}
          onChange={e => setMnemonicInput(e.target.value)}
          autoFocus
          style={{ resize: 'none', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}
        />

        <button
          className="btn btn-primary"
          onClick={handleMnemonicSubmit}
          disabled={!mnemonicInput.trim()}
          style={{ marginTop: 16 }}
        >
          Continue
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => { setStep('choose-method'); setMnemonicError(''); }}
          style={{ marginTop: 8 }}
        >
          Back
        </button>
      </div>
    );
  }

  // ── Step: details ─────────────────────────────────────────────────────────────

  if (step === 'details') {
    const hasMnemonic = !!resolvedMnemonic;

    return (
      <div className="fade-in" role="main">
        <div className="section">
          <div style={{ padding: 12, background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', marginBottom: 16 }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 4 }}>Imported public key</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--text-primary)', wordBreak: 'break-all' }}>
              {shortNpub(resolvedPubkey)}
            </div>
          </div>

          {hasMnemonic ? (
            <div style={{ padding: 12, background: 'var(--guardian-light)', borderRadius: 'var(--radius-sm)', marginBottom: 16, borderLeft: '3px solid var(--guardian)' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--guardian-text)', fontWeight: 600 }}>
                Full key access
              </span>
              <span style={{ fontSize: '0.85rem', color: 'var(--guardian-text)' }}>
                {' — '}you can sign on their behalf.
              </span>
            </div>
          ) : (
            <div style={{ padding: 12, background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', marginBottom: 16, borderLeft: '3px solid var(--border)' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                View-only
              </span>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {' — '}you can monitor but not sign for them until they connect their device.
              </span>
            </div>
          )}
        </div>

        <div className="section">
          <div style={{ marginBottom: 16 }}>
            <label
              htmlFor="import-dep-name"
              style={{ display: 'block', fontWeight: 600, marginBottom: 6, fontSize: '0.9rem' }}
            >
              Their name
            </label>
            <input
              id="import-dep-name"
              className="input"
              type="text"
              placeholder="Enter their name"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              maxLength={100}
              autoFocus
              autoComplete="off"
            />
            {nameError && (
              <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 4 }}>
                {nameError}
              </p>
            )}
          </div>

          <div style={{ marginBottom: 24 }}>
            <label
              htmlFor="import-dep-dob"
              style={{ display: 'block', fontWeight: 600, marginBottom: 6, fontSize: '0.9rem' }}
            >
              Date of birth <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.8rem' }}>(optional)</span>
            </label>
            <input
              id="import-dep-dob"
              className="input"
              type="date"
              value={dateOfBirth}
              onChange={e => setDateOfBirth(e.target.value)}
            />
            {dobError && (
              <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 4 }}>
                {dobError}
              </p>
            )}
          </div>

          <button
            className="btn btn-primary"
            onClick={() => {
              if (validateDetails()) setStep('confirm');
            }}
          >
            Continue
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setNameError('');
              setDobError('');
              // Go back to whichever entry step was used
              if (importMethod === 'scan-qr') setStep('scan');
              else if (importMethod === 'enter-pubkey') setStep('enter-pubkey');
              else setStep('enter-mnemonic');
            }}
            style={{ marginTop: 8 }}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  // ── Step: confirm ─────────────────────────────────────────────────────────────

  if (step === 'confirm') {
    const hasMnemonic = !!resolvedMnemonic;
    const methodLabel = importMethod === 'scan-qr'
      ? 'QR code scan'
      : importMethod === 'enter-pubkey'
        ? 'Public key entry'
        : 'Mnemonic (full access)';

    return (
      <div className="fade-in" role="main">
        <h2 style={{ marginBottom: 16 }}>Ready to import?</h2>

        <div className="card" style={{ marginBottom: 24 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              <tr>
                <td style={{ padding: '6px 0', fontSize: '0.85rem', color: 'var(--text-muted)', width: 100, verticalAlign: 'top' }}>Name</td>
                <td style={{ padding: '6px 0', fontSize: '0.9rem', fontWeight: 600 }}>{displayName.trim()}</td>
              </tr>
              {dateOfBirth && (
              <tr>
                <td style={{ padding: '6px 0', fontSize: '0.85rem', color: 'var(--text-muted)', verticalAlign: 'top' }}>Date of birth</td>
                <td style={{ padding: '6px 0', fontSize: '0.9rem' }}>{dateOfBirth}</td>
              </tr>
              )}
              <tr>
                <td style={{ padding: '6px 0', fontSize: '0.85rem', color: 'var(--text-muted)', verticalAlign: 'top' }}>Public key</td>
                <td style={{ padding: '6px 0', fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                  {shortNpub(resolvedPubkey)}
                </td>
              </tr>
              <tr>
                <td style={{ padding: '6px 0', fontSize: '0.85rem', color: 'var(--text-muted)', verticalAlign: 'top' }}>Import method</td>
                <td style={{ padding: '6px 0', fontSize: '0.9rem' }}>{methodLabel}</td>
              </tr>
              <tr>
                <td style={{ padding: '6px 0', fontSize: '0.85rem', color: 'var(--text-muted)', verticalAlign: 'top' }}>Access level</td>
                <td style={{ padding: '6px 0', fontSize: '0.9rem' }}>
                  {hasMnemonic ? (
                    <span style={{ color: 'var(--guardian-text)', fontWeight: 600 }}>Full key access</span>
                  ) : (
                    <span style={{ color: 'var(--text-secondary)' }}>View-only</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <button
          className="btn btn-primary"
          onClick={handleImport}
        >
          Import as dependant
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => setStep('details')}
          style={{ marginTop: 8 }}
        >
          Back
        </button>
      </div>
    );
  }

  // ── Step: saving ──────────────────────────────────────────────────────────────

  if (step === 'saving') {
    return (
      <div className="fade-in" role="main" style={{ textAlign: 'center', paddingTop: 40 }}>
        <p style={{ color: 'var(--text-secondary)' }}>Importing identity…</p>
      </div>
    );
  }

  // ── Step: success ─────────────────────────────────────────────────────────────

  if (step === 'success') {
    return (
      <div className="fade-in" role="main" style={{ textAlign: 'center' }}>
        <div
          aria-hidden="true"
          style={{ width: 72, height: 80, margin: '0 auto 24px', position: 'relative' }}
        >
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
          {displayName.trim()} has been imported as a dependant.
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 32, lineHeight: 1.6 }}>
          You can now monitor their identity, verify their age, and manage their account.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {onSwitchToDependant && (
            <button className="btn btn-primary" onClick={onSwitchToDependant}>
              Switch to {displayName.trim()}
            </button>
          )}
          <button className="btn btn-secondary" onClick={onBack}>
            Stay as me
          </button>
        </div>
      </div>
    );
  }

  // ── Step: error ───────────────────────────────────────────────────────────────

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
            onClick={() => { setStep('confirm'); setErrorMessage(''); }}
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
