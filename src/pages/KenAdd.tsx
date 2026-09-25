import { useState } from 'react';
import { useCamera } from '../hooks/useCamera';
import { QRScanner } from '../components/QRScanner';
import {
  pinKen,
  pinKenFromNip05,
  buildKeyControlChallenge,
  verifyKeyControl,
} from '@forgesworn/kenspeckle/ken';
import type { KenEntry } from '@forgesworn/kenspeckle';
import { encodeNpub, hexToBytes, shortNpub, isValidHexKey } from '../lib/signet';
import { parsePubkeyInput } from '../lib/pubkey-input';
import { parseContactQR, resolveScannedContactName } from '../lib/contact-qr';
import { useContactAvatar } from '../hooks/useContactAvatar';
import { ContactAvatar } from '../components/ContactAvatar';

interface Props {
  ownerPubkeyHex: string;
  onAddKen: (entry: KenEntry) => Promise<void>;
  onDone: () => void;
  onBack: () => void;
  relayUrl: string;
  encryptionKey: string | null;
  /** Persist a scanned contact-share key (encrypted at rest). */
  onSaveContactAvatar: (pubkey: string, shareKey: string) => Promise<void>;
}

type Mode = 'choose' | 'hex-paste' | 'qr-scan' | 'nip05' | 'key-control' | 'success';

/** Render a hex pubkey as its npub form for display; pass through non-keys unchanged. */
function hexToNpub(hex: string): string {
  return isValidHexKey(hex) ? encodeNpub(hexToBytes(hex)) : hex;
}

/** Returns `null` if valid NIP-05 shape, or an error string. */
function validateNip05Shape(value: string): string | null {
  // NIP-05: local@domain (domain required)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())) {
    return 'Enter a NIP-05 address in the format name@domain.com.';
  }
  return null;
}

/** True when `hex` (already lowercase-normalised) is the owner's own key —
 *  kenspeckle 0.2.0's `pinKen` throws rather than pinning it. */
function isOwnKey(hex: string, ownerPubkeyHex: string): boolean {
  return hex === ownerPubkeyHex.toLowerCase();
}

/** Map a kenspeckle throw to calm, human copy — the library's own message
 *  text (an internal field name, an HTTP status) is never shown to the
 *  user. `pinKen`/`pinKenFromNip05` throw "…must not equal ownerPubkeyHex"
 *  when the resolved key turns out to be the owner's own, so that case is
 *  named even though the hex/QR paths already check for it up front. */
function humaniseKenAddError(e: unknown): string {
  const msg = e instanceof Error ? e.message : '';
  if (msg.includes('must not equal ownerPubkeyHex')) {
    return "That's your own key — you can't add yourself as a ken.";
  }
  if (msg.includes('HTTP')) {
    return 'Could not reach that address right now. Check it is correct and try again.';
  }
  if (msg.includes('response') || msg.includes('did not resolve')) {
    return 'That NIP-05 address did not resolve to a key. Check it is correct and try again.';
  }
  return 'Could not add that key. Check the details and try again.';
}

