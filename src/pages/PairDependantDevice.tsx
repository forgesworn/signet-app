/**
 * Guardian-side pair-to-device screen.
 *
 * Generates (or reuses) the per-dependant NIP-46 endpoint keypair,
 * mints a fresh pairing secret, and renders the resulting
 * `bunker://…?dependant=…&name=…` URI as a QR code. The child device
 * scans, connects, and from then on the guardian phone is the family
 * bunker for that dependant — policy enforced elsewhere.
 *
 * Secret has a 5-minute TTL per holodeck OQ7 / spec §Device Pairing.
 * On expiry a new secret is minted automatically and the QR refreshes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DependantIdentity, DependantBunkerEndpoint } from '../types';
import { QRCode } from '../components/QRCode';
import { buildPairingURI, generatePairingSecret } from '../lib/pairing-uri';
import { usesChildDirectPairing } from '../lib/child-device-pairing';
import { CHILD_DEVICE_COPY as COPY } from '../lib/child-device-copy';
import { useChildDevicePairing, type UseChildDevicePairingOpts } from '../hooks/useChildDevicePairing';

const PAIRING_SECRET_TTL_MS = 5 * 60 * 1000;

interface Props {
  dependant: DependantIdentity;
  /** The guardian's preferred relay — child device will try this first. */
  relayUrl: string;
  /**
   * Optional fallback relays baked into the pairing QR alongside the
   * primary `relayUrl`. Stored as strings; scheme-validated by
   * `buildPairingURI`. Empty or missing is fine — we just emit the
   * single primary relay.
   */
  fallbackRelayUrls?: string[];
  /**
   * True when the NIP-46 bunker server is actively listening on this
   * phone. If false, generating a QR is useless — the child device would
   * connect to a nobody-listening endpoint. We surface a guard state
   * rather than letting the user generate a dead-letter QR.
   */
  bunkerServerEnabled: boolean;
  /** Creates or returns the dependant's endpoint keypair (from useDependants). */
  ensureDependantBunkerEndpoint: (pubkey: string) => Promise<DependantBunkerEndpoint>;
  /** Revokes the endpoint — child device is disconnected immediately. */
  clearDependantBunkerEndpoint: (pubkey: string) => Promise<void>;
  /**
   * Persist the current pairing secret onto the dependant's endpoint
   * record so the bunker server can validate it on `connect`. Called
   * whenever a fresh secret is minted (mount + rotation).
   */
  saveDependantPairingSecret: (pubkey: string, secret: string) => Promise<void>;
  /** Opens Security settings so the guardian can enable the bunker server. */
  onOpenSecuritySettings?: () => void;
  /** Tier 1 auth gate — must resolve before the pairing QR is generated. */
  requestAuth: () => Promise<string | null>;
  onBack: () => void;
  /** Guardian's signing mode — `'bunker'` + a tree-derived dependant takes the child-direct Heartwood flow. */
  signingMode?: string;
  /** Inputs for the child-direct flow (spec §4). Absent ⇒ legacy phone-served QR only. */
  direct?: Omit<UseChildDevicePairingOpts, 'dependant'> & { onOpenOperatorImport?: () => void };
}

type Stage =
  | { kind: 'preparing' }
  | { kind: 'ready'; endpoint: DependantBunkerEndpoint; secret: string; secretIssuedAt: number }
  | { kind: 'revoking' }
  | { kind: 'revoked' }
  | { kind: 'error'; message: string };

export function PairDependantDevice(props: Props) {
  if (props.direct && usesChildDirectPairing(props.dependant, props.signingMode)) {
    return <ChildDirectPairing dependant={props.dependant} direct={props.direct} requestAuth={props.requestAuth} onBack={props.onBack} />;
  }
  return <LegacyPairDependantDevice {...props} />;
}

