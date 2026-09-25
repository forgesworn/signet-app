import { shortNpub } from '../lib/signet';
/**
 * "Migrate family to Heartwood" ceremony page (family-bunker migration
 * §11.1.3). Full-screen, no Layout wrapper — same visual idiom as
 * `PairDependantApp.tsx` (stage-union ceremony page).
 *
 * The wizard drives enrolment/verification against a freshly-paired (or
 * already-connected) Heartwood signer BEFORE any local key material is
 * touched. Nothing is stripped from this phone until every slot the plan
 * cares about has verified — see `onFinalize` (App.tsx `handleMigrationFinalize`).
 *
 * Stage machine (exact union from the task-5 brief):
 *   intro -> connect -> enrolling -> verify-failed | verified -> stripping -> done
 *                                                                           \-> error
 * `error` is also reachable directly from `connect` (capabilities gate),
 * `enrolling` (storage-full / fatal per-slot error), and `stripping`
 * (finalize failure, pre- or post-strip — see the `postStrip` marker on
 * the thrown error from `handleMigrationFinalize`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SignetIdentity, DependantIdentity } from '../types';
import { buildEnrolmentPlan, enrolSlot } from '../lib/heartwood-enrolment';
import type { EnrolmentSlot, EnrolOutcome } from '../lib/heartwood-enrolment';
import { parseHeartwoodCapabilities } from '../lib/bunker-router';
import { fetchBadges } from '../lib/badge-fetch';
import type { CachedBadge } from '../lib/badge-fetch';
import { HeartwoodOperatorImport } from '../components/HeartwoodOperatorImport';
import type { OperatorImportOutcome } from '../hooks/useHeartwoodOperator';

type RequestFn = (method: string, params: string[]) => Promise<string>;

interface MigrateToHeartwoodProps {
  identity: SignetIdentity;
  dependants: DependantIdentity[];
  relayUrl?: string;
  /** True ⇒ skip the connect stage, use existing connection. */
  alreadyBunker: boolean;
  onConnect: (bunkerUri: string) => Promise<RequestFn>;
  requestFn: () => RequestFn | null;
  onFinalize: (verifiedSlots: EnrolmentSlot[]) => Promise<void>;
  onAbort: () => Promise<void>;
  /** Navigate home. */
  onDone: () => void;
  /** Navigate back. */
  onCancel: () => void;
  /**
   * Optional operator-key import bundle (C3, §11.1.4/9). When present the
   * done stage offers the "Enable remote approvals & rules" card; when
   * `imported` is already true (re-entry with a key on file) it's skipped.
   */
  operatorImport?: {
    imported: boolean;
    onImportLink: (text: string, pin?: string) => Promise<OperatorImportOutcome>;
    onImportPhrase: (words: string, deviceInput: string, relaysText: string) => Promise<OperatorImportOutcome>;
  };
}

type EnrolRowState = EnrolOutcome | 'pending' | 'waiting-button';

type Stage =
  | { kind: 'intro' }
  | { kind: 'connect'; uri: string; connecting: boolean; error?: string }
  | { kind: 'enrolling'; results: Map<string, EnrolRowState>; current: number }
  | { kind: 'verify-failed'; failures: Array<{ slot: EnrolmentSlot; outcome: EnrolOutcome }> }
  // `slots` is the plan snapshot the enrolment RUN actually verified against
  // (captured by closure when that run started) — NOT the live-recomputed
  // `plan` from props, which can change mid-ceremony (e.g. a dependant
  // merged in by cross-device sync). Every slot here has status 'verified'
  // by construction: finishLoop only reaches `verified` when `mismatches`
  // is empty, and any per-slot `error`/`storage-full` outcome exits to the
  // `error` stage directly instead of reaching finishLoop.
  | { kind: 'verified'; slots: EnrolmentSlot[] }
  | { kind: 'stripping' }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

const CAPABILITIES_TIMEOUT_MS = 10_000;
const WAITING_BUTTON_DELAY_MS = 5_000;
const MAX_SLOT_RETRIES = 2;
const STORAGE_WARNING_THRESHOLD = 32;