export function KenAdd({ ownerPubkeyHex, onAddKen, onDone, onBack, relayUrl, encryptionKey, onSaveContactAvatar }: Props) {
  const { hasPermission, error: cameraError, requestPermission } = useCamera();

  const [mode, setMode] = useState<Mode>('choose');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Hex / QR inputs
  const [hexInput, setHexInput] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [scannedPubkey, setScannedPubkey] = useState('');
  const [scannedAvatarKey, setScannedAvatarKey] = useState<string | undefined>(undefined);

  // NIP-05 inputs
  const [nip05Input, setNip05Input] = useState('');
  const [nip05Busy, setNip05Busy] = useState(false);

  // Key-control state
  const [pendingEntry, setPendingEntry] = useState<KenEntry | null>(null);
  const [proofEnabled, setProofEnabled] = useState(false);
  const [challenge, setChallenge] = useState<{ nonce: string; createdAt: number } | null>(null);
  const [signedEventJson, setSignedEventJson] = useState('');

  // ── helpers ────────────────────────────────────────────────────────────────

  function truncate(s: string, max = 64) {
    return s.length > max ? s.slice(0, max) : s;
  }

  async function saveEntry(entry: KenEntry) {
    setSaving(true);
    try {
      await onAddKen(entry);
      if (scannedAvatarKey && encryptionKey) {
        try { await onSaveContactAvatar(entry.pubkey, scannedAvatarKey); } catch { /* non-fatal */ }
      }
      setPendingEntry(entry);
      setMode('success');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save ken entry.');
    } finally {
      setSaving(false);
    }
  }

  // ── hex-paste flow ─────────────────────────────────────────────────────────

  async function handleHexSubmit() {
    if (saving) return;
    setError('');
    const result = parsePubkeyInput(hexInput);
    if ('error' in result) { setError(result.error); return; }
    if (isOwnKey(result.hex, ownerPubkeyHex)) {
      setError("That's your own key — you can't add yourself as a ken.");
      return;
    }
    const name = truncate(displayName.trim(), 100) || undefined;
    let entry: KenEntry;
    try {
      entry = pinKen({
        pubkeyHex: result.hex,
        ownerPubkeyHex,
        displayName: name,
        provenance: { source: 'manual', locator: 'pasted', confirmedAt: Math.floor(Date.now() / 1000) },
      });
    } catch (e) {
      setError(humaniseKenAddError(e));
      return;
    }
    if (proofEnabled) {
      const c = buildKeyControlChallenge();
      setChallenge(c);
      setPendingEntry(entry);
      setMode('key-control');
    } else {
      await saveEntry(entry);
    }
  }

  // ── QR scan flow ───────────────────────────────────────────────────────────

  async function handleQRScan(data: string) {
    setError('');
    const raw = data.trim();
    let hex: string | null = null;
    let payloadName: string | undefined;
    let avatarKey: string | undefined;

    // Bare hex or npub
    const parsed = parsePubkeyInput(raw);
    if ('hex' in parsed) {
      hex = parsed.hex;
    } else {
      // App-level contact payload (JSON)?
      const contact = parseContactQR(raw);
      if (contact) { hex = contact.pubkey; payloadName = contact.name; avatarKey = contact.avatarKey; }
    }

    if (!hex) {
      setError('Could not read a public address from the QR code. Scan a contact QR or paste their npub.');
      return;
    }

    setScannedPubkey(hex);
    setHexInput(hex);
    setScannedAvatarKey(avatarKey);
    setMode('hex-paste');

    // Prefill display name: kind-0 first, embedded payload name as fallback.
    const name = await resolveScannedContactName(hex, relayUrl, payloadName);
    // Don't clobber a name the user typed on the confirm screen while the kind-0
    // fetch was in flight — only prefill into an empty field. Functional update
    // reads the latest state, not the stale closure value.
    if (name) setDisplayName(prev => (prev.trim() ? prev : name));
  }

  async function handleQRConfirm() {
    if (saving) return;
    setError('');
    const result = parsePubkeyInput(scannedPubkey || hexInput);
    if ('error' in result) { setError(result.error); return; }
    if (isOwnKey(result.hex, ownerPubkeyHex)) {
      setError("That's your own key — you can't add yourself as a ken.");
      return;
    }
    const name = truncate(displayName.trim(), 100) || undefined;
    let entry: KenEntry;
    try {
      entry = pinKen({
        pubkeyHex: result.hex,
        ownerPubkeyHex,
        displayName: name,
        provenance: { source: 'in-person', locator: 'qr', confirmedAt: Math.floor(Date.now() / 1000) },
      });
    } catch (e) {
      setError(humaniseKenAddError(e));
      return;
    }
    if (proofEnabled) {
      const c = buildKeyControlChallenge();
      setChallenge(c);
      setPendingEntry(entry);
      setMode('key-control');
    } else {
      await saveEntry(entry);
    }
  }

  // ── NIP-05 flow ────────────────────────────────────────────────────────────

  async function handleNip05Submit() {
    if (nip05Busy) return;
    setError('');
    const shaped = nip05Input.trim();
    const shapeErr = validateNip05Shape(shaped);
    if (shapeErr) { setError(shapeErr); return; }

    setNip05Busy(true);
    try {
      const entry = await pinKenFromNip05(shaped, ownerPubkeyHex, globalThis.fetch);
      if (proofEnabled) {
        const c = buildKeyControlChallenge();
        setChallenge(c);
        setPendingEntry(entry);
        setMode('key-control');
      } else {
        await saveEntry(entry);
      }
    } catch (e) {
      setError(humaniseKenAddError(e));
    } finally {
      setNip05Busy(false);
    }
  }

  // ── key-control flow ───────────────────────────────────────────────────────

  async function handleKeyControlVerify() {
    if (saving || !pendingEntry || !challenge) return;
    setError('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(signedEventJson.trim());
    } catch {
      setError('Could not parse that as JSON. Paste the full signed Nostr event object.');
      return;
    }
    // Runtime shape guard — verifyKeyControl expects a NostrEvent
    if (typeof parsed !== 'object' || parsed === null || !('id' in parsed) || !('sig' in parsed) || !('pubkey' in parsed)) {
      setError('The pasted value does not look like a Nostr event (needs id, sig, pubkey fields).');
      return;
    }
    const result = verifyKeyControl(pendingEntry, challenge.nonce, parsed as Parameters<typeof verifyKeyControl>[2]);
    if (!result.ok) {
      setError(`Key-control check failed: ${result.reason ?? 'unknown reason'}.`);
      return;
    }
    await saveEntry(pendingEntry);
  }

  // ── render ─────────────────────────────────────────────────────────────────

  if (mode === 'choose') {
    return (
      <div className="fade-in" role="main">
        <div className="section">
          <h2 style={{ marginBottom: 4 }}>How do you know their key?</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 12 }}>
            Add a contact — no shared secret needed.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn btn-primary" onClick={() => { setError(''); setMode('nip05'); }}>
              NIP-05 address (name@domain.com)
            </button>
            <button className="btn btn-secondary" onClick={() => { setError(''); setMode('hex-paste'); }}>
              Paste an npub
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setError('');
                if (hasPermission === null) requestPermission().then(() => setMode('qr-scan'));
                else setMode('qr-scan');
              }}
            >
              Scan a QR code
            </button>
          </div>
        </div>
        <button className="btn btn-ghost" onClick={onBack} style={{ marginTop: 8 }}>
          Cancel
        </button>
      </div>
    );
  }

  if (mode === 'nip05') {
    return (
      <div className="fade-in" role="main">
        <h2 style={{ marginBottom: 8 }}>NIP-05 address</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16 }}>
          Enter their NIP-05 identifier. The key it resolves to is pinned automatically.
        </p>
        {error && (
          <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
            {error}
          </div>
        )}
        <input
          className="input"
          placeholder="name@domain.com"
          value={nip05Input}
          onChange={e => setNip05Input(e.target.value)}
          autoFocus
          autoCapitalize="none"
          inputMode="email"
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, fontSize: '0.9rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={proofEnabled}
            onChange={e => setProofEnabled(e.target.checked)}
            style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
          />
          Prove they control this key (key-control challenge)
        </label>
        <button
          className="btn btn-primary"
          onClick={handleNip05Submit}
          disabled={!nip05Input.trim() || nip05Busy}
          style={{ marginTop: 16 }}
        >
          {nip05Busy ? 'Resolving…' : 'Resolve & pin'}
        </button>
        <button className="btn btn-ghost" onClick={() => { setMode('choose'); setError(''); }} style={{ marginTop: 8 }}>
          Back
        </button>
      </div>
    );
  }

  if (mode === 'qr-scan') {
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
        <QRScanner onScan={handleQRScan} active={hasPermission === true} />
        {hasPermission === null && (
          <button className="btn btn-primary" onClick={requestPermission} style={{ marginTop: 16 }}>
            Allow camera access
          </button>
        )}
        <button className="btn btn-ghost" onClick={() => { setMode('choose'); setError(''); }} style={{ marginTop: 12 }}>
          Back
        </button>
      </div>
    );
  }

  // Hex paste — also reused as the confirm step after a QR scan
  if (mode === 'hex-paste') {
    const fromQR = !!scannedPubkey;
    return (
      <div className="fade-in" role="main">
        <h2 style={{ marginBottom: 8 }}>{fromQR ? 'Confirm scanned key' : 'Paste their public key'}</h2>
        {!fromQR && (
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16 }}>
            Enter their public address (npub1…).
          </p>
        )}
        {error && (
          <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
            {error}
          </div>
        )}
        {fromQR && scannedPubkey && (
          <ScannedAvatarPreview pubkey={scannedPubkey} relayUrl={relayUrl} encryptionKey={encryptionKey} overrideShareKey={scannedAvatarKey} name={displayName} />
        )}
        <input
          className="input"
          placeholder="npub1…"
          value={fromQR ? hexToNpub(scannedPubkey) : hexInput}
          onChange={e => setHexInput(e.target.value.trim())}
          autoFocus={!fromQR}
          autoCapitalize="none"
          spellCheck={false}
          style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}
          readOnly={fromQR}
        />
        <input
          className="input"
          placeholder="Display name (optional)"
          value={displayName}
          onChange={e => setDisplayName(e.target.value)}
          maxLength={100}
          style={{ marginTop: 8 }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, fontSize: '0.9rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={proofEnabled}
            onChange={e => setProofEnabled(e.target.checked)}
            style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
          />
          Prove they control this key (key-control challenge)
        </label>
        <button
          className="btn btn-primary"
          onClick={fromQR ? handleQRConfirm : handleHexSubmit}
          disabled={saving || !hexInput.trim()}
          style={{ marginTop: 16 }}
        >
          {saving ? 'Saving…' : 'Pin key'}
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            setScannedPubkey('');
            setHexInput('');
            setScannedAvatarKey(undefined);
            setError('');
            setMode(fromQR ? 'qr-scan' : 'choose');
          }}
          style={{ marginTop: 8 }}
        >
          Back
        </button>
      </div>
    );
  }

  if (mode === 'key-control') {
    return (
      <div className="fade-in" role="main">
        <h2 style={{ marginBottom: 8 }}>Key-control challenge</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16 }}>
          Ask them to sign a Nostr event whose <strong>content</strong> is exactly the nonce below,
          then paste the full signed event JSON here.
        </p>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
            Nonce (event content must be exactly this)
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.8rem',
              wordBreak: 'break-all',
              padding: '8px 10px',
              background: 'var(--bg-secondary)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)',
              userSelect: 'all',
            }}
          >
            {challenge?.nonce}
          </div>
        </div>
        {error && (
          <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
            {error}
          </div>
        )}
        <textarea
          className="input"
          rows={6}
          placeholder='{"id":"...","pubkey":"...","sig":"...","content":"<nonce>","kind":1,...}'
          value={signedEventJson}
          onChange={e => setSignedEventJson(e.target.value)}
          style={{ resize: 'none', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}
          autoFocus
        />
        <button
          className="btn btn-primary"
          onClick={handleKeyControlVerify}
          disabled={saving || !signedEventJson.trim()}
          style={{ marginTop: 12 }}
        >
          {saving ? 'Verifying…' : 'Verify & save'}
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => { setMode('choose'); setError(''); setSignedEventJson(''); setChallenge(null); setPendingEntry(null); }}
          style={{ marginTop: 8 }}
        >
          Cancel
        </button>
      </div>
    );
  }

  if (mode === 'success') {
    const entry = pendingEntry;
    return (
      <div className="fade-in" role="main" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '3rem', marginBottom: 8 }}>&#10003;</div>
        <h2 style={{ marginBottom: 8 }}>
          {entry?.displayName ? truncate(entry.displayName, 40) : 'Key'} added
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 8 }}>
          Pinned as a <strong>ken</strong> — one-way recognition, no shared secret.
        </p>
        {entry && (
          <ScannedAvatarPreview pubkey={entry.pubkey} relayUrl={relayUrl} encryptionKey={encryptionKey} name={entry.displayName ?? ''} />
        )}
        {entry && (
          <div style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', wordBreak: 'break-all', marginBottom: 24, padding: '0 16px' }}>
            {shortNpub(entry.pubkey)}
          </div>
        )}
        <button className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    );
  }

  return null;
}

function ScannedAvatarPreview({ pubkey, relayUrl, encryptionKey, overrideShareKey, name }: {
  pubkey: string; relayUrl: string; encryptionKey: string | null; overrideShareKey?: string; name: string;
}) {
  const url = useContactAvatar(pubkey, relayUrl, encryptionKey, overrideShareKey);
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
      <ContactAvatar url={url} name={name} pubkey={pubkey} size={72} />
    </div>
  );
}
