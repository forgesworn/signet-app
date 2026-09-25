/**
 * Guardian-side pair-an-app screen for trusted-app pairings on a dependant.
 *
 * Mirrors `PairDependantDevice` closely. Differences:
 *  - Mints from `appBunkerEndpoint` (capacity TRUSTED_APP_PAIRING_CAP),
 *    NOT `bunkerEndpoint` (single-slot, reserved for the child's own
 *    paired device).
 *  - Lists already-paired apps below the QR with a Revoke button each.
 *  - Disables the QR with a "Slot limit reached" banner when at cap.
 *  - Distinct from device pairing: third-party apps that act as the
 *    dependant don't evict the child's own device pairing.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { DependantIdentity, TrustedAppEndpoint, TrustedAppPairing } from '../types';
import { TRUSTED_APP_PAIRING_CAP } from '../types';
import { QRCode } from '../components/QRCode';
import { buildPairingURI, generatePairingSecret } from '../lib/pairing-uri';

const PAIRING_SECRET_TTL_MS = 5 * 60 * 1000;

interface Props {
  dependant: DependantIdentity;
  /** The guardian's preferred relay — connecting app will try this first. */
  relayUrl: string;
  fallbackRelayUrls?: string[];
  /** True when the NIP-46 bunker server is actively listening on this phone. */
  bunkerServerEnabled: boolean;
  /** Returns / mints the per-dependant app-bunker endpoint keypair. */
  ensureAppBunkerEndpoint: (pubkey: string) => Promise<TrustedAppEndpoint>;
  /** Persist a fresh pairing secret on the dependant's app-bunker endpoint. */
  setAppBunkerPairingSecret: (pubkey: string, secret: string) => Promise<void>;
  /** Read-only view of pairings for this dependant (refreshed after revoke). */
  listAppBunkerPairings: (pubkey: string) => Promise<TrustedAppPairing[]>;
  /** Revoke a pairing by its NIP-46 client pubkey. */
  removeAppBunkerPairing: (pubkey: string, clientPubkey: string) => Promise<void>;
  /** Opens Security settings so the guardian can enable the bunker server. */
  onOpenSecuritySettings?: () => void;
  /** Tier 1 auth gate — must resolve before the pairing QR is generated. */
  requestAuth: () => Promise<string | null>;
  onBack: () => void;
}

type Stage =
  | { kind: 'preparing' }
  | { kind: 'ready'; endpoint: TrustedAppEndpoint; secret: string; secretIssuedAt: number; sessionStartCount: number }
  /**
   * A pairing bound during this page session. The secret was used and
   * cleared server-side; we stop minting fresh ones so the slot doesn't
   * silently re-open. The user can mint a new code (going back to `ready`
   * with the current sessionStartCount = list.length) or finish.
   */
  | { kind: 'bound'; endpoint: TrustedAppEndpoint }
  | { kind: 'capped'; endpoint: TrustedAppEndpoint }
  | { kind: 'error'; message: string };

function formatPairing(p: TrustedAppPairing): { line1: string; line2: string } {
  const lastSeen = p.lastSeenAt ?? p.pairedAt;
  const when = new Date(lastSeen * 1000);
  const sameDay = when.toDateString() === new Date().toDateString();
  const dateStr = sameDay
    ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : when.toLocaleDateString();
  const line2 = p.lastSeenAt
    ? `${p.origin ?? 'unknown origin'} — last seen ${dateStr}`
    : `${p.origin ?? 'unknown origin'} — paired ${dateStr}`;
  return { line1: p.label || 'App', line2 };
}

