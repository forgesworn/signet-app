import { shortNpub } from '../lib/signet';
/**
 * Paired-child onboarding.
 *
 * Entry flow when a child's device is setting itself up as a paired bunker
 * client against the guardian phone. Distinct from the "create new
 * identity" and "import mnemonic" paths in `Onboarding.tsx` — the child
 * never sees a mnemonic; their signing keys stay on the guardian phone.
 *
 * Steps:
 *   1. Welcome — explain what pairing means
 *   2. Scan / paste the pairing URI the guardian generated
 *   3. Confirm — "You'll be signed in as {name}. Your guardian will approve
 *      sign-ins." (no way to proceed without an explicit tap)
 *   4. Parent calls `onConfirm(parsed)` which persists the record + chains
 *      into SetupAuth for PIN/biometric.
 */

import { useEffect, useRef, useState } from 'react';
import { QRScanner } from '../components/QRScanner';
import { parsePairingURI, type PairingURIParams } from '../lib/pairing-uri';
import { parseChildPairUri, type ChildPairOffer } from '../lib/child-pair-wire';
import { ChildDirectPairError } from '../lib/child-direct-pairing';
import { CHILD_SIDE_COPY as KID } from '../lib/child-device-copy';

/** Plain-English copy for a failed child-direct pairing run. */
function directErrorCopy(err: unknown): string {
  if (!(err instanceof ChildDirectPairError)) return KID.errors.generic;
  if (err.code === 'timeout') return KID.errors.timeout;
  if (err.code === 'publish') return KID.errors.publish;
  if (err.code === 'signer') return KID.errors.signer;
  if (err.code === 'refused') return KID.errors.refused[err.reason ?? 'other'] ?? KID.errors.refused.other;
  return KID.errors.generic;
}

export interface DirectPairControl {
  onCheckWords(words: string[]): void;
  signal: AbortSignal;
}

interface Props {
  /**
   * Called when the user confirms a validated pairing. Parent persists the
   * raw URI (as scanned / pasted) so the exact encoding the guardian
   * generated round-trips to `BunkerSigner.fromBunker` without risk of
   * re-encoding drift (URLSearchParams vs `encodeURIComponent`, etc.).
   */
  onConfirm: (parsed: PairingURIParams, rawUri: string) => Promise<void>;
  onCancel: () => void;
  /**
   * Re-pair mode. When set, the scanned QR's
   * `dependantPubkey` MUST match this value — otherwise the user would
   * silently swap identity (kid scans a code intended for a different
   * kid, ends up signing in as them). Mismatch shows a clear error and
   * stays on the capture step. Also re-frames the welcome / confirm
   * copy so it reads as "re-pair" rather than first-time onboarding.
   */
  expectedDependantPubkey?: string;
  /**
   * Child-direct Heartwood pairing (`signet-child:` codes, spec §4). Runs the
   * whole pairing — request, check words, guardian reply, handshake — and
   * persists only on success. Absent ⇒ `signet-child:` codes are refused.
   */
  onStartDirect?: (offer: ChildPairOffer, ctl: DirectPairControl) => Promise<void>;
}

type Step =
  | { kind: 'welcome' }
  | { kind: 'capture'; mode: 'scan' | 'paste'; error: string | null }
  | { kind: 'confirm'; parsed: PairingURIParams; rawUri: string; saving: boolean; error: string | null }
  | { kind: 'confirm-direct'; offer: ChildPairOffer }
  | { kind: 'pairing-direct'; offer: ChildPairOffer; words: string[] | null; error: string | null };

