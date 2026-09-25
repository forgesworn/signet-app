/**
 * Audit log viewer.
 *
 * Per-dependant timeline of signing decisions. Read-only. Pull-to-refresh
 * via an explicit button — the actual fetch is one-shot through
 * `useAuditLog`. See that hook for the consumer-side privacy posture.
 *
 * `viewer` distinguishes the guardian surface (third-person framing —
 * "{dependant}'s activity") from the child surface (first-person —
 * "Your activity"). Layout and grouping are identical; only copy
 * differs. Both pull through `useAuditLog`.
 */

import { useMemo } from 'react';
import type { DependantIdentity } from '../types';
import type { AuditEntry } from '../lib/audit-fetch';
import { groupAuditByDay, summariseAudit } from '../lib/audit-fetch';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import { useAuditLog, type AuditDecryptStrategy } from '../hooks/useAuditLog';
import { Icon } from '../components/Icon';

type Viewer = 'guardian' | 'child';

interface Props {
  dependant: DependantIdentity;
  entries: AuditEntry[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  /** 'guardian' = "{name}'s activity"; 'child' = "Your activity". */
  viewer?: Viewer;
}

export function Activity({ dependant, entries, loading, error, onRefresh, viewer = 'guardian' }: Props) {
  const groups = useMemo(() => groupAuditByDay(entries, new Date()), [entries]);

  const headerTitle = viewer === 'child'
    ? 'Your activity'
    : `${dependant.displayName}'s activity`;

  const emptyCopy = viewer === 'child'
    ? 'Things you sign will show up here.'
    : `Apps that act as ${dependant.displayName} via Signet will appear here.`;

  // ── Header (always rendered) ──────────────────────────────────────────────
  const header = (
    <div className="section" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
      <h2 style={{ margin: 0, fontSize: '1.05rem' }}>{headerTitle}</h2>
      <button
        className="btn btn-ghost btn-sm"
        onClick={onRefresh}
        disabled={loading}
        style={{ flexShrink: 0 }}
      >
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  );

  // ── Loading state ──────────────────────────────────────────────────────────
  if (loading && entries.length === 0) {
    return (
      <div className="fade-in" role="main">
        {header}
        <div className="card section" style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>
          Loading activity…
        </div>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (error && entries.length === 0) {
    return (
      <div className="fade-in" role="main">
        {header}
        <div className="card section" style={{ textAlign: 'center', padding: 24 }}>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 12, fontSize: '0.9rem' }}>
            Couldn't load activity. Tap to retry.
          </p>
          <button className="btn btn-secondary" onClick={onRefresh}>Retry</button>
        </div>
      </div>
    );
  }

  // ── Empty state ────────────────────────────────────────────────────────────
  if (entries.length === 0) {
    return (
      <div className="fade-in" role="main">
        {header}
        <div className="empty-state">
          <div className="empty-state-icon"><Icon name="clipboard" size={36} /></div>
          <h3 className="empty-state-title">No activity yet</h3>
          <p className="empty-state-text">{emptyCopy}</p>
        </div>
      </div>
    );
  }

  // ── Populated list ────────────────────────────────────────────────────────
  return (
    <div className="fade-in" role="main">
      {header}
      {groups.map((g) => (
        <div key={g.dayLabel} className="section">
          <div className="section-title" style={{ marginBottom: 6 }}>{g.dayLabel}</div>
          <div className="card card-flush" style={{ overflow: 'hidden' }}>
            {g.entries.map((entry, ix) => (
              <div
                key={entry.id}
                style={{
                  padding: '12px 14px',
                  borderBottom: ix < g.entries.length - 1 ? '1px solid var(--border)' : 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <div style={{ fontSize: '0.92rem' }}>
                  {summariseAudit(entry, dependant.displayName)}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {formatRelative(entry.createdAt)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Thin route wrapper that owns the `useAuditLog` hook call. Keeps the
 * presentational `Activity` component pure (no relay, no decrypt) so
 * the unit tests in `audit-fetch.test.ts` can exercise the rendering
 * helpers without standing up the hook.
 *
 * Two flavours:
 *   - **Guardian** (v1): pass `recipientPubkey = guardianPubkey` and
 *     `decrypt: { kind: 'backend', backend: guardianBackend }`. Reads
 *     the guardian-addressed gift-wraps.
 *   - **Child** (v2): pass
 *     `recipientPubkey = childClientPubkey` (the dep's NIP-46 client
 *     pubkey) and `decrypt: { kind: 'privkey', hex: childClientPrivkey }`.
 *     Reads the dual-address gift-wraps emitted when audit visibility
 *     resolves true for this dep.
 */
interface ActivityRouteProps {
  dependant: DependantIdentity;
  recipientPubkey: string;
  /** Guardian's real signing pubkey — see C1 note on `useAuditLog`. */
  expectedSignerPubkey: string;
  decrypt: AuditDecryptStrategy | null;
  relayUrl: string;
  viewer?: Viewer;
}

export function ActivityRoute({ dependant, recipientPubkey, expectedSignerPubkey, decrypt, relayUrl, viewer }: ActivityRouteProps) {
  const { entries, loading, error, refresh } = useAuditLog({
    dependantId: dependant.id,
    recipientPubkey,
    expectedSignerPubkey,
    decrypt,
    relayUrl,
  });
  return (
    <Activity
      dependant={dependant}
      entries={entries}
      loading={loading}
      error={error}
      onRefresh={() => { void refresh(); }}
      viewer={viewer}
    />
  );
}

/**
 * Backwards-compatible guardian-mode wrapper for App.tsx. Translates
 * the old (guardianPubkey, guardianBackend) shape into the new
 * `decrypt` strategy. Keeps the call site thin and survives an
 * absent backend by passing `null` so the hook stays idle.
 */
interface GuardianActivityRouteProps {
  dependant: DependantIdentity;
  guardianPubkey: string;
  guardianBackend: DecryptingSigningBackend | null;
  relayUrl: string;
}

export function GuardianActivityRoute({ dependant, guardianPubkey, guardianBackend, relayUrl }: GuardianActivityRouteProps) {
  return (
    <ActivityRoute
      dependant={dependant}
      recipientPubkey={guardianPubkey}
      expectedSignerPubkey={guardianPubkey}
      decrypt={guardianBackend ? { kind: 'backend', backend: guardianBackend } : null}
      relayUrl={relayUrl}
      viewer="guardian"
    />
  );
}

/**
 * Paired-child-side audit surface (v2). The
 * dep's device holds the bunker client privkey directly, so we pass
 * a `privkey` strategy and skip the backend ceremony.
 */
interface ChildActivityRouteProps {
  dependant: DependantIdentity;
  childClientPubkey: string;
  childClientPrivkey: string | null;
  /**
   * Guardian's real signing pubkey, pinned on this device at pair time
   * (see `PairedChildRecord.guardianPubkey`). Both the guardian-addressed
   * and child-addressed audit wraps are sealed with this key (C1) — a
   * missing/unknown value (e.g. a pre-C1 pairing that hasn't re-paired)
   * fails closed: `useAuditLog` rejects every entry rather than trusting
   * an unverified signer.
   */
  guardianPubkey: string | null;
  relayUrl: string;
}

export function ChildActivityRoute({ dependant, childClientPubkey, childClientPrivkey, guardianPubkey, relayUrl }: ChildActivityRouteProps) {
  return (
    <ActivityRoute
      dependant={dependant}
      recipientPubkey={childClientPubkey}
      expectedSignerPubkey={guardianPubkey ?? ''}
      decrypt={childClientPrivkey && guardianPubkey ? { kind: 'privkey', hex: childClientPrivkey } : null}
      relayUrl={relayUrl}
      viewer="child"
    />
  );
}

/** Short relative-time string with an absolute fallback after ~7 days. */
function formatRelative(createdAt: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, nowSec - createdAt);
  if (delta < 60) return 'just now';
  if (delta < 60 * 60) {
    const m = Math.floor(delta / 60);
    return `${m}m ago`;
  }
  if (delta < 24 * 60 * 60) {
    const h = Math.floor(delta / 3600);
    return `${h}h ago`;
  }
  if (delta < 7 * 24 * 60 * 60) {
    const d = Math.floor(delta / (24 * 60 * 60));
    return `${d}d ago`;
  }
  return new Date(createdAt * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