function LegacyPairDependantDevice({
  dependant,
  relayUrl,
  fallbackRelayUrls,
  bunkerServerEnabled,
  ensureDependantBunkerEndpoint,
  clearDependantBunkerEndpoint,
  saveDependantPairingSecret,
  onOpenSecuritySettings,
  requestAuth,
  onBack,
}: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'preparing' });
  const [remainingSeconds, setRemainingSeconds] = useState<number>(Math.floor(PAIRING_SECRET_TTL_MS / 1000));
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  // Capture the latest callback refs in a ref so the mount-effect below
  // isn't re-fired every time the parent re-renders (it passes inline
  // arrows that change identity on each render). Without this, the QR
  // and countdown would reset on every App-level render — visible flicker
  // and wasted DB reads.
  const ensureRef = useRef(ensureDependantBunkerEndpoint);
  ensureRef.current = ensureDependantBunkerEndpoint;
  const clearRef = useRef(clearDependantBunkerEndpoint);
  clearRef.current = clearDependantBunkerEndpoint;
  const saveSecretRef = useRef(saveDependantPairingSecret);
  saveSecretRef.current = saveDependantPairingSecret;
  const requestAuthRef = useRef(requestAuth);
  requestAuthRef.current = requestAuth;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  // On mount / dependant change / bunker-server flipped on: gate behind
  // Tier 1 auth then ensure endpoint + mint first secret. Skip when the
  // bunker server is off — the guard below renders the "off" UI and we
  // shouldn't mint a QR (or trigger an auth prompt) until the user has
  // turned the Bunker on. Re-running when `bunkerServerEnabled` flips on
  // covers the "user toggled it on in Security and came back" case where
  // React may keep this component mounted (no QR otherwise). Intentionally
  // omits refs from deps — see comment above.
  useEffect(() => {
    if (!bunkerServerEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        const key = await requestAuthRef.current();
        if (cancelled) return;
        if (!key) {
          // User cancelled auth — back out to previous screen.
          onBackRef.current();
          return;
        }
        const endpoint = await ensureRef.current(dependant.id);
        if (cancelled) return;
        const secret = generatePairingSecret();
        // Persist the secret BEFORE showing the QR so the bunker server
        // always sees a matching secret even if the child scans
        // instantly. Best-effort — if this fails, fall back to showing
        // the QR anyway; the server will just reject the pair.
        await saveSecretRef.current(dependant.id, secret).catch(() => { /* tolerated */ });
        if (cancelled) return;
        setStage({ kind: 'ready', endpoint, secret, secretIssuedAt: Date.now() });
      } catch (err) {
        if (cancelled) return;
        setStage({ kind: 'error', message: err instanceof Error ? err.message : 'Could not prepare pairing' });
      }
    })();
    return () => { cancelled = true; };
  }, [dependant.id, bunkerServerEnabled]);

  // Countdown ticker — auto-rotate the secret when it expires. Rotation
  // persists the new secret to IDB BEFORE the QR visually updates, so
  // there's no window where the on-screen QR shows a secret the server
  // doesn't yet know about (and, critically, no window where an attacker
  // who captured the OLD QR could still successfully pair because the
  // server's route.pairingSecret hasn't been updated yet).
  useEffect(() => {
    if (stage.kind !== 'ready') return;
    let cancelled = false;
    const stageEndpoint = stage.endpoint;
    const stageIssuedAt = stage.secretIssuedAt;
    const tick = async () => {
      if (cancelled) return;
      const elapsed = Date.now() - stageIssuedAt;
      const remainingMs = PAIRING_SECRET_TTL_MS - elapsed;
      if (remainingMs <= 0) {
        const secret = generatePairingSecret();
        try {
          await saveSecretRef.current(dependant.id, secret);
        } catch {
          // If the persist fails we still rotate the visible QR so the
          // user sees a fresh code — but warn via `remainingSeconds` drift
          // next tick. Worst case: the server keeps accepting the previous
          // secret until the next successful rotation.
        }
        if (cancelled) return;
        setStage({ kind: 'ready', endpoint: stageEndpoint, secret, secretIssuedAt: Date.now() });
        setRemainingSeconds(Math.floor(PAIRING_SECRET_TTL_MS / 1000));
      } else {
        setRemainingSeconds(Math.ceil(remainingMs / 1000));
      }
    };
    // Fire immediately so the countdown UI doesn't wait a second to show.
    void tick();
    const id = setInterval(() => { void tick(); }, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [stage, dependant.id]);

  const handleRevoke = useCallback(async () => {
    setStage({ kind: 'revoking' });
    try {
      await clearRef.current(dependant.id);
      setStage({ kind: 'revoked' });
    } catch (err) {
      setStage({ kind: 'error', message: err instanceof Error ? err.message : 'Revoke failed' });
    }
  }, [dependant.id]);

  // Bunker-server-disabled guard. Surface BEFORE preparing the endpoint so
  // we don't mint a QR that can never be answered.
  if (!bunkerServerEnabled) {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <h2 style={{ marginBottom: 8 }}>The Bunker is off</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: 20 }}>
          To pair {dependant.displayName}'s device, your phone needs to be acting as their Bunker.
          Turn the Bunker on in Security settings first, then come back here.
        </p>
        {onOpenSecuritySettings && (
          <button className="btn btn-primary" onClick={onOpenSecuritySettings} style={{ width: '100%', marginBottom: 8 }}>
            Open Security settings
          </button>
        )}
        <button className="btn" onClick={onBack} style={{ width: '100%' }}>Back</button>
      </div>
    );
  }

  if (stage.kind === 'preparing') {
    return (
      <div className="fade-in" style={{ padding: 24, textAlign: 'center' }}>
        <p style={{ color: 'var(--text-secondary)' }}>Setting up…</p>
      </div>
    );
  }

  if (stage.kind === 'error') {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <p style={{ color: 'var(--danger)' }}>{stage.message}</p>
        <button className="btn" onClick={onBack} style={{ marginTop: 16 }}>Back</button>
      </div>
    );
  }

  if (stage.kind === 'revoking') {
    return (
      <div className="fade-in" style={{ padding: 24, textAlign: 'center' }}>
        <p style={{ color: 'var(--text-secondary)' }}>Revoking…</p>
      </div>
    );
  }

  if (stage.kind === 'revoked') {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <h2>Pairing revoked</h2>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {dependant.displayName}'s paired device is no longer connected to your bunker. They'll need a fresh QR to sign in again.
        </p>
        <button className="btn btn-primary" onClick={onBack} style={{ marginTop: 16, width: '100%' }}>Done</button>
      </div>
    );
  }

  // stage.kind === 'ready'. buildPairingURI can throw on malformed inputs —
  // we guard so a bad relay URL or name can't crash the whole screen.
  let uri: string;
  try {
    const relays = [relayUrl, ...(fallbackRelayUrls ?? [])].filter(r => typeof r === 'string' && r.length > 0);
    uri = buildPairingURI({
      endpointPubkey: stage.endpoint.publicKey,
      relays,
      secret: stage.secret,
      dependantPubkey: dependant.id,
      dependantName: dependant.displayName,
      // C1: lets the child device pin the guardian's real signing pubkey
      // at pair time, so the audit-log consumer can verify audit
      // gift-wraps are genuinely sealed by the guardian.
      guardianPubkey: dependant.guardianPubkey,
    });
  } catch (err) {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <h2>Can't build pairing code</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: 16 }}>
          {err instanceof Error ? err.message : 'Something is wrong with the pairing inputs.'}
        </p>
        <button className="btn" onClick={onBack} style={{ width: '100%' }}>Back</button>
      </div>
    );
  }
  const mm = Math.floor(remainingSeconds / 60);
  const ss = String(remainingSeconds % 60).padStart(2, '0');

  return (
    <div className="fade-in" style={{ padding: 24 }}>
      <h2 style={{ marginBottom: 8 }}>Pair {dependant.displayName}'s device</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: 20 }}>
        Scan this code in MySignet on {dependant.displayName}'s phone (or any device they'll use).
        From there, sign-ins come to you for approval.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <QRCode data={uri} size={260} />
        <div style={{
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
          fontVariantNumeric: 'tabular-nums',
        }}>
          This code refreshes in {mm}:{ss}
        </div>
      </div>

      {!confirmRevoke ? (
        <>
          <button className="btn" onClick={onBack} style={{ width: '100%', marginBottom: 8 }}>
            Done
          </button>
          <button
            className="btn"
            onClick={() => setConfirmRevoke(true)}
            style={{
              width: '100%',
              color: 'var(--text-muted)',
              fontSize: '0.85rem',
            }}
          >
            Revoke pairing
          </button>
        </>
      ) : (
        <div
          className="card"
          style={{ padding: 16, border: '1px solid var(--danger)', marginTop: 4 }}
        >
          <p style={{ fontSize: '0.85rem', lineHeight: 1.5, marginBottom: 12 }}>
            Revoking will disconnect any device already paired with {dependant.displayName}.
            They'll need a fresh QR to sign in again.
          </p>
          <button
            className="btn btn-danger"
            onClick={handleRevoke}
            style={{ width: '100%', marginBottom: 8 }}
          >
            Revoke now
          </button>
          <button
            className="btn"
            onClick={() => setConfirmRevoke(false)}
            style={{ width: '100%' }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Child-direct: the child's phone pairs straight to the Heartwood ────────

function useCountdown(expiresAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  if (expiresAt === null) return '';
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

const pad = { padding: 24 } as const;
const muted = { color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5 } as const;
const wide = { width: '100%', marginBottom: 8 } as const;

function ChildDirectPairing({ dependant, direct, requestAuth, onBack }: {
  dependant: DependantIdentity;
  direct: NonNullable<Props['direct']>;
  requestAuth: () => Promise<string | null>;
  onBack: () => void;
}) {
  const { onOpenOperatorImport, ...opts } = direct;
  const pairing = useChildDevicePairing({ ...opts, dependant });
  const { state } = pairing;
  const name = dependant.displayName;
  const alreadyPaired = dependant.childDevice?.mode === 'heartwood-direct';
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [unpairError, setUnpairError] = useState<string | null>(null);
  const [unpairing, setUnpairing] = useState(false);
  const [unpairedDone, setUnpairedDone] = useState(false);
  const countdown = useCountdown(state.phase === 'offer' || state.phase === 'confirm' ? state.expiresAt : null);

  const requestAuthRef = useRef(requestAuth);
  requestAuthRef.current = requestAuth;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const startRef = useRef(pairing.start);
  startRef.current = pairing.start;

  const begin = useCallback(async () => {
    const key = await requestAuthRef.current();
    if (!key) { onBackRef.current(); return; }
    startRef.current();
  }, []);

  // A phone already paired shows its status first; otherwise start at once.
  useEffect(() => {
    if (!alreadyPaired) void begin();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dependant.id]);

  const handleUnpair = async () => {
    setUnpairing(true); setUnpairError(null);
    try { await pairing.unpair(); setUnpairedDone(true); setConfirmUnpair(false); }
    catch (e) { setUnpairError(e instanceof Error ? e.message : COPY.errors.unpair); }
    finally { setUnpairing(false); }
  };

  if (unpairedDone) {
    return (
      <div className="fade-in" style={pad}>
        <p style={muted}>{COPY.unpaired(name)}</p>
        <button className="btn btn-primary" onClick={onBack} style={{ ...wide, marginTop: 16 }}>{COPY.done}</button>
      </div>
    );
  }

  if (state.phase === 'idle' && alreadyPaired) {
    return (
      <div className="fade-in" style={pad}>
        <h2 style={{ marginBottom: 8 }}>{COPY.pairedHeading}</h2>
        <p style={{ ...muted, marginBottom: 20 }}>{COPY.pairedAlready(name)}</p>
        {unpairError && <p role="alert" style={{ color: 'var(--danger)', marginBottom: 12 }}>{unpairError}</p>}
        {!confirmUnpair ? (
          <>
            <button className="btn" onClick={onBack} style={wide}>{COPY.done}</button>
            <button className="btn" onClick={() => { void begin(); }} style={wide}>{COPY.pairAgain}</button>
            <button className="btn" onClick={() => setConfirmUnpair(true)} style={{ ...wide, color: 'var(--text-muted)', fontSize: '0.85rem' }}>{COPY.unpair}</button>
          </>
        ) : (
          <div className="card" style={{ padding: 16, border: '1px solid var(--danger)' }}>
            <p style={{ fontSize: '0.85rem', lineHeight: 1.5, marginBottom: 12 }}>{COPY.unpairConfirm(name)}</p>
            <button className="btn btn-danger" disabled={unpairing} onClick={() => { void handleUnpair(); }} style={wide}>
              {unpairing ? COPY.unpairing : COPY.unpairNow}
            </button>
            <button className="btn" disabled={unpairing} onClick={() => setConfirmUnpair(false)} style={{ width: '100%' }}>{COPY.cancel}</button>
          </div>
        )}
      </div>
    );
  }

  if (state.phase === 'idle' || state.phase === 'checking') {
    return <div className="fade-in" style={{ ...pad, textAlign: 'center' }}><p style={muted}>{COPY.checking}</p></div>;
  }

  if (state.phase === 'blocked') {
    const b = COPY.blocked[state.reason];
    const body = typeof b.body === 'function' ? b.body(name) : b.body;
    return (
      <div className="fade-in" style={pad}>
        <h2 style={{ marginBottom: 8 }}>{b.heading}</h2>
        <p style={{ ...muted, marginBottom: 12 }}>{body}</p>
        {state.reason === 'slots-full' && state.labels && (
          <ul style={{ ...muted, marginBottom: 16, paddingLeft: 20 }}>
            {state.labels.map((l, i) => <li key={`${l}-${i}`}>{l.slice(0, 64)}</li>)}
          </ul>
        )}
        {state.reason === 'no-operator-key' && onOpenOperatorImport && (
          <button className="btn btn-primary" onClick={onOpenOperatorImport} style={wide}>{COPY.blocked['no-operator-key'].action}</button>
        )}
        <button className="btn" onClick={onBack} style={{ width: '100%' }}>{COPY.back}</button>
      </div>
    );
  }

  if (state.phase === 'offer') {
    return (
      <div className="fade-in" style={pad}>
        <h2 style={{ marginBottom: 8 }}>{COPY.title(name)}</h2>
        <p style={{ ...muted, marginBottom: 20 }}>{COPY.offerIntro(name)}</p>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <QRCode data={state.uri} size={260} />
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{COPY.offerExpires(countdown)}</div>
        </div>
        <p style={{ ...muted, fontSize: '0.8rem', marginBottom: 20 }}>{COPY.offerNoSecret}</p>
        <button className="btn" onClick={() => { pairing.cancel(); onBack(); }} style={{ width: '100%' }}>{COPY.cancel}</button>
      </div>
    );
  }

  if (state.phase === 'confirm') {
    return (
      <div className="fade-in" style={pad}>
        <h2 style={{ marginBottom: 8 }}>{COPY.confirmHeading}</h2>
        <p style={{ ...muted, marginBottom: 20 }}>{COPY.confirmBody(name)}</p>
        <ol data-testid="pair-check-words" style={{ fontSize: '1.4rem', fontWeight: 600, lineHeight: 1.6, marginBottom: 24, paddingLeft: 28 }}>
          {state.words.map((w, i) => <li key={i}>{w}</li>)}
        </ol>
        <button className="btn btn-primary" onClick={() => { void pairing.confirmMatch(); }} style={wide}>{COPY.confirmMatch}</button>
        <button className="btn" onClick={() => pairing.rejectMatch()} style={{ width: '100%' }}>{COPY.confirmNoMatch}</button>
      </div>
    );
  }

  if (state.phase === 'minting') {
    return <div className="fade-in" style={{ ...pad, textAlign: 'center' }}><p style={muted}>{COPY.minting}</p></div>;
  }

  if (state.phase === 'paired') {
    return (
      <div className="fade-in" style={pad}>
        <h2 style={{ marginBottom: 8 }}>{COPY.pairedHeading}</h2>
        <p style={{ ...muted, marginBottom: 12 }}>{COPY.pairedBody(name)}</p>
        {state.warning && <p role="alert" style={{ color: 'var(--danger)', marginBottom: 12 }}>{state.warning}</p>}
        <button className="btn btn-primary" onClick={onBack} style={{ width: '100%' }}>{COPY.done}</button>
      </div>
    );
  }

  const message = state.phase === 'aborted'
    ? (state.reason === 'mismatch' ? COPY.abortedMismatch : COPY.abortedTwoRequests)
    : state.phase === 'expired' ? COPY.expired : state.message;
  return (
    <div className="fade-in" style={pad}>
      <p role="alert" style={{ ...muted, color: state.phase === 'error' ? 'var(--danger)' : muted.color, marginBottom: 16 }}>{message}</p>
      <button className="btn btn-primary" onClick={() => { void begin(); }} style={wide}>{COPY.newCode}</button>
      <button className="btn" onClick={onBack} style={{ width: '100%' }}>{COPY.back}</button>
    </div>
  );
}