export function PairChildOnboarding({ onConfirm, onCancel, expectedDependantPubkey, onStartDirect }: Props) {
  const [step, setStep] = useState<Step>({ kind: 'welcome' });
  const abortRef = useRef<AbortController | null>(null);
  // Leaving the page stops a pairing still in flight (nothing was saved yet).
  useEffect(() => () => abortRef.current?.abort(), []);
  const [pasteDraft, setPasteDraft] = useState('');
  const isRepair = !!expectedDependantPubkey;

  const enterCapture = (mode: 'scan' | 'paste') => {
    setPasteDraft('');
    setStep({ kind: 'capture', mode, error: null });
  };

  const captureError = (msg: string) => setStep(prev => prev.kind === 'capture' ? { ...prev, error: msg } : prev);

  const startDirect = (offer: ChildPairOffer) => {
    if (!onStartDirect) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setStep({ kind: 'pairing-direct', offer, words: null, error: null });
    onStartDirect(offer, {
      signal: ac.signal,
      onCheckWords: (words) => {
        if (!ac.signal.aborted) setStep(prev => prev.kind === 'pairing-direct' ? { ...prev, words } : prev);
      },
    }).catch((err: unknown) => {
      if (ac.signal.aborted) return;
      setStep(prev => prev.kind === 'pairing-direct' ? { ...prev, error: directErrorCopy(err) } : prev);
    });
  };

  const cancelDirect = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStep({ kind: 'welcome' });
  };

  const handleRawURI = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('signet-child:')) {
      const offer = onStartDirect ? parseChildPairUri(trimmed, Math.floor(Date.now() / 1000)) : null;
      if (!offer) { captureError(KID.errors.invalid); return; }
      if (expectedDependantPubkey && offer.dependant !== expectedDependantPubkey.toLowerCase()) {
        captureError(KID.errors.wrongAccount);
        return;
      }
      setStep({ kind: 'confirm-direct', offer });
      return;
    }
    const parsed = parsePairingURI(trimmed);
    if (!parsed) {
      setStep(prev => prev.kind === 'capture'
        ? { ...prev, error: "That doesn't look like a valid pairing code. Check you have the whole thing." }
        : prev);
      return;
    }
    // Re-pair identity-match gate. Refuse to swap identity silently — a
    // mismatched code is either a code intended for a different kid or
    // an attempt to hijack this device. Either way the right answer is
    // "no".
    if (expectedDependantPubkey && parsed.dependantPubkey.toLowerCase() !== expectedDependantPubkey.toLowerCase()) {
      setStep(prev => prev.kind === 'capture'
        ? { ...prev, error: "This code is for a different account. Ask your guardian to generate a new code for you specifically." }
        : prev);
      return;
    }
    setStep({ kind: 'confirm', parsed, rawUri: trimmed, saving: false, error: null });
  };

  const handleConfirm = async () => {
    if (step.kind !== 'confirm') return;
    setStep({ ...step, saving: true, error: null });
    try {
      await onConfirm(step.parsed, step.rawUri);
      // Parent navigates to SetupAuth / home. We unmount either way.
    } catch (err) {
      setStep({
        ...step,
        saving: false,
        error: err instanceof Error ? err.message : 'Could not complete pairing',
      });
    }
  };

  if (step.kind === 'welcome') {
    return (
      <div className="fade-in" style={{ padding: 24, maxWidth: 460, margin: '0 auto' }}>
        <h1 style={{ marginBottom: 12 }}>{isRepair ? 'Re-pair with your guardian' : 'Pair with your guardian'}</h1>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
          {isRepair
            ? "Your guardian generated a fresh code on their phone (usually because they got a new device). Scan or paste it here and this app will reconnect to them."
            : "Your guardian generated a code on their phone. Scan or paste it here and this device becomes your Signet."}
        </p>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 24, fontSize: '0.9rem' }}>
          {isRepair
            ? "Your identity, PIN, and history stay the same — only the connection to your guardian changes."
            : "Sign-ins from this device go to your guardian for approval (unless they've said you can handle them yourself)."}
        </p>
        <button className="btn btn-primary" onClick={() => enterCapture('scan')} style={{ width: '100%', marginBottom: 8 }}>
          Scan pairing code
        </button>
        <button className="btn" onClick={() => enterCapture('paste')} style={{ width: '100%', marginBottom: 16 }}>
          Paste pairing code
        </button>
        <button className="btn btn-ghost" onClick={onCancel} style={{ width: '100%' }}>
          Back
        </button>
      </div>
    );
  }

  if (step.kind === 'capture' && step.mode === 'scan') {
    return (
      <div className="fade-in" style={{ padding: 24, maxWidth: 460, margin: '0 auto' }}>
        <h2 style={{ marginBottom: 12 }}>Scan the code</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 16 }}>
          Point the camera at the pairing QR on your guardian's phone.
        </p>
        <div style={{ marginBottom: 16 }}>
          <QRScanner active onScan={handleRawURI} />
        </div>
        {step.error && (
          <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: 12 }}>
            {step.error}
          </p>
        )}
        <button className="btn" onClick={() => enterCapture('paste')} style={{ width: '100%', marginBottom: 8 }}>
          Paste instead
        </button>
        <button className="btn btn-ghost" onClick={() => setStep({ kind: 'welcome' })} style={{ width: '100%' }}>
          Back
        </button>
      </div>
    );
  }

  if (step.kind === 'capture' && step.mode === 'paste') {
    const canSubmit = pasteDraft.trim().startsWith('bunker://') || (!!onStartDirect && pasteDraft.trim().startsWith('signet-child:'));
    return (
      <div className="fade-in" style={{ padding: 24, maxWidth: 460, margin: '0 auto' }}>
        <h2 style={{ marginBottom: 12 }}>Paste the code</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 12 }}>
          Your guardian can send you the pairing code — paste it here. It starts with
          {' '}<code style={{ background: 'var(--bg-card-alt)', padding: '2px 4px', borderRadius: 3 }}>bunker://</code>
          {onStartDirect && <> or <code style={{ background: 'var(--bg-card-alt)', padding: '2px 4px', borderRadius: 3 }}>signet-child:</code></>}.
        </p>
        <textarea
          value={pasteDraft}
          onChange={e => setPasteDraft(e.target.value)}
          placeholder="bunker://..."
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          rows={6}
          style={{
            width: '100%',
            padding: 12,
            fontFamily: 'var(--font-mono)',
            fontSize: '0.8rem',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            background: 'var(--bg-card-alt)',
            color: 'var(--text-primary)',
            marginBottom: 12,
            boxSizing: 'border-box',
          }}
        />
        {step.error && (
          <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: 12 }}>
            {step.error}
          </p>
        )}
        <button
          className="btn btn-primary"
          disabled={!canSubmit}
          onClick={() => handleRawURI(pasteDraft)}
          style={{ width: '100%', marginBottom: 8 }}
        >
          Continue
        </button>
        <button className="btn" onClick={() => enterCapture('scan')} style={{ width: '100%', marginBottom: 8 }}>
          Scan instead
        </button>
        <button className="btn btn-ghost" onClick={() => setStep({ kind: 'welcome' })} style={{ width: '100%' }}>
          Back
        </button>
      </div>
    );
  }

  if (step.kind === 'confirm') {
    return (
      <div className="fade-in" style={{ padding: 24, maxWidth: 460, margin: '0 auto' }}>
        <h2 style={{ marginBottom: 12 }}>{isRepair ? 'Reconnecting as' : "You're about to sign in as"}</h2>
        <div className="card section" style={{ padding: 20, marginBottom: 20 }}>
          <div style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: 4 }}>
            {step.parsed.dependantName}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
            {shortNpub(step.parsed.dependantPubkey)}
          </div>
        </div>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, fontSize: '0.9rem', marginBottom: 12 }}>
          Sign-ins from this device will go to your guardian for approval. Once they set things up,
          you'll be able to sign into some apps yourself.
        </p>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, fontSize: '0.9rem', marginBottom: 24 }}>
          Your signing keys stay on your guardian's phone, not here.
        </p>
        {step.error && (
          <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: 12 }}>
            {step.error}
          </p>
        )}
        <button
          className="btn btn-primary"
          disabled={step.saving}
          onClick={handleConfirm}
          style={{ width: '100%', marginBottom: 8 }}
        >
          {step.saving ? 'Setting up…' : isRepair ? 'Reconnect' : "That's me"}
        </button>
        <button
          className="btn"
          disabled={step.saving}
          onClick={() => setStep({ kind: 'welcome' })}
          style={{ width: '100%' }}
        >
          {isRepair ? 'Back' : 'Not me — back'}
        </button>
      </div>
    );
  }

  if (step.kind === 'confirm-direct') {
    return (
      <div className="fade-in" style={{ padding: 24, maxWidth: 460, margin: '0 auto' }}>
        <h2 style={{ marginBottom: 12 }}>{KID.confirmHeading}</h2>
        <div className="card section" style={{ padding: 20, marginBottom: 20 }}>
          <div style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: 4 }}>{step.offer.name}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
            {KID.confirmGuardian(shortNpub(step.offer.guardian))}
          </div>
        </div>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, fontSize: '0.9rem', marginBottom: 24 }}>{KID.confirmBody}</p>
        <button className="btn btn-primary" onClick={() => startDirect(step.offer)} style={{ width: '100%', marginBottom: 8 }}>
          {KID.confirmGo}
        </button>
        <button className="btn" onClick={() => setStep({ kind: 'welcome' })} style={{ width: '100%' }}>
          {isRepair ? 'Back' : 'Not me — back'}
        </button>
      </div>
    );
  }

  if (step.kind === 'pairing-direct') {
    return (
      <div className="fade-in" style={{ padding: 24, maxWidth: 460, margin: '0 auto' }}>
        {step.error ? (
          <>
            <p style={{ color: 'var(--danger)', lineHeight: 1.5, marginBottom: 16 }}>{step.error}</p>
            <button className="btn btn-primary" onClick={() => startDirect(step.offer)} style={{ width: '100%', marginBottom: 8 }}>
              Try again
            </button>
            <button className="btn btn-ghost" onClick={cancelDirect} style={{ width: '100%' }}>{KID.cancel}</button>
          </>
        ) : step.words ? (
          <>
            <h2 style={{ marginBottom: 12 }}>{KID.checkHeading}</h2>
            <ol className="card section" style={{ padding: '16px 16px 16px 40px', marginBottom: 16, fontSize: '1.25rem', fontWeight: 600 }}>
              {step.words.map((w, i) => <li key={i}>{w}</li>)}
            </ol>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, fontSize: '0.9rem', marginBottom: 8 }}>{KID.checkBody}</p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: 24 }}>{KID.waiting}</p>
            <button className="btn btn-ghost" onClick={cancelDirect} style={{ width: '100%' }}>{KID.cancel}</button>
          </>
        ) : (
          <>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>{KID.pairing}</p>
            <button className="btn btn-ghost" onClick={cancelDirect} style={{ width: '100%' }}>{KID.cancel}</button>
          </>
        )}
      </div>
    );
  }

  return null;
}
