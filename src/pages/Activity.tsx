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
import { useChildActivity, dependantPersonaPubkeys } from '../hooks/useChildActivity';
import type { MergedActivityRow } from '../lib/child-activity';
import { CHILD_ACTIVITY_COPY } from '../lib/child-device-copy';
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
  /**
   * A child's own phone paired straight to the Heartwood (spec §9.2): the
   * merged timeline (the phone's records joined with the Heartwood's) replaces
   * `entries` as the list.
   */
  merged?: MergedActivityRow[];
}

export function Activity({ dependant, entries, loading, error, onRefresh, viewer = 'guardian', merged }: Props) {
  const groups = useMemo(() => groupAuditByDay(entries, new Date()), [entries]);
  const personaNames = useMemo(() => personaNameMap(dependant), [dependant]);

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

  if (merged) {
    return (
      <div className="fade-in" role="main">
        {header}
        {merged.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><Icon name="clipboard" size={36} /></div>
            <h3 className="empty-state-title">No activity yet</h3>
            <p className="empty-state-text">{CHILD_ACTIVITY_COPY.empty(dependant.displayName)}</p>
          </div>
        ) : groupMergedByDay(merged).map((g) => (
          <div key={g.dayLabel} className="section">
            <div className="section-title" style={{ marginBottom: 6 }}>{g.dayLabel}</div>
            <div className="card card-flush" style={{ overflow: 'hidden' }}>
              {g.rows.map((row, ix) => (
                <MergedRow key={rowKey(row, ix)} row={row} last={ix === g.rows.length - 1} childName={dependant.displayName} personaNames={personaNames} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

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
  /** Needed for a child's phone paired straight to the Heartwood (idle while null). */
  encryptionKey?: string | null;
}

export function GuardianActivityRoute({ dependant, guardianPubkey, guardianBackend, relayUrl, encryptionKey = null }: GuardianActivityRouteProps) {
  if (dependant.childDevice?.mode === 'heartwood-direct') {
    return (
      <ChildDirectActivityRoute
        dependant={dependant}
        guardianPubkey={guardianPubkey}
        guardianBackend={guardianBackend}
        relayUrl={relayUrl}
        encryptionKey={encryptionKey}
      />
    );
  }
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
 * A child's own phone paired straight to the Heartwood (spec §9.2): the
 * Heartwood's C5 records (to the guardian NP, one per persona it signed as)
 * joined with the phone's own gate decisions (to the rail key).
 */
function ChildDirectActivityRoute({ dependant, guardianPubkey, guardianBackend, relayUrl, encryptionKey }: Required<Omit<GuardianActivityRouteProps, 'encryptionKey'>> & { encryptionKey: string | null }) {
  const dependantIds = useMemo(() => dependantPersonaPubkeys(dependant), [dependant]);
  const decrypt = useMemo<AuditDecryptStrategy | null>(() => (guardianBackend ? { kind: 'backend', backend: guardianBackend } : null), [guardianBackend]);
  const { entries, loading, error, refresh } = useAuditLog({
    dependantId: dependant.id,
    dependantIds,
    recipientPubkey: guardianPubkey,
    expectedSignerPubkey: guardianPubkey,
    decrypt,
    relayUrl,
  });
  const relays = useMemo(() => [relayUrl], [relayUrl]);
  const { rows } = useChildActivity({ dependant, relays, encryptionKey, deviceEntries: entries });
  return (
    <Activity
      dependant={dependant}
      entries={entries}
      loading={loading}
      error={error}
      onRefresh={() => { void refresh(); }}
      viewer="guardian"
      merged={rows}
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

// ── Merged timeline rendering (child-direct) ─────────────────────────────────

function personaNameMap(dep: DependantIdentity): Map<string, string> {
  const m = new Map<string, string>();
  const put = (pk: string | undefined, name: string | undefined) => {
    if (pk && name) m.set(pk.toLowerCase(), name);
  };
  put(dep.naturalPerson?.publicKey, dep.naturalPerson?.displayName || dep.displayName);
  put(dep.persona?.publicKey, dep.persona?.displayName || dep.displayName);
  for (const x of dep.extraPersonas ?? []) put(x.publicKey, x.displayName);
  return m;
}

function rowTime(r: MergedActivityRow): number {
  return r.device?.createdAt ?? r.entry?.at ?? 0;
}

function rowKey(r: MergedActivityRow, ix: number): string {
  return `${r.device?.id ?? ''}|${r.entry ? `${r.entry.persona}:${r.entry.at}:${r.entry.requestCreatedAt ?? ''}:${r.entry.outcome}` : ''}|${ix}`;
}

function groupMergedByDay(rows: MergedActivityRow[]): Array<{ dayLabel: string; rows: MergedActivityRow[] }> {
  // Reuse the audit grouping (day labels) by projecting each row to its time.
  const byId = new Map<string, MergedActivityRow>();
  const proxies: AuditEntry[] = rows.map((r, ix) => {
    const id = String(ix);
    byId.set(id, r);
    return { id, dependantPubkey: '', createdAt: rowTime(r), outcome: 'approved' };
  });
  return groupAuditByDay(proxies, new Date()).map(g => ({ dayLabel: g.dayLabel, rows: g.entries.map(e => byId.get(e.id)!) }));
}

function mergedSummary(row: MergedActivityRow): string {
  const kind = row.entry ? row.entry.kind : row.device?.eventKind ?? null;
  if (kind === null || kind === undefined) return CHILD_ACTIVITY_COPY.crypto;
  const target = row.entry?.target;
  const origin = target && target.startsWith('site:') ? target.slice(5) : row.device?.origin;
  return summariseAudit({ id: '', dependantPubkey: '', createdAt: 0, outcome: 'approved', eventKind: kind, ...(origin ? { origin } : {}) });
}

function MergedRow({ row, last, childName, personaNames }: { row: MergedActivityRow; last: boolean; childName: string; personaNames: Map<string, string> }) {
  const persona = row.entry?.persona ?? row.device?.dependantPubkey ?? '';
  const personaName = personaNames.get(persona) ?? `${persona.slice(0, 8)}…`;
  const app = row.entry ? row.entry.appLabel : row.byGuardian ? CHILD_ACTIVITY_COPY.signedByYou : CHILD_ACTIVITY_COPY.onHeartwood;
  const outcome = row.entry
    ? CHILD_ACTIVITY_COPY.outcome[row.entry.outcome] ?? row.entry.outcome
    : (row.device?.outcome === 'denied' || row.device?.outcome === 'auto-denied' ? CHILD_ACTIVITY_COPY.outcome.denied : CHILD_ACTIVITY_COPY.outcome.signed);
  return (
    <div
      data-testid="merged-activity-row"
      style={{ padding: '12px 14px', borderBottom: last ? 'none' : '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      <div style={{ fontSize: '0.92rem' }}>{mergedSummary(row)}</div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
        {CHILD_ACTIVITY_COPY.as(personaName)} · {app} · {outcome}
      </div>
      {row.mismatch ? (
        <div role="alert" style={{ fontSize: '0.8rem', color: 'var(--warning)' }}>{CHILD_ACTIVITY_COPY.mismatch(childName)}</div>
      ) : null}
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{formatRelative(rowTime(row))}</div>
    </div>
  );
}
