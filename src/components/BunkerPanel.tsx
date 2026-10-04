import { BunkerApprovalModal } from './BunkerApprovalModal';
import { isKinterestAuthority } from '../lib/kinterest-authority';
import { shortNpub } from '../lib/signet';
import { escalationSectionTitle, type EscalationOwner } from '../lib/escalation-owner';
// src/components/BunkerPanel.tsx
import { useEffect, useState, type CSSProperties } from 'react';
import type { PendingApproval, BunkerServeStatus } from '../hooks/useBunkerServer';
import {
  STAY_AWAKE_OPTIONS_MINUTES,
  stayAwakeRemainingMs,
  formatCountdown,
} from '../lib/stay-awake';
import { Z } from '../lib/z-index';
import { isParkExpired, type EscalationNotice } from '../lib/escalation-fetch';
import { describeEventTemplate } from '../lib/nip46-server';
import type { VerdictResult } from '../lib/heartwood-mgmt';
import {
  describeVerdictOutcome,
  NEEDS_OPERATOR_KEY_COPY,
  DEVICE_UNSUPPORTED_VERDICT_COPY,
  type PanelVerdictAction,
  type VerdictAvailability,
} from '../lib/policy-push';
import { Icon } from './Icon';
import type { PendingChildAsk } from '../hooks/useChildAsks';
import { ChildAskCard, childAskOutcomeText, type ChildAskDecide } from './ChildAskCard';

/** How long a landed verdict's outcome line stays before the row auto-dismisses. */
const VERDICT_AUTO_DISMISS_MS = 4_000;

/** Per-notice verdict UI state (keyed by notice id; local to the panel). */
type VerdictRowState =
  | { phase: 'sending'; action: PanelVerdictAction }
  | { phase: 'done'; message: string }
  | { phase: 'error'; message: string };

interface Props {
  onClose: () => void;
  /** Master allow (the Security opt-in). When false, serving can't be armed here. */
  bunkerAllowed: boolean;
  /** Navigate to Security settings (to flip the master). Closes the panel. */
  onGoToSecurity: () => void;
  /** Stay-awake window deadline (epoch ms) or null when inactive. */
  stayAwakeUntil: number | null;
  onArmStayAwake: (minutes: number) => void;
  onCloseStayAwake: () => void;
  wakeLockSupported: boolean;
  pendingApprovals: PendingApproval[];
  onApproveOnce: (handle: number) => void;
  onApproveAlways: (handle: number) => void;
  onDeny: (handle: number) => void;
  /** Resolve a dependant id to a display name, or undefined for the owner. */
  dependantNameFor: (dependantId: string | null) => string | undefined;
  /** True when the guardian has at least one dependant — shows a note about always-on reachability. */
  hasDependants: boolean;
  /** Live socket truth from useBunkerServer — what the subscription is ACTUALLY doing. */
  serveStatus: BunkerServeStatus;
  /** True while the app holds no decryption key (cold-locked) — serving is
   *  physically impossible until one unlock puts key material in memory. */
  locked: boolean;
  /** When locked and user clicks +X, notify app of the pending minutes so it can
   *  track it across unlock and reopen the panel after. */
  onRequestUnlockWithPendingArm: (minutes: number) => void;
  /** When locked and user taps Always on: unlock first, then turn it on. */
  onRequestUnlockForAlwaysOn: () => void;
  /** True inside the native (Android APK) shell — gates the always-on row. */
  isNative: boolean;
  /** Native always-on background serving currently armed. */
  backgroundServing: boolean;
  /** The user turned always-on on (the stored preference), whether or not
   *  it is serving right now — off-but-wanted shows amber. */
  alwaysOnWanted: boolean;
  /** Arm/disarm native always-on background serving. */
  onSetBackgroundServing: (on: boolean) => Promise<void>;
  /** "Family asks" / "Waiting for approval" — parked-approval + petition notices (C4/C5). Absent/empty renders no section. */
  escalationNotices?: EscalationNotice[];
  /** Local-only hide of a notice row. */
  onDismissEscalation?: (id: string) => void;
  /** Whose ask a notice is (family member, the owner's own app, or unknown), from its `identityPubkey`. */
  resolveEscalationOwner?: (identityPubkey: string) => EscalationOwner;
  /**
   * C4 verdict leg (family-bunker §11.1.4/9): send `resolve_approval` for a
   * parked approval over the operator channel. Only `approve-once` and
   * `deny` are offered — `approve-remember` is deliberately NOT: a notice
   * carries no origin, and the compiled interactive policy is already the
   * slot's ceiling, so "remember" would widen it past the guardian's rules.
   */
  onEscalationVerdict?: (notice: EscalationNotice, action: PanelVerdictAction) => Promise<VerdictResult>;
  /** Whether verdicts can be sent right now (operator key imported + device supports it). */
  verdictAvailability?: VerdictAvailability;
  /** Fresh requests from dependants' own phones paired straight to the Heartwood (spec §7). */
  childAsks?: PendingChildAsk[];
  /** False at full-control (no "Always"). */
  childAskAlwaysAvailable?: (dependantId: string) => boolean;
  onChildAskDecide?: ChildAskDecide;
}