export function PairDependantApp({
  dependant,
  relayUrl,
  fallbackRelayUrls,
  bunkerServerEnabled,
  ensureAppBunkerEndpoint,
  setAppBunkerPairingSecret,
  listAppBunkerPairings,
  removeAppBunkerPairing,
  onOpenSecuritySettings,
  requestAuth,
  onBack,
}: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'preparing' });
  const [pairings, setPairings] = useState<TrustedAppPairing[]>([]);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(Math.floor(PAIRING_SECRET_TTL_MS / 1000));
  const [revokingPubkey, setRevokingPubkey] = useState<string | null>(null);

  const ensureRef = useRef(ensureAppBunkerEndpoint);
  ensureRef.current = ensureAppBunkerEndpoint;
  const setSecretRef = useRef(setAppBunkerPairingSecret);
  setSecretRef.current = setAppBunkerPairingSecret;
  const listRef = useRef(listAppBunkerPairings);
  listRef.current = listAppBunkerPairings;
  const removeRef = useRef(removeAppBunkerPairing);
  removeRef.current = removeAppBunkerPairing;
  const requestAuthRef = useRef(requestAuth);
  requestAuthRef.current = requestAuth;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  // Reload the pairings list — used both at mount and after a revoke /
  // successful bind.
  const reloadPairings = useCallback(async (pubkey: string) => {
    try {
      const list = await listRef.current(pubkey);
      setPairings(list);
      return list;
    } catch {
      return [] as TrustedAppPairing[];
    }
  }, []);

  // Mount — gate behind Tier 1 auth, ensure endpoint, mint first secret
  // (unless we're already at cap). Skip when bunker server is off — the
  // guard below renders the "off" UI and minting a QR / prompting for
  // auth would be wasted work. Re-runs when the user toggles the Bunker
  // on and comes back; see PairDependantDevice for the same pattern.
  useEffect(() => {
    if (!bunkerServerEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        const key = await requestAuthRef.current();
        if (cancelled) return;
        if (!key) {
          onBackRef.current();
          return;
        }
        const endpoint = await ensureRef.current(dependant.id);
        if (cancelled) return;
        const list = await reloadPairings(dependant.id);
        if (cancelled) return;
        if (list.length >= TRUSTED_APP_PAIRING_CAP) {
          setStage({ kind: 'capped', endpoint });
          return;
        }
        const secret = generatePairingSecret();
        await setSecretRef.current(dependant.id, secret).catch(() => { /* tolerated */ });
        if (cancelled) return;
        setStage({ kind: 'ready', endpoint, secret, secretIssuedAt: Date.now(), sessionStartCount: list.length });
      } catch (err) {
        if (cancelled) return;
        setStage({ kind: 'error', message: err instanceof Error ? err.message : 'Could not prepare pairing' });
      }
    })();
    return () => { cancelled = true; };
  }, [dependant.id, reloadPairings, bunkerServerEnabled]);

  // Countdown ticker — auto-rotate secret on expiry. Also poll the pairings
  // list lightly so a successful bind appears in the list without manual
  // refresh.
  //
  // Bind detection: the page captures the pairings count at the moment we
  // entered `ready`. If the count grows during this session — even by one —
  // we know a bind happened. We MUST NOT keep minting fresh secrets after
  // that: the secret was just used and cleared server-side, so the next
  // rotation tick would re-open the pairing window with a brand-new
  // secret, silently exposing an additional slot to whoever happens to be
  // looking at the displayed QR. Transition to `bound` instead.
  useEffect(() => {
    if (stage.kind !== 'ready') return;
    let cancelled = false;
    const stageEndpoint = stage.endpoint;
    const stageIssuedAt = stage.secretIssuedAt;
    const sessionStartCount = stage.sessionStartCount;
    let pollCounter = 0;
    const tick = async () => {
      if (cancelled) return;
      pollCounter += 1;
      // Poll for a successful bind every 2s. Cheap (single IDB read).
      if (pollCounter % 2 === 0) {
        const list = await reloadPairings(dependant.id);
        if (cancelled) return;
        if (list.length >= TRUSTED_APP_PAIRING_CAP) {
          setStage({ kind: 'capped', endpoint: stageEndpoint });
          return;
        }
        if (list.length > sessionStartCount) {
          // A pairing bound during this session — stop the rotation.
          setStage({ kind: 'bound', endpoint: stageEndpoint });
          return;
        }
      }
      const elapsed = Date.now() - stageIssuedAt;
      const remainingMs = PAIRING_SECRET_TTL_MS - elapsed;
      if (remainingMs <= 0) {
        const secret = generatePairingSecret();
        try {
          await setSecretRef.current(dependant.id, secret);
        } catch { /* tolerated */ }
        if (cancelled) return;
        setStage({ kind: 'ready', endpoint: stageEndpoint, secret, secretIssuedAt: Date.now(), sessionStartCount });
        setRemainingSeconds(Math.floor(PAIRING_SECRET_TTL_MS / 1000));
      } else {
        setRemainingSeconds(Math.ceil(remainingMs / 1000));
      }
    };
    void tick();
    const id = setInterval(() => { void tick(); }, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [stage, dependant.id, reloadPairings]);

  // "Pair another" — invoked from the `bound` stage after a successful bind.
  // Mints a fresh secret and re-enters `ready` with sessionStartCount set
  // to the current list length, so the next bind detection cycle starts
  // fresh.
  const handlePairAnother = useCallback(async () => {
    if (stage.kind !== 'bound') return;
    const list = await reloadPairings(dependant.id);
    if (list.length >= TRUSTED_APP_PAIRING_CAP) {
      setStage({ kind: 'capped', endpoint: stage.endpoint });
      return;
    }
    const secret = generatePairingSecret();
    try {
      await setSecretRef.current(dependant.id, secret);
    } catch { /* tolerated */ }
    setStage({
      kind: 'ready',
      endpoint: stage.endpoint,
      secret,
      secretIssuedAt: Date.now(),
      sessionStartCount: list.length,
    });
    setRemainingSeconds(Math.floor(PAIRING_SECRET_TTL_MS / 1000));
  }, [stage, dependant.id, reloadPairings]);

  const handleRevoke = useCallback(async (clientPubkey: string) => {
    setRevokingPubkey(clientPubkey);
    try {
      await removeRef.current(dependant.id, clientPubkey);
      const list = await reloadPairings(dependant.id);
      // If we were capped and now we're under, mint a fresh secret + flip
      // back to ready so the user can pair again immediately.
      if (stage.kind === 'capped' && list.length < TRUSTED_APP_PAIRING_CAP) {
        const secret = generatePairingSecret();
        await setSecretRef.current(dependant.id, secret).catch(() => { /* tolerated */ });
        setStage({ kind: 'ready', endpoint: stage.endpoint, secret, secretIssuedAt: Date.now(), sessionStartCount: list.length });
        setRemainingSeconds(Math.floor(PAIRING_SECRET_TTL_MS / 1000));
      }
    } catch (err) {
      setStage({ kind: 'error', message: err instanceof Error ? err.message : 'Revoke failed' });
    } finally {
      setRevokingPubkey(null);
    }
  }, [dependant.id, reloadPairings, stage]);

  // Bunker-server-disabled guard.
  if (!bunkerServerEnabled) {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <h2 style={{ marginBottom: 8 }}>The Bunker is off</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: 20 }}>
          To pair an app as {dependant.displayName}, your phone needs to be acting as their Bunker.
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

  // Common — pairing list + body. Body switches between QR ('ready'),
  // success banner ('bound'), and cap banner ('capped').
  let body: ReactElement;
  if (stage.kind === 'bound') {
    body = (
      <div
        className="card"
        style={{
          padding: 16,
          marginBottom: 24,
          background: 'var(--success-light)',
          border: '1px solid var(--success)',
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--success)' }}>Paired</div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
          The app is now paired. Tap "Pair another" to add another app, or "Done" to finish.
        </p>
        <button className="btn btn-secondary" style={{ width: '100%' }} onClick={() => { void handlePairAnother(); }}>
          Pair another
        </button>
      </div>
    );
  } else if (stage.kind === 'capped') {
    body = (
      <div className="card" style={{ padding: 16, marginBottom: 24, border: '1px solid var(--text-muted)' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Slot limit reached ({TRUSTED_APP_PAIRING_CAP}/{TRUSTED_APP_PAIRING_CAP})</div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
          Revoke a pairing below to add a new app.
        </p>
      </div>
    );
  } else {
    let uri: string;
    try {
      const relays = [relayUrl, ...(fallbackRelayUrls ?? [])].filter(r => typeof r === 'string' && r.length > 0);
      uri = buildPairingURI({
        endpointPubkey: stage.endpoint.publicKey,
        relays,
        secret: stage.secret,
        dependantPubkey: dependant.id,
        dependantName: dependant.displayName,
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
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <QRCode data={uri} size={260} />
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
          This code refreshes in {mm}:{ss}
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ padding: 24 }}>
      <h2 style={{ marginBottom: 8 }}>Pair an app as {dependant.displayName}</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: 20 }}>
        Scan this code in the app you want to use as {dependant.displayName}. Up to {TRUSTED_APP_PAIRING_CAP} apps can be paired at a time.
        This is separate from {dependant.displayName}'s own device pairing.
      </p>

      {body}

      {pairings.length > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 16 }}>
          <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 8 }}>
            Paired apps ({pairings.length}/{TRUSTED_APP_PAIRING_CAP})
          </div>
          {pairings.map((p) => {
            const fmt = formatPairing(p);
            const revoking = revokingPubkey === p.clientPubkey;
            return (
              <div
                key={p.clientPubkey}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  borderTop: '1px solid var(--border)',
                  gap: 8,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '0.9rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fmt.line1}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fmt.line2}
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => { void handleRevoke(p.clientPubkey); }}
                  disabled={revoking}
                  style={{ flexShrink: 0 }}
                >
                  {revoking ? 'Revoking…' : 'Revoke'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <button className="btn" onClick={onBack} style={{ width: '100%' }}>Done</button>
    </div>
  );
}
