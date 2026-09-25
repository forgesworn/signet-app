import { shortNpub } from '../lib/signet';
import { parsePubkeyInput } from '../lib/pubkey-input';
import { useState } from 'react';
import { useCamera } from '../hooks/useCamera';
import { QRScanner } from '../components/QRScanner';
import { QRCode } from '../components/QRCode';
import { SignetWords } from '../components/SignetWords';
import { parseQRPayload, computeSharedSecret, serializeQRPayload, createQRPayload, getActivePubkey, getActivePrivateKey } from '../lib/signet';
import type { SignetIdentity, Contact } from '../types';
import { localKeyOnlyCopy } from '../lib/local-key-only-copy';

interface Props {
  identity: SignetIdentity;
  onAddMember: (member: Contact) => Promise<void>;
  onDone: () => void;
  wordCount?: number;
  onNostrConnect?: (data: string) => void;
  signingMode?: 'local' | 'bunker' | 'nip07' | 'paired-child';
}

type Step = 'choose' | 'scan' | 'show-qr' | 'enter-id' | 'preview' | 'success';

export function AddMember({ identity, onAddMember, onDone, wordCount, onNostrConnect, signingMode }: Props) {
  const { hasPermission, error: cameraError, requestPermission } = useCamera();
  const [step, setStep] = useState<Step>('choose');
  const [theirPubkey, setTheirPubkey] = useState('');
  const [theirName, setTheirName] = useState('');
  const [sharedSecret, setSharedSecret] = useState('');
  const [idInput, setIdInput] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [showPasteInput, setShowPasteInput] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const [theirPersonas, setTheirPersonas] = useState<Array<{ pubkey: string; label?: string }>>([]);

  // Persona selection for multi-persona QR sharing
  const [selectedPersonas, setSelectedPersonas] = useState<Map<string, { pubkey: string; label: string; checked: boolean }>>(() => {
    const map = new Map<string, { pubkey: string; label: string; checked: boolean }>();
    if (identity.naturalPerson.publicKey) {
      map.set(identity.naturalPerson.publicKey, {
        pubkey: identity.naturalPerson.publicKey,
        label: identity.naturalPerson.displayName || 'Natural Person',
        checked: identity.primaryKeypair === 'natural-person',
      });
    }
    if (identity.persona.publicKey) {
      map.set(identity.persona.publicKey, {
        pubkey: identity.persona.publicKey,
        label: identity.persona.displayName || 'Persona',
        checked: identity.primaryKeypair === 'persona',
      });
    }
    for (const extra of identity.extraPersonas ?? []) {
      // Hidden extras are soft-deleted by the user — don't surface them
      // in the AddMember picker either.
      if (extra.hidden) continue;
      map.set(extra.publicKey, {
        pubkey: extra.publicKey,
        label: extra.displayName || 'Persona',
        checked: false,
      });
    }
    return map;
  });

  function togglePersona(pubkey: string) {
    setSelectedPersonas(prev => {
      const next = new Map(prev);
      const entry = next.get(pubkey);
      if (!entry) return prev;
      const checkedCount = Array.from(next.values()).filter(e => e.checked).length;
      if (entry.checked && checkedCount <= 1) return prev;
      next.set(pubkey, { ...entry, checked: !entry.checked });
      return next;
    });
  }

  const checkedPersonas = Array.from(selectedPersonas.values()).filter(e => e.checked);
  const primaryPersona = checkedPersonas[0];
  const additionalPersonas = checkedPersonas.slice(1);

  const qrPayload = primaryPersona
    ? serializeQRPayload(createQRPayload(primaryPersona.pubkey, {
        name: primaryPersona.label,
        ...(additionalPersonas.length > 0 ? {
          personas: additionalPersonas.map(p => ({ pubkey: p.pubkey, label: p.label })),
        } : {}),
      }))
    : '';

  const unavailable = localKeyOnlyCopy('contacts', signingMode);
  if (unavailable) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <h2>{unavailable.title}</h2>
        <p style={{ color: 'var(--text-secondary)', marginTop: 12 }}>{unavailable.body}</p>
      </div>
    );
  }

  const handleScan = (data: string) => {
    // Check for NIP-46 nostrconnect:// URI first
    if (data.startsWith('nostrconnect://') && onNostrConnect) {
      onNostrConnect(data);
      return;
    }
    try {
      const payload = parseQRPayload(data);
      if (!payload?.pubkey) throw new Error('Invalid QR code');
      setTheirPubkey(payload.pubkey);
      setTheirName((payload.info?.name || 'Unknown').slice(0, 100));
      setTheirPersonas(payload.info?.personas ?? []);
      setStep('preview');
    } catch {
      setError('Could not read QR code. Please try again.');
    }
  };

  const handleIdSubmit = () => {
    const parsed = parsePubkeyInput(idInput);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setTheirPubkey(parsed.hex);
    setTheirName('');
    setStep('preview');
  };

  const handleConfirm = async () => {
    if (confirming) return;
    setConfirming(true);
    try {
      const myPrivKey = getActivePrivateKey(identity);
      const myPubKey = getActivePubkey(identity);

      // Generate groupId if multiple pubkeys
      const groupId = theirPersonas.length > 0
        ? Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')
        : undefined;

      // Primary contact
      const primarySecret = computeSharedSecret(myPrivKey, theirPubkey);
      setSharedSecret(primarySecret);
      await onAddMember({
        pubkey: theirPubkey,
        ownerPubkey: myPubKey,
        displayName: theirName || 'Contact',
        sharedSecret: primarySecret,
        verifiedAt: Math.floor(Date.now() / 1000),
        groupId,
        label: theirName || 'Natural Person',
        isDefaultForGroup: groupId ? true : undefined,
      });

      // Additional personas
      for (const persona of theirPersonas) {
        const secret = computeSharedSecret(myPrivKey, persona.pubkey);
        await onAddMember({
          pubkey: persona.pubkey,
          ownerPubkey: myPubKey,
          displayName: persona.label || 'Persona',
          sharedSecret: secret,
          verifiedAt: Math.floor(Date.now() / 1000),
          groupId,
          label: persona.label || 'Persona',
          isDefaultForGroup: false,
        });
      }

      setStep('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add contact');
    } finally {
      setConfirming(false);
    }
  };

  if (step === 'choose') {
    return (
      <div className="fade-in" role="main">
        <div className="section">
          <h2 style={{ marginBottom: 4 }}>In person?</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 12 }}>
            Scan their QR code, or show yours for them to scan.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn btn-primary" onClick={() => {
              if (hasPermission === null) requestPermission().then(() => setStep('scan'));
              else setStep('scan');
            }}>
              Scan their QR code
            </button>
            <button className="btn btn-secondary" onClick={() => setStep('show-qr')}>
              Show my QR code
            </button>
          </div>
        </div>

        <div className="section">
          <h2 style={{ marginBottom: 4 }}>Remote?</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 12 }}>
            For phone or video calls — enter their Signet ID.
          </p>
          <button className="btn btn-secondary" onClick={() => setStep('enter-id')}>
            Enter their npub
          </button>
        </div>
      </div>
    );
  }

  if (step === 'scan') {
    return (
      <div className="fade-in" role="main">
        <h2 style={{ marginBottom: 16 }}>Scan their QR code</h2>
        {cameraError && (
          <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
            {cameraError}
          </div>
        )}
        {error && (
          <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
            {error}
          </div>
        )}
        <QRScanner onScan={handleScan} active={hasPermission === true} />
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
            Can't scan? Paste their code
          </button>
        ) : (
          <div style={{ marginTop: 12 }}>
            <textarea
              className="input"
              rows={3}
              placeholder="Paste QR payload here"
              value={pasteValue}
              onChange={e => setPasteValue(e.target.value)}
              style={{ resize: 'none', fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}
              data-testid="paste-link-input"
              autoFocus
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const trimmed = pasteValue.trim();
                  if (trimmed) handleScan(trimmed);
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
        <button className="btn btn-ghost" onClick={() => { setStep('choose'); setError(''); }} style={{ marginTop: 12 }}>
          Back
        </button>
      </div>
    );
  }

  if (step === 'show-qr') {
    return (
      <div className="fade-in" role="main" style={{ textAlign: 'center' }}>
        <h2 style={{ marginBottom: 8 }}>Show this to them</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16 }}>
          Ask them to scan this QR code with their Signet app.
        </p>
        {selectedPersonas.size > 1 && (
          <div style={{ textAlign: 'left', marginBottom: 16 }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
              Share as
            </div>
            {Array.from(selectedPersonas.entries()).map(([pubkey, entry]) => (
              <label
                key={pubkey}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 0',
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                }}
              >
                <input
                  type="checkbox"
                  checked={entry.checked}
                  onChange={() => togglePersona(pubkey)}
                  style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
                />
                {entry.label}
              </label>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
          <QRCode data={qrPayload} size={240} />
        </div>
        <div
          data-testid="qr-payload"
          style={{ fontSize: '0.7rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', wordBreak: 'break-all', maxWidth: 300, margin: '0 auto 16px' }}
        >
          {qrPayload}
        </div>
        <button className="btn btn-ghost" onClick={() => setStep('choose')}>Back</button>
      </div>
    );
  }

  if (step === 'enter-id') {
    return (
      <div className="fade-in" role="main">
        <h2 style={{ marginBottom: 8 }}>Enter their npub</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16 }}>
          Ask them to copy their public address (npub) and send it to you.
        </p>
        {error && (
          <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
            {error}
          </div>
        )}
        <input
          className="input"
          placeholder="npub1…"
          value={idInput}
          onChange={e => setIdInput(e.target.value.trim())}
          autoFocus
        />
        <button className="btn btn-primary" onClick={handleIdSubmit} disabled={!idInput.trim()} style={{ marginTop: 16 }}>
          Continue
        </button>
        <button className="btn btn-ghost" onClick={() => { setStep('choose'); setError(''); }} style={{ marginTop: 8 }}>
          Back
        </button>
      </div>
    );
  }

  if (step === 'preview') {
    return (
      <div className="fade-in" role="main" style={{ textAlign: 'center' }}>
        <h2 style={{ marginBottom: 16 }}>Add contact?</h2>
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: 4 }}>
            {theirName || 'Unknown person'}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {shortNpub(theirPubkey)}
          </div>
          {theirPersonas.length > 0 && (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: 4 }}>
              +{theirPersonas.length} {theirPersonas.length === 1 ? 'persona' : 'personas'}
            </div>
          )}
        </div>
        {!theirName && (
          <div style={{ marginBottom: 16 }}>
            <input
              className="input"
              placeholder="What should we call them?"
              value={theirName}
              onChange={e => setTheirName(e.target.value)}
              maxLength={100}
            />
          </div>
        )}
        {error && <div style={{ color: 'var(--danger)', marginBottom: 12, fontSize: '0.9rem' }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={handleConfirm} disabled={confirming} style={{ flex: 1 }}>
            Add contact
          </button>
          <button className="btn btn-secondary" onClick={() => { setStep('choose'); setError(''); }} style={{ flex: 1 }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (step === 'success') {
    return (
      <div className="fade-in" role="main" style={{ textAlign: 'center' }}>
        <div className="checkmark-anim" style={{ fontSize: '3rem', marginBottom: 8 }}>&#10003;</div>
        <h2 style={{ marginBottom: 8 }}>{theirName || 'Contact'} added</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 24 }}>
          Use Signet Me below to verify it's really them.
        </p>
        {sharedSecret && <SignetWords sharedSecret={sharedSecret} myPubkey={getActivePubkey(identity)} theirPubkey={theirPubkey} wordCount={wordCount} />}
        <button className="btn btn-primary" onClick={onDone} style={{ marginTop: 16 }}>
          Done
        </button>
      </div>
    );
  }

  return null;
}