export function BunkerPanel({
  onClose, bunkerAllowed, onGoToSecurity,
  stayAwakeUntil, onArmStayAwake, onCloseStayAwake, wakeLockSupported,
  pendingApprovals, onApproveOnce, onApproveAlways, onDeny, dependantNameFor,
  hasDependants, serveStatus, locked, onRequestUnlockWithPendingArm, onRequestUnlockForAlwaysOn,
  isNative, backgroundServing, alwaysOnWanted, onSetBackgroundServing,
  escalationNotices, onDismissEscalation, resolveEscalationOwner,
  onEscalationVerdict, verdictAvailability = 'no-operator-key',
  childAsks, childAskAlwaysAvailable, onChildAskDecide,
}: Props) {
  const [reviewHandle, setReviewHandle] = useState<number | null>(null);
  const reviewed = pendingApprovals.find(a => a.handle === reviewHandle);
  const hasChildAsks = !!childAsks && childAsks.length > 0 && !!onChildAskDecide;
  const [childAskNote, setChildAskNote] = useState<string | null>(null);
  const hasEscalations = (!!escalationNotices && escalationNotices.length > 0) || hasChildAsks || !!childAskNote;
  // Without a resolver (older callers, tests) every ask stays unknown, so the
  // heading is neutral and no row is worded as the owner's own.
  const ownerOf = (n: EscalationNotice): EscalationOwner => resolveEscalationOwner?.(n.identityPubkey) ?? { kind: 'unknown' };
  const [verdictRows, setVerdictRows] = useState<Map<string, VerdictRowState>>(() => new Map());
  const setVerdictRow = (id: string, state: VerdictRowState | null) => {
    setVerdictRows((prev) => {
      const next = new Map(prev);
      if (state) next.set(id, state); else next.delete(id);
      return next;
    });
  };
  const sendVerdict = async (n: EscalationNotice, action: PanelVerdictAction) => {
    if (!onEscalationVerdict) return;
    setVerdictRow(n.id, { phase: 'sending', action });
    try {
      const result = await onEscalationVerdict(n, action);
      setVerdictRow(n.id, { phase: 'done', message: describeVerdictOutcome(action, result) });
      setTimeout(() => {
        setVerdictRow(n.id, null);
        onDismissEscalation?.(n.id);
      }, VERDICT_AUTO_DISMISS_MS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setVerdictRow(n.id, { phase: 'error', message: truncate(msg, 120) });
    }
  };
  const verdictBlockedCopy = verdictAvailability === 'no-operator-key'
    ? NEEDS_OPERATOR_KEY_COPY
    : verdictAvailability === 'device-unsupported'
      ? DEVICE_UNSUPPORTED_VERDICT_COPY
      : null;
  // Live tick while a session is active OR the socket is doing something
  // (dependant routes keep it alive with no session), OR there are "Family
  // asks" rows to age — drives the countdown, the "last frame Xs ago"
  // status line, and each ask's "Xs/Xm ago" age.
  const ticking = stayAwakeUntil !== null || serveStatus.phase === 'open' || serveStatus.phase === 'reconnecting' || hasEscalations;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now()); // sync to current time when a session is (re-)armed, before the first tick
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  const remaining = stayAwakeRemainingMs(stayAwakeUntil, now);


  function handleTimeButtonClick(minutes: number) {
    if (locked) {
      // Not unlocked; close panel for clean PIN entry, request unlock with pending minutes.
      // App.tsx will track the pending value and reopen panel + arm after unlock succeeds.
      onRequestUnlockWithPendingArm(minutes);
    } else if (stayAwakeUntil !== null) {
      // Already armed; add time to existing deadline instead of replacing
      const addedDeadline = stayAwakeUntil + minutes * 60_000;
      const totalMinutes = Math.ceil((addedDeadline - now) / 60_000);
      onArmStayAwake(totalMinutes);
    } else {
      // Not armed, unlocked; arm directly
      onArmStayAwake(minutes);
    }
  }

  const backdrop: CSSProperties = {
    position: 'fixed', inset: 0, zIndex: Z.panel,
    background: 'var(--scrim)',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
  };
  const sheet: CSSProperties = {
    background: 'var(--bg-card)', color: 'var(--text-primary)',
    width: '100%',
    maxWidth: 480,
    height: 'auto',
    maxHeight: '85vh',
    overflowY: 'auto',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderLeft: 'none',
    padding: '16px 16px calc(16px + env(safe-area-inset-bottom))',
    boxShadow: 'var(--shadow-lg)',
  };
  const sectionTitle: CSSProperties = {
    fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)',
    textTransform: 'uppercase', letterSpacing: 0.4, margin: '20px 0 8px',
  };

  // Compact time-button row shared by both armed and disarmed states.
  const timeRow = (
    <div style={{ display: 'flex', gap: 4, marginTop: 8, justifyContent: 'center' }}>
      {STAY_AWAKE_OPTIONS_MINUTES.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => handleTimeButtonClick(m)}
          style={{
            padding: '6px 12px',
            fontSize: 18,
            fontWeight: 600,
            border: '1px solid var(--border)',
            borderRadius: 4,
            cursor: 'pointer',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            flex: '0 1 auto',
          }}
        >
          +{m} min
        </button>
      ))}
      <button
        type="button"
        onClick={() => stayAwakeUntil !== null ? onCloseStayAwake() : onClose()}
        style={{
          padding: '6px 12px',
          fontSize: 18,
          fontWeight: 600,
          border: '1px solid var(--border)',
          borderRadius: 4,
          cursor: 'pointer',
          background: 'var(--bg-card)',
          color: 'var(--text-secondary)',
          flex: '0 1 auto',
        }}
      >
        Cancel
      </button>
    </div>
  );

  // Native-only always-on toggle. Green = serving; amber = turned on but
  // needs reactivating (locked, or stopped); grey = off. While locked a tap
  // asks for the unlock first (same flow as the +X row) and turns it on.
  const needsReactivating = alwaysOnWanted && !backgroundServing;
  const alwaysOnColour = backgroundServing ? 'var(--success)' : needsReactivating ? 'var(--warning)' : null;
  const alwaysOnRow = isNative ? (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        onClick={() => {
          if (locked) { onRequestUnlockForAlwaysOn(); return; }
          void onSetBackgroundServing(!backgroundServing);
        }}
        aria-pressed={backgroundServing}
        style={{
          width: '100%',
          padding: '8px 12px',
          fontSize: 16,
          fontWeight: 600,
          border: `1px solid ${alwaysOnColour ?? 'var(--border)'}`,
          borderRadius: 4,
          cursor: 'pointer',
          background: 'var(--bg-card)',
          color: alwaysOnColour ?? 'var(--text-secondary)',
        }}
      >
        {backgroundServing ? 'Always on — serving in background ✓'
          : needsReactivating ? 'Always on — tap to switch back on'
          : 'Always on (background)'}
      </button>
      {locked && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, textAlign: 'center' }}>
          You'll be asked to unlock first.
        </div>
      )}
    </div>
  ) : null;

  if (reviewed && isKinterestAuthority(reviewed.template)) {
    return <BunkerApprovalModal approval={reviewed}
      onApproveOnce={handle => { onApproveOnce(handle); setReviewHandle(null); }}
      onApproveAlways={handle => { onApproveOnce(handle); setReviewHandle(null); }}
      onDeny={handle => { onDeny(handle); setReviewHandle(null); }}
      onBack={() => setReviewHandle(null)} />;
  }
  return (
    <div style={backdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={sheet} role="dialog" aria-labelledby="bunker-panel-title" aria-modal="true">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 id="bunker-panel-title" style={{ margin: 0, fontSize: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="key" size={18} /> Bunker
          </h2>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4 }}>
            <Icon name="x" size={18} />
          </button>
        </div>

        {/* Serve signing requests — unified session section */}
        <div style={sectionTitle}>Serve signing requests</div>
        {!bunkerAllowed ? (
          <div>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.5, margin: '0 0 12px' }}>
              Bunker serving is turned off. Turn it on in Settings → Security to serve signing requests.
            </p>
            <button type="button" className="btn btn-secondary"
              onClick={onGoToSecurity} style={{ fontSize: 14, padding: '8px 16px' }}>
              Open Security settings
            </button>
          </div>
        ) : (stayAwakeUntil !== null || backgroundServing) ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
              <span aria-live="polite" style={{ fontSize: 15, fontWeight: 600, color: 'var(--success)' }}>
                Serving — <strong>{backgroundServing ? 'always on' : formatCountdown(remaining)}</strong>{backgroundServing ? '' : ' left'}
              </span>
            </div>
            <ServeStatusLine status={serveStatus} now={now} />
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: 4 }}>
              {backgroundServing ? 'Serving in the background · screen can be off' : 'Screen stays on · stays unlocked'}
            </div>
            {alwaysOnRow}
            {timeRow}
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.4, marginBottom: 8 }}>
              Be available to approve signing requests. Keeps the screen on and stays unlocked for the chosen time, then stops automatically.
            </div>
            {!wakeLockSupported && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.4 }}>
                Your screen may dim — keep the app open.
              </div>
            )}
            {hasDependants && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.4 }}>
                Your dependants' approvals always come through while the app is open — a session is for signing in to other apps.
              </div>
            )}
            <ServeStatusLine status={serveStatus} now={now} />
            {alwaysOnRow}
            {timeRow}
          </div>
        )}

        {/* Pending queue */}
        <div style={sectionTitle}>Pending requests</div>
        {pendingApprovals.length === 0 ? (
          <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>No pending requests.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {pendingApprovals.map((a) => {
              const target = dependantNameFor(a.route.dependantId) ?? 'You';
              return (
                <div key={a.handle} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{a.client.appName}</div>
                  {a.client.appUrl && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{a.client.appUrl}</div>
                  )}
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0' }}>
                    {a.description} · signing as <strong>{target}</strong>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    {isKinterestAuthority(a.template) ? (
                      <button type="button" className="btn btn-primary" onClick={() => setReviewHandle(a.handle)}
                        style={{ flex: 1, fontSize: 13, padding: '6px 0' }}>Review authorisation</button>
                    ) : <>
                      <button type="button" className="btn btn-primary" onClick={() => onApproveOnce(a.handle)}
                        style={{ flex: 1, fontSize: 13, padding: '6px 0' }}>Approve</button>
                      {a.alwaysAvailable && (
                        <button type="button" className="btn btn-secondary" onClick={() => onApproveAlways(a.handle)}
                          style={{ flex: 1, fontSize: 13, padding: '6px 0' }}>Always</button>
                      )}
                    </>}
                    <button type="button" className="btn btn-ghost" onClick={() => onDeny(a.handle)}
                      style={{ fontSize: 13, padding: '6px 10px', color: 'var(--danger)' }}>Deny</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* "Family asks" — parked approvals + paired-child petitions (C4/C5);
            "Waiting for approval" once an owner's own app's ask is listed */}
        {hasEscalations && (
          <>
            <div style={sectionTitle}>{escalationSectionTitle((escalationNotices ?? []).map(ownerOf))}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {childAskNote && (
                <div role="alert" style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ flex: 1 }}>{childAskNote}</span>
                  <button type="button" onClick={() => setChildAskNote(null)} aria-label="Dismiss"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 2 }}>
                    <Icon name="x" size={14} />
                  </button>
                </div>
              )}
              {hasChildAsks && childAsks!.map((p) => (
                <div key={p.ask.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                  <ChildAskCard pending={p} alwaysAvailable={childAskAlwaysAvailable?.(p.dependantId) ?? true} onDecide={onChildAskDecide!}
                    onOutcome={(r) => { const text = childAskOutcomeText(r); if (r.sent && text) setChildAskNote(text); }} />
                </div>
              ))}
              {(escalationNotices ?? []).map((n) => {
                const owner = ownerOf(n);
                const name = owner.kind === 'family' ? owner.name
                  : owner.kind === 'self' ? `${owner.name || shortNpub(n.identityPubkey)} (you)`
                  : shortNpub(n.identityPubkey);
                const client = shortNpub(n.clientPubkey);
                const ask = describeAsk(n.method, n.eventKind);
                const expired = n.kind === 'approval' && isParkExpired(n, Math.floor(now / 1000));
                const stateLabel = n.kind === 'petition'
                  ? `asked again ×${n.count ?? 1}`
                  : expired
                    ? `expired — a verdict will apply to ${owner.kind === 'family' ? 'their' : 'the app’s'} next try`
                    : 'waiting';
                return (
                  <div key={n.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{truncate(name, 64)}</div>
                      <button type="button" onClick={() => onDismissEscalation?.(n.id)} aria-label="Dismiss"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 2 }}>
                        <Icon name="x" size={14} />
                      </button>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>app {client}</div>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0' }}>
                      {truncate(ask, 64)} · {escalationAge(n.createdAt, now)}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: expired ? 'var(--warning)' : 'var(--text-secondary)' }}>
                      {stateLabel}
                    </div>
                    {n.kind === 'petition' ? (
                      // A petition has no park to resolve — the answer is a
                      // rules change (Persona → Advanced), not a verdict.
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                        <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)' }}>
                          Answer by changing their rules; dismiss when handled.
                        </span>
                        <button type="button" className="btn btn-secondary" onClick={() => onDismissEscalation?.(n.id)}
                          style={{ fontSize: 13, padding: '6px 10px' }}>Dismiss</button>
                      </div>
                    ) : (() => {
                      const row = verdictRows.get(n.id);
                      if (row?.phase === 'sending') {
                        return (
                          <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-secondary)' }} aria-live="polite">Sending…</div>
                        );
                      }
                      if (row?.phase === 'done') {
                        return (
                          <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600, color: 'var(--success)' }} aria-live="polite">{row.message}</div>
                        );
                      }
                      const canSend = !!onEscalationVerdict && !!n.parkId && !verdictBlockedCopy;
                      const blocked = verdictBlockedCopy ?? (!n.parkId ? 'This ask carries no park id — nothing to resolve' : undefined);
                      return (
                        <>
                          {row?.phase === 'error' && (
                            <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--danger)' }}>{row.message}</div>
                          )}
                          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                            <button type="button" className="btn btn-primary" disabled={!canSend}
                              onClick={() => { void sendVerdict(n, 'approve-once'); }}
                              title={blocked} aria-label={blocked ? `Approve — ${blocked}` : 'Approve'}
                              style={{ flex: 1, fontSize: 13, padding: '6px 0', ...(canSend ? {} : { opacity: 0.5, cursor: 'not-allowed' }) }}>Approve</button>
                            <button type="button" className="btn btn-ghost" disabled={!canSend}
                              onClick={() => { void sendVerdict(n, 'deny'); }}
                              title={blocked} aria-label={blocked ? `Deny — ${blocked}` : 'Deny'}
                              style={{ fontSize: 13, padding: '6px 10px', color: 'var(--danger)', ...(canSend ? {} : { opacity: 0.5, cursor: 'not-allowed' }) }}>Deny</button>
                          </div>
                          {blocked && (
                            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)' }}>{blocked}</div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Caps a device-derived display string, matching the codebase's existing 64-char truncation idiom (e.g. `audit-fetch.ts` `displayOrigin`). */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** "42s ago" / "3m ago" / "2h ago" / "1d ago" for a unix-seconds `createdAt`. */
function escalationAge(createdAtSeconds: number, nowMs: number): string {
  const s = Math.max(0, Math.round(nowMs / 1000 - createdAtSeconds));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "what's asked" label — friendly kind label for sign_event, else the raw method. */
function describeAsk(method: string, eventKind?: number): string {
  if (method === 'sign_event' && typeof eventKind === 'number') {
    // Stub `UnsignedEvent` — only `kind` is real; safe only as long as
    // `describeEventTemplate` reads nothing else off the template.
    return describeEventTemplate({ kind: eventKind, pubkey: '', created_at: 0, tags: [], content: '' });
  }
  return method;
}

/** "42s ago" / "3m ago" / "none yet" for the status line. */
function frameAge(ts: number | null, now: number): string {
  if (ts === null) return 'none yet';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

/**
 * One line of socket truth under the serve section. Replaces the old static
 * "Listening for requests" assertion: a subscription that never opened, was
 * silently severed upstream, or is stuck reconnecting now says so on the
 * device — no USB debugging required.
 */
function ServeStatusLine({ status, now }: { status: BunkerServeStatus; now: number }) {
  const relay = status.relayUrl ? status.relayUrl.replace(/^wss?:\/\//, '') : '';
  let text: string;
  let warn = false;
  switch (status.phase) {
    case 'off':
      text = 'Socket: not listening (no active session)';
      break;
    case 'no-routes':
      text = 'Socket: not listening — no identities to serve';
      warn = true;
      break;
    case 'bad-relay':
      text = `Socket: not listening — relay URL invalid (${status.relayUrl ?? 'empty'})`;
      warn = true;
      break;
    case 'connecting':
      text = `Socket: connecting to ${relay}…`;
      break;
    case 'reconnecting':
      text = `Socket: dropped — reconnecting to ${relay} (try ${status.reconnectAttempt})`;
      warn = true;
      break;
    case 'open':
      text = `Socket: listening on ${relay} · ${status.routePubkeys.length} identit${status.routePubkeys.length === 1 ? 'y' : 'ies'} · last frame: ${frameAge(status.lastFrameAt, now)}`;
      break;
  }
  return (
    <div style={{
      fontSize: 12, lineHeight: 1.5, marginTop: 8, wordBreak: 'break-word',
      color: warn ? 'var(--warning)' : 'var(--text-secondary)',
    }}>
      {text}
      {status.lastNotice && (
        <div>Relay notice: {status.lastNotice}</div>
      )}
    </div>
  );
}