// Same gate + pattern as `AdvancedSettings.tsx isValidBunkerUri` — not
// exported from there (private to that component), duplicated here.
function isValidBunkerUri(uri: string): boolean {
  return /^bunker:\/\/[0-9a-f]{64}\?.*relay=(wss:\/\/|wss%3a%2f%2f)/i.test(uri.trim());
}

function skippedReasonCopy(reason: 'imported-persona' | 'imported-dependant' | 'mirror-persona' | 'missing-pubkey'): string {
  switch (reason) {
    case 'imported-persona':
    case 'imported-dependant':
      return 'imported — not in your seed phrase; keeps working from this phone';
    case 'mirror-persona':
      return 'view-only here';
    case 'missing-pubkey':
      return 'missing key data — stays on this phone';
  }
}

function identityAddress(pubkey: string): string {
  return shortNpub(pubkey);
}

const MAX_DEVICE_MESSAGE_LENGTH = 200;

/** Bounds device-supplied strings (outcome.message, storage-full text) before display. */
function truncateDeviceMessage(message: string): string {
  return message.length > MAX_DEVICE_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_DEVICE_MESSAGE_LENGTH)}…`
    : message;
}

export function MigrateToHeartwood({
  identity,
  dependants,
  relayUrl,
  alreadyBunker,
  onConnect,
  requestFn,
  onFinalize,
  onAbort,
  onDone,
  onCancel,
  operatorImport,
}: MigrateToHeartwoodProps) {
  // Done-stage operator card: hidden once skipped or imported this session.
  const [operatorCardDismissed, setOperatorCardDismissed] = useState(false);
  const [operatorImportedNow, setOperatorImportedNow] = useState(false);
  const plan = useMemo(() => buildEnrolmentPlan(identity, dependants), [identity, dependants]);

  const [stage, setStage] = useState<Stage>({ kind: 'intro' });
  const [capabilityChecking, setCapabilityChecking] = useState(false);
  const [wordsConfirmed, setWordsConfirmed] = useState(false);
  const [badges, setBadges] = useState<Map<string, CachedBadge>>(new Map());

  // True from the moment a FRESH bunker pairing succeeds (handleConnect)
  // until either finalize commits (`done`) or the connection is explicitly
  // aborted. Drives the unmount-abort rule below. `alreadyBunker` entries
  // never set this — there is nothing this wizard paired that it should
  // tear down.
  const pendingConnectionRef = useRef(false);
  // Guards the async enrolment loop against continuing (and calling
  // setState) after the wizard has been left mid-flight.
  const cancelledRef = useRef(false);
  // Per-slot retry counter for the `error` outcome path (max 2 retries).
  const retryCountsRef = useRef<Map<string, number>>(new Map());
  // Latest "retry this slot" entrypoint, published by runEnrolment so the
  // per-row Retry button can call back into the loop's closure.
  const retrySlotRef = useRef<((index: number) => void) | null>(null);

  const onAbortRef = useRef(onAbort);
  onAbortRef.current = onAbort;

  // Unmount: abort any pending (unfinalized) connection. Runs once.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (pendingConnectionRef.current) {
        pendingConnectionRef.current = false;
        void onAbortRef.current();
      }
    };
  }, []);

  const cancelWizard = useCallback(async () => {
    // Set before awaiting onAbort so a Retry tap that lands mid-abort can't
    // slip a fresh attemptSlot() in against a signer we're already tearing
    // down. (retrySlotRef itself flips this back to false when it fires —
    // this only closes the window between the Cancel tap and that happening.)
    cancelledRef.current = true;
    pendingConnectionRef.current = false;
    try {
      await onAbort();
    } catch {
      // best-effort — we're leaving regardless
    }
    onCancel();
  }, [onAbort, onCancel]);

  const startOver = useCallback(async () => {
    pendingConnectionRef.current = false;
    try {
      await onAbort();
    } catch {
      // best-effort
    }
    setStage({ kind: 'intro' });
  }, [onAbort]);

  // --- Enrolment engine -----------------------------------------------
  // Sequential (one slot at a time — a button-gated device serialises
  // anyway). Mismatches are collected across the whole loop so the user
  // sees the full picture before `verify-failed`. `error` outcomes pause
  // the loop at the offending slot and offer a per-slot Retry (max 2)
  // before treating it as fatal. `storage-full` stops the loop entirely.
  const runEnrolment = useCallback((rq: RequestFn) => {
    // A zero-slot plan has nothing to verify against a device — reaching
    // `verified` here would be a vacuous pass (nothing round-tripped, but
    // the wizard would still offer to strip). Fail fast instead, before
    // even checking capabilities, and never touch cancelledRef/retry state.
    if (plan.slots.length === 0) {
      setStage({ kind: 'error', message: 'Nothing to migrate — no identities on this phone can be enrolled.' });
      return;
    }

    retryCountsRef.current = new Map();
    const results = new Map<string, EnrolRowState>();
    const mismatches: Array<{ slot: EnrolmentSlot; outcome: EnrolOutcome }> = [];
    // Snapshot of the plan THIS run is verifying against — closed over for
    // the life of this call, immune to `plan` recomputing from a props
    // change (e.g. a dependant merged in mid-ceremony by cross-device sync)
    // while the loop is in flight.
    const runSlots = plan.slots;

    const pushStage = (current: number) => {
      setStage({ kind: 'enrolling', results: new Map(results), current });
    };

    const finishLoop = () => {
      if (mismatches.length > 0) {
        setStage({ kind: 'verify-failed', failures: [...mismatches] });
      } else {
        setStage({ kind: 'verified', slots: runSlots });
      }
    };

    const attemptSlot = async (index: number): Promise<void> => {
      if (cancelledRef.current) return;
      const slot = runSlots[index];
      results.set(slot.token, 'pending');
      pushStage(index);

      const timer = setTimeout(() => {
        if (cancelledRef.current) return;
        results.set(slot.token, 'waiting-button');
        pushStage(index);
      }, WAITING_BUTTON_DELAY_MS);

      let outcome: EnrolOutcome;
      try {
        outcome = await enrolSlot(rq, slot);
      } finally {
        clearTimeout(timer);
      }
      if (cancelledRef.current) return;

      if (outcome.status === 'verified') {
        results.set(slot.token, outcome);
        pushStage(index);
        await advance(index);
        return;
      }
      if (outcome.status === 'mismatch') {
        results.set(slot.token, outcome);
        mismatches.push({ slot, outcome });
        pushStage(index);
        await advance(index);
        return;
      }
      if (outcome.status === 'storage-full') {
        setStage({
          kind: 'error',
          message: `${truncateDeviceMessage(outcome.message)} Remove unused personas on the device (Sapwood → identities) and run migration again — nothing was changed on this phone.`,
        });
        return;
      }
      // status === 'error'
      const retriesUsed = retryCountsRef.current.get(slot.token) ?? 0;
      if (retriesUsed >= MAX_SLOT_RETRIES) {
        setStage({ kind: 'error', message: truncateDeviceMessage(outcome.message) });
        return;
      }
      results.set(slot.token, outcome);
      pushStage(index); // row shows the error + Retry affordance
    };

    const advance = async (index: number): Promise<void> => {
      const next = index + 1;
      if (next >= runSlots.length) {
        finishLoop();
        return;
      }
      await attemptSlot(next);
    };

    retrySlotRef.current = (index: number) => {
      cancelledRef.current = false;
      const slot = runSlots[index];
      retryCountsRef.current.set(slot.token, (retryCountsRef.current.get(slot.token) ?? 0) + 1);
      void attemptSlot(index);
    };

    setCapabilityChecking(true);
    setStage({ kind: 'enrolling', results: new Map(), current: 0 });

    void (async () => {
      let caps: ReturnType<typeof parseHeartwoodCapabilities> = null;
      try {
        const raw = await Promise.race([
          rq('heartwood_capabilities', []),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Timed out waiting for the signer')), CAPABILITIES_TIMEOUT_MS);
          }),
        ]);
        caps = parseHeartwoodCapabilities(raw);
      } catch {
        caps = null;
      }
      if (cancelledRef.current) return;
      setCapabilityChecking(false);

      if (!caps || !caps.methods.includes('heartwood_derive_persona')) {
        setStage({
          kind: 'error',
          message: "This signer doesn't support family enrolment — a full Heartwood (firmware 0.16+) is required. Nothing was changed on this phone.",
        });
        return;
      }

      await attemptSlot(0);
    })();
  }, [plan.slots]);

  // --- Stage transitions -------------------------------------------------

  const handleIntroContinue = useCallback(() => {
    // Fresh user-initiated entry point — clear any stale cancellation from
    // a previous run (e.g. after `startOver`) before anything else.
    cancelledRef.current = false;
    if (alreadyBunker) {
      const rq = requestFn();
      if (!rq) {
        setStage({ kind: 'error', message: 'No connected signer found. Nothing was changed on this phone.' });
        return;
      }
      runEnrolment(rq);
      return;
    }
    setStage({ kind: 'connect', uri: '', connecting: false });
  }, [alreadyBunker, requestFn, runEnrolment]);

  const handleConnectSubmit = useCallback(async () => {
    if (stage.kind !== 'connect') return;
    if (!isValidBunkerUri(stage.uri)) return;
    cancelledRef.current = false;
    setStage({ kind: 'connect', uri: stage.uri, connecting: true, error: undefined });
    try {
      const rq = await onConnect(stage.uri.trim());
      // Set BEFORE the cancellation check so an abort here actually tears
      // the fresh pairing down — otherwise an unmount that lands during
      // this await (before pendingConnectionRef existed) leaks the pairing
      // and the enrolment loop below would run headlessly against an
      // unmounted page.
      pendingConnectionRef.current = true;
      if (cancelledRef.current) {
        pendingConnectionRef.current = false;
        void onAbortRef.current();
        return;
      }
      runEnrolment(rq);
    } catch (err) {
      setStage({
        kind: 'connect',
        uri: stage.uri,
        connecting: false,
        error: err instanceof Error ? err.message : 'Connection failed',
      });
    }
  }, [stage, onConnect, runEnrolment]);

  const handleStrip = useCallback(async () => {
    if (stage.kind !== 'verified') return;
    if (!wordsConfirmed) return;
    const verifiedSlots = stage.slots;
    setStage({ kind: 'stripping' });
    try {
      await onFinalize(verifiedSlots);
      pendingConnectionRef.current = false;
      setStage({ kind: 'done' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const postStrip = err instanceof Error && (err as Error & { postStrip?: boolean }).postStrip === true;
      setStage({
        kind: 'error',
        message: postStrip
          ? `Your keys moved to the Heartwood, but the connection didn't finish. Nothing is lost — run Migrate again to complete setup. ${message}`
          : `Nothing was committed — your keys are still on this phone. ${message}`,
      });
    }
  }, [stage, wordsConfirmed, onFinalize]);

  // Fire-and-forget badge fetch on entering `verified` — decoration only;
  // failures (empty map) render nothing extra.
  useEffect(() => {
    if (stage.kind !== 'verified') return;
    let cancelled = false;
    void fetchBadges(stage.slots.map((s) => s.expectedPubkeyHex), relayUrl ?? '').then((map) => {
      if (!cancelled) setBadges(map);
    });
    return () => {
      cancelled = true;
    };
  }, [stage, relayUrl]);

  // --- Render --------------------------------------------------------

  if (stage.kind === 'intro') {
    const owned = plan.slots.filter((s) => s.kind.startsWith('owner-'));
    const family = plan.slots.filter((s) => s.kind.startsWith('dep-'));
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <h2 style={{ marginBottom: 8 }}>Migrate family to Heartwood</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: 20 }}>
          {plan.slots.length} identities will move to your Heartwood.
        </p>

        {owned.length > 0 && (
          <div className="card" style={{ padding: 12, marginBottom: 16 }}>
            <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 8 }}>You</div>
            {owned.map((s) => (
              <div key={s.token} style={{ fontSize: '0.9rem', padding: '4px 0' }}>{s.label}</div>
            ))}
          </div>
        )}

        {family.length > 0 && (
          <div className="card" style={{ padding: 12, marginBottom: 16 }}>
            <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 8 }}>Family</div>
            {family.map((s) => (
              <div key={s.token} style={{ fontSize: '0.9rem', padding: '4px 0' }}>{s.label}</div>
            ))}
          </div>
        )}

        {plan.skipped.length > 0 && (
          <div className="card" style={{ padding: 12, marginBottom: 16 }}>
            <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 8 }}>Stays on this phone</div>
            {plan.skipped.map((s, i) => (
              <div key={`${s.label}-${i}`} style={{ fontSize: '0.85rem', padding: '4px 0', color: 'var(--text-secondary)' }}>
                {s.label} — {skippedReasonCopy(s.reason)}
              </div>
            ))}
          </div>
        )}

        {plan.slots.length > STORAGE_WARNING_THRESHOLD && (
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 16 }}>
            Your device may hold up to 32 identities (64 on larger boards) — enrolment will stop cleanly if it fills.
          </p>
        )}

        <button className="btn btn-primary" onClick={handleIntroContinue} style={{ width: '100%', marginBottom: 8 }}>
          Continue
        </button>
        <button className="btn btn-secondary" onClick={() => { void cancelWizard(); }} style={{ width: '100%' }}>
          Cancel
        </button>
      </div>
    );
  }

  if (stage.kind === 'connect') {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <h2 style={{ marginBottom: 8 }}>Connect your Heartwood</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: 20 }}>
          Type your recovery words into the Heartwood first — enrolment verifies every identity against this phone,
          and nothing is removed from the phone until everything matches.
        </p>
        <input
          className="input"
          value={stage.uri}
          onChange={(e) => setStage({ kind: 'connect', uri: e.target.value, connecting: false })}
          placeholder="bunker://..."
          autoFocus
          disabled={stage.connecting}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            className="btn btn-primary"
            disabled={!isValidBunkerUri(stage.uri) || stage.connecting}
            onClick={() => { void handleConnectSubmit(); }}
            style={{ flex: 1 }}
          >
            {stage.connecting ? 'Connecting...' : 'Connect'}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => setStage({ kind: 'intro' })}
            disabled={stage.connecting}
            style={{ flex: 1 }}
          >
            Back
          </button>
        </div>
        {stage.error && (
          <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: 12 }}>{stage.error}</p>
        )}
      </div>
    );
  }

  if (stage.kind === 'enrolling') {
    const currentSlot = plan.slots[stage.current];
    const currentRow = currentSlot ? stage.results.get(currentSlot.token) : undefined;
    // Same condition that shows the per-row Retry button — the loop is
    // paused on an error, not mid-flight (pending/waiting-button).
    const isPaused = !!currentRow && typeof currentRow === 'object' && currentRow.status === 'error';
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <h2 style={{ marginBottom: 8 }}>Enrolling on your Heartwood</h2>
        {capabilityChecking ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>Checking your Heartwood…</p>
        ) : (
          <>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 16 }}>
              {stage.current + 1} of {plan.slots.length}
            </p>
            <div className="card" style={{ padding: 12 }}>
              {plan.slots.map((slot, i) => {
                const row = stage.results.get(slot.token);
                let statusText = '';
                let showRetry = false;
                if (row === 'pending') statusText = 'Working…';
                else if (row === 'waiting-button') statusText = 'press the button on your Heartwood';
                else if (row && row.status === 'verified') statusText = '✓';
                else if (row && row.status === 'mismatch') statusText = 'Mismatch';
                else if (row && row.status === 'error') {
                  statusText = truncateDeviceMessage(row.message);
                  showRetry = i === stage.current;
                }
                return (
                  <div
                    key={slot.token}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 0',
                      borderTop: i === 0 ? undefined : '1px solid var(--border)',
                      gap: 8,
                    }}
                  >
                    <span style={{ fontSize: '0.9rem' }}>{slot.label}</span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textAlign: 'right' }}>
                      {statusText}
                      {showRetry && (
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ marginLeft: 8 }}
                          onClick={() => retrySlotRef.current?.(i)}
                        >
                          Retry
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            {isPaused && (
              <button
                className="btn btn-secondary"
                onClick={() => { void cancelWizard(); }}
                style={{ width: '100%', marginTop: 12 }}
              >
                Cancel
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  if (stage.kind === 'verify-failed') {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <h2 style={{ marginBottom: 8 }}>Keys don't match</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: 20 }}>
          The signer derived different keys than this phone holds — the words on the device don't match this
          identity. Nothing was removed from this phone.
        </p>
        <div className="card" style={{ padding: 12, marginBottom: 16 }}>
          {stage.failures.map(({ slot, outcome }) => (
            <div key={slot.token} style={{ fontSize: '0.85rem', padding: '6px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600 }}>{slot.label}</div>
              <div style={{ color: 'var(--text-secondary)' }}>
                expected {identityAddress(slot.expectedPubkeyHex)} got{' '}
                {outcome.status === 'mismatch' ? identityAddress(outcome.gotPubkeyHex) : 'unavailable'}
              </div>
            </div>
          ))}
        </div>
        <button className="btn btn-primary" onClick={() => { void startOver(); }} style={{ width: '100%', marginBottom: 8 }}>
          Start over
        </button>
        <button className="btn btn-secondary" onClick={() => { void cancelWizard(); }} style={{ width: '100%' }}>
          Cancel
        </button>
      </div>
    );
  }

  if (stage.kind === 'verified') {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <h2 style={{ marginBottom: 8 }}>Everything matches</h2>
        <div className="card" style={{ padding: 12, marginBottom: 16 }}>
          {stage.slots.map((slot) => {
            const badge = badges.get(slot.expectedPubkeyHex);
            return (
              <div
                key={slot.token}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--border)' }}
              >
                <span style={{ fontSize: '0.9rem' }}>{slot.label}</span>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  ✓{badge ? ` · ${badge.tierLabel}` : ''}
                </span>
              </div>
            );
          })}
        </div>

        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <p style={{ fontSize: '0.9rem', lineHeight: 1.5, marginBottom: 12 }}>
            Next, MySignet clears its own stored copies of these keys — it will no longer keep them. The Heartwood
            becomes the family's signer, and your recovery words are the backup.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={wordsConfirmed}
              onChange={(e) => setWordsConfirmed(e.target.checked)}
            />
            I have my recovery words written down
          </label>
          <button
            className="btn btn-primary"
            disabled={!wordsConfirmed}
            onClick={() => { void handleStrip(); }}
            style={{ width: '100%' }}
          >
            Clear stored keys from this app
          </button>
        </div>
      </div>
    );
  }

  if (stage.kind === 'stripping') {
    return (
      <div className="fade-in" style={{ padding: 24, textAlign: 'center' }}>
        <p style={{ color: 'var(--text-secondary)' }}>Clearing stored keys…</p>
      </div>
    );
  }

  if (stage.kind === 'done') {
    const livePairingDeps = dependants.filter(
      (d) => !!d.bunkerEndpoint?.authorizedClientPubkey || (d.appBunkerEndpoint?.pairings?.length ?? 0) > 0,
    );
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <h2 style={{ marginBottom: 8 }}>Your family now signs on Heartwood.</h2>
        {livePairingDeps.length > 0 && (
          <div className="card" style={{ padding: 12, marginBottom: 16 }}>
            {livePairingDeps.map((d) => (
              <p key={d.id} style={{ fontSize: '0.85rem', lineHeight: 1.5, marginBottom: 8 }}>
                {d.displayName}'s connected apps stopped working at migration (their old pairing pointed at this
                phone). Re-pair each app when it's next used — lazy is fine.
              </p>
            ))}
          </div>
        )}
        {operatorImport && !operatorImport.imported && !operatorImportedNow && !operatorCardDismissed ? (
          <HeartwoodOperatorImport
            onImportLink={operatorImport.onImportLink}
            onImportPhrase={operatorImport.onImportPhrase}
            onImported={() => setOperatorImportedNow(true)}
            onSkip={() => setOperatorCardDismissed(true)}
          />
        ) : (
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: 1.5, marginBottom: 20 }}>
            {operatorImport?.imported || operatorImportedNow
              ? 'Your family rules now push to the device from this phone, and family asks can be answered here.'
              : 'Family rules push to the device once your operator key is imported — Settings → Advanced → Heartwood operator key. Until then new sign-ins ask on the device.'}
          </p>
        )}
        <button className="btn btn-primary" onClick={onDone} style={{ width: '100%' }}>
          Done
        </button>
      </div>
    );
  }

  // stage.kind === 'error'
  return (
    <div className="fade-in" style={{ padding: 24 }}>
      <h2 style={{ marginBottom: 8 }}>Something went wrong</h2>
      <p style={{ color: 'var(--danger)', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: 20 }}>
        {stage.message}
      </p>
      <button className="btn btn-secondary" onClick={() => { void cancelWizard(); }} style={{ width: '100%' }}>
        Cancel
      </button>
    </div>
  );
}
