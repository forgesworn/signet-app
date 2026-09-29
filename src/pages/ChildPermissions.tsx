/**
 * Permissions for a child's own phone paired straight to the Heartwood
 * (spec §9.3, §9.4). One page, two viewers:
 *
 *   guardian — per persona: the rules (type · site/app · Always allow/deny ·
 *              last used) with Revoke, and "Remove from <name>'s phone"
 *              (operator `revoke_client_identity`, after a confirm); the
 *              compiled Heartwood ceiling in human names; the stage (changed
 *              on PersonaAdvanced); the apps on the phone with Block; the
 *              asks history; Unpair (after a confirm).
 *   child    — the same layout from the rules payload and its own connected
 *              apps, read-only: no buttons at all.
 *
 * Presentational: every effect is a callback the caller owns. One flow — the
 * mobile layout, framed on desktop by DesktopFrame.
 */
import { useMemo, useState } from 'react';
import type { AutonomyStage, DependantIdentity } from '../types';
import type { ChildRule } from '../types/child-rules';
import type { ConnectedChildApp } from '../lib/child-activity';
import type { AuditEntry } from '../lib/audit-fetch';
import type { ChildAskHistoryEntry } from '../hooks/useChildAsks';
import { useChildActivity } from '../hooks/useChildActivity';
import { useChildDevicePairing, type UseChildDevicePairingOpts } from '../hooks/useChildDevicePairing';
import { childRulesPayloadFor } from '../hooks/useChildRulesPublisher';
import { askTargetText } from '../components/ChildAskCard';
import { ceilingTypeNames, isAppBlocked, permissionPersonas, ruleTypeName } from '../lib/child-permissions';
import { CHILD_DEVICE_COPY, CHILD_PERMISSIONS_COPY as COPY } from '../lib/child-device-copy';

export interface ChildPermissionsProps {
  viewer: 'guardian' | 'child';
  childName: string;
  personas: { pubkey: string; name: string }[];
  /** Null on a child whose rules have not arrived yet. */
  stage: AutonomyStage | null;
  paused?: boolean;
  /** Live rules for this dependant. */
  rules: ChildRule[];
  /** The Heartwood ceiling; null when unknown (no rules yet on the child). */
  ceilingKinds: number[] | null;
  apps: ConnectedChildApp[];
  disconnectedApps: string[];
  /** Guardian only: past asks and verdicts for this dependant. */
  history?: ChildAskHistoryEntry[];
  paired: boolean;
  nowMs?: number;
  onRevokeRule?: (rule: ChildRule) => Promise<void>;
  onBlockApp?: (app: ConnectedChildApp) => Promise<void>;
  onRemovePersona?: (pubkey: string) => Promise<void>;
  onUnpair?: () => Promise<void>;
  onOpenStage?: () => void;
}

const muted = { fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5 } as const;
const small = { fontSize: '0.78rem', color: 'var(--text-muted)' } as const;
const row = { padding: '10px 0', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 } as const;
const grow = { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } as const;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function dateText(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function RuleRow({ rule, guardian, onRevoke }: { rule: ChildRule; guardian: boolean; onRevoke?: (r: ChildRule) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = clip(askTargetText(rule.target), 60);
  const label = rule.label ? clip(rule.label, 60) : '';
  const showLabel = label.length > 0 && label.toLowerCase() !== target.toLowerCase();
  return (
    <div data-testid="child-rule" style={row}>
      <div style={grow}>
        <div style={{ fontSize: '0.92rem' }}>{ruleTypeName(rule.scope)} · {target}</div>
        {showLabel && <div style={small}>{label}</div>}
        <div style={small}>
          {rule.decision === 'allow' ? COPY.allow : COPY.deny}
          {' · '}
          {typeof rule.lastUsedAt === 'number' ? COPY.lastUsed(dateText(rule.lastUsedAt)) : COPY.neverUsed}
        </div>
        {error && <div role="alert" style={{ ...small, color: 'var(--danger)' }}>{error}</div>}
      </div>
      {guardian && onRevoke && (
        <button
          className="btn btn-secondary"
          disabled={busy}
          style={{ width: 'auto', flexShrink: 0 }}
          onClick={async () => {
            setBusy(true); setError(null);
            try { await onRevoke(rule); } catch { setError(COPY.revokeFailed); } finally { setBusy(false); }
          }}
        >
          {busy ? COPY.revoking : COPY.revoke}
        </button>
      )}
    </div>
  );
}

function PersonaSection({ testId, heading, rules, guardian, onRevoke, removal }: {
  testId: string;
  heading: string;
  rules: ChildRule[];
  guardian: boolean;
  onRevoke?: (r: ChildRule) => Promise<void>;
  removal?: { childName: string; personaName: string; onRemove: () => Promise<void> };
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div data-testid={testId} style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{heading}</div>
      {rules.length === 0
        ? <p style={small}>{COPY.noRules}</p>
        : rules.map(r => <RuleRow key={r.id} rule={r} guardian={guardian} onRevoke={onRevoke} />)}
      {guardian && removal && (done ? (
        <p style={{ ...muted, marginTop: 8 }}>{COPY.removed(removal.childName)}</p>
      ) : !confirm ? (
        <button className="btn" style={{ marginTop: 8, fontSize: '0.85rem', color: 'var(--text-muted)' }} onClick={() => setConfirm(true)}>
          {COPY.removePersona(removal.childName)}
        </button>
      ) : (
        <div className="card" style={{ padding: 16, marginTop: 8, border: '1px solid var(--danger)' }}>
          <p style={{ ...muted, marginBottom: 12 }}>{COPY.removePersonaConfirm(removal.personaName, removal.childName)}</p>
          {error && <p role="alert" style={{ ...small, color: 'var(--danger)', marginBottom: 8 }}>{error}</p>}
          <button
            className="btn btn-danger"
            disabled={busy}
            style={{ width: '100%', marginBottom: 8 }}
            onClick={async () => {
              setBusy(true); setError(null);
              try { await removal.onRemove(); setDone(true); setConfirm(false); }
              catch { setError(COPY.removeFailed); }
              finally { setBusy(false); }
            }}
          >
            {busy ? COPY.removing : COPY.removeNow}
          </button>
          <button className="btn" disabled={busy} style={{ width: '100%' }} onClick={() => setConfirm(false)}>{COPY.cancel}</button>
        </div>
      ))}
    </div>
  );
}

function AppRow({ app, personaName, blocked, guardian, onBlock }: {
  app: ConnectedChildApp; personaName: string; blocked: boolean; guardian: boolean; onBlock?: (a: ConnectedChildApp) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div data-testid="child-app" style={row}>
      <div style={grow}>
        <div style={{ fontSize: '0.92rem' }}>{clip(app.label, 60)}</div>
        <div style={small}>
          {COPY.appKind[app.kind] ?? app.kind} · {COPY.as(clip(personaName, 40))} · {COPY.lastUsed(dateText(app.lastUsed * 1000))}
        </div>
        {error && <div role="alert" style={{ ...small, color: 'var(--danger)' }}>{error}</div>}
      </div>
      {blocked ? (
        <span style={{ ...small, color: 'var(--danger)', flexShrink: 0 }}>{COPY.blocked}</span>
      ) : guardian && onBlock ? (
        <button
          className="btn btn-secondary"
          disabled={busy}
          style={{ width: 'auto', flexShrink: 0 }}
          onClick={async () => {
            setBusy(true); setError(null);
            try { await onBlock(app); } catch { setError(COPY.blockFailed); } finally { setBusy(false); }
          }}
        >
          {busy ? COPY.blocking : COPY.block}
        </button>
      ) : null}
    </div>
  );
}

export function ChildPermissions(props: ChildPermissionsProps) {
  const { viewer, childName, personas, stage, rules, ceilingKinds, apps, disconnectedApps, history, paired } = props;
  const guardian = viewer === 'guardian';
  const nowMs = props.nowMs ?? Date.now();
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [unpairing, setUnpairing] = useState(false);
  const [unpairError, setUnpairError] = useState<string | null>(null);

  const names = useMemo(() => new Map(personas.map(p => [p.pubkey.toLowerCase(), p.name])), [personas]);
  const nameOf = (pk: string) => names.get(pk.toLowerCase()) ?? `${pk.slice(0, 8)}…`;
  const byPersona = useMemo(() => {
    const m = new Map<string, ChildRule[]>();
    for (const r of rules) {
      const k = r.persona === '*' ? '*' : r.persona.toLowerCase();
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    for (const list of m.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
    return m;
  }, [rules]);
  // Rules for a persona no longer listed (e.g. removed) still show, under its short key.
  const orphanPersonas = [...byPersona.keys()].filter(k => k !== '*' && !names.has(k));

  const ceiling = props.paused ? null : ceilingKinds === null ? null : ceilingTypeNames(ceilingKinds, stage ?? 'full-control');

  return (
    <div className="fade-in">
      <div className="card section">
        <p style={muted}>
          {guardian
            ? (paired ? COPY.pairedStatus(childName) : COPY.notPaired(childName))
            : (paired ? CHILD_DEVICE_COPY.pairedHeading : COPY.unpairedChild)}
        </p>
        {!guardian && stage === null && <p style={{ ...muted, marginTop: 8 }}>{COPY.noRulesYet}</p>}
      </div>

      {stage && (
        <div className="card section">
          <div className="section-title">{COPY.stage}</div>
          <p style={muted}>{COPY.stageName[stage] ?? stage}</p>
          {guardian && props.onOpenStage && (
            <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={props.onOpenStage}>{COPY.changeStage}</button>
          )}
        </div>
      )}

      {(ceiling !== null || props.paused) && (
        <div className="card section">
          <div className="section-title">{COPY.ceilingHeading}</div>
          <p style={{ ...small, marginBottom: 8 }}>{COPY.ceilingBody}</p>
          <div data-testid="ceiling-types" style={muted}>
            {props.paused || !ceiling || ceiling.length === 0 ? COPY.ceilingLocked : ceiling.join(' · ')}
          </div>
        </div>
      )}

      <div className="card section">
        <div className="section-title">{COPY.rulesHeading}</div>
        {personas.map(p => (
          <PersonaSection
            key={p.pubkey}
            testId={`persona-${p.pubkey.toLowerCase()}`}
            heading={p.name}
            rules={byPersona.get(p.pubkey.toLowerCase()) ?? []}
            guardian={guardian}
            onRevoke={props.onRevokeRule}
            {...(guardian && props.onRemovePersona && paired ? {
              removal: { childName, personaName: p.name, onRemove: () => props.onRemovePersona!(p.pubkey.toLowerCase()) },
            } : {})}
          />
        ))}
        {orphanPersonas.map(k => (
          <PersonaSection key={k} testId={`persona-${k}`} heading={nameOf(k)} rules={byPersona.get(k) ?? []} guardian={guardian} onRevoke={props.onRevokeRule} />
        ))}
        {(byPersona.get('*')?.length ?? 0) > 0 && (
          <PersonaSection testId="persona-*" heading={COPY.allPersonas(childName)} rules={byPersona.get('*')!} guardian={guardian} onRevoke={props.onRevokeRule} />
        )}
      </div>

      <div className="card section">
        <div className="section-title">{guardian ? COPY.appsHeading(childName) : COPY.appsHeadingChild}</div>
        {apps.length === 0
          ? <p style={small}>{COPY.noApps}</p>
          : apps.map(a => (
            <AppRow
              key={`${a.kind}:${a.appId}:${a.persona}`}
              app={a}
              personaName={nameOf(a.persona)}
              blocked={isAppBlocked(a, rules, disconnectedApps, nowMs)}
              guardian={guardian}
              onBlock={props.onBlockApp}
            />
          ))}
      </div>

      {guardian && history && (
        <div className="card section" data-testid="child-ask-history">
          <div className="section-title">{COPY.asksHeading}</div>
          {history.length === 0 ? <p style={small}>{COPY.noAsks}</p> : history.slice(0, 50).map(h => (
            <div key={h.ask.id} style={row}>
              <div style={grow}>
                <div style={{ fontSize: '0.92rem' }}>
                  {ruleTypeName(h.ask.scope ?? `kind:${h.ask.kind}`)} · {clip(askTargetText(h.ask.target), 60)}
                </div>
                <div style={small}>
                  {COPY.as(clip(nameOf(h.ask.persona), 40))} · {h.sent === false ? COPY.notSent : (COPY.verdict[h.verdict.verdict] ?? h.verdict.verdict)} · {dateText(h.ask.createdAt * 1000)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {guardian && paired && props.onUnpair && (
        <div className="card section">
          <div className="section-title">{COPY.unpairHeading}</div>
          {unpairError && <p role="alert" style={{ color: 'var(--danger)', marginBottom: 12 }}>{unpairError}</p>}
          {!confirmUnpair ? (
            <button className="btn" style={{ color: 'var(--text-muted)' }} onClick={() => setConfirmUnpair(true)}>{CHILD_DEVICE_COPY.unpair}</button>
          ) : (
            <div className="card" style={{ padding: 16, border: '1px solid var(--danger)' }}>
              <p style={{ ...muted, marginBottom: 12 }}>{CHILD_DEVICE_COPY.unpairConfirm(childName)}</p>
              <button
                className="btn btn-danger"
                disabled={unpairing}
                style={{ width: '100%', marginBottom: 8 }}
                onClick={async () => {
                  setUnpairing(true); setUnpairError(null);
                  try { await props.onUnpair!(); setConfirmUnpair(false); }
                  catch (e) { setUnpairError(e instanceof Error ? e.message : CHILD_DEVICE_COPY.errors.unpair); }
                  finally { setUnpairing(false); }
                }}
              >
                {unpairing ? CHILD_DEVICE_COPY.unpairing : CHILD_DEVICE_COPY.unpairNow}
              </button>
              <button className="btn" disabled={unpairing} style={{ width: '100%' }} onClick={() => setConfirmUnpair(false)}>{COPY.cancel}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const NO_DEVICE_ENTRIES: AuditEntry[] = [];

export interface ChildPermissionsGuardianRouteProps {
  dependant: DependantIdentity;
  /** All child rules INCLUDING tombstones (every dependant); null while loading. */
  childRules: ChildRule[] | null;
  approvedOnce: { kind: number; until: number }[];
  relays: string[];
  encryptionKey: string | null;
  /** The child-direct pairing options (same as the pairing page) — Unpair runs through them. */
  pairing: Omit<UseChildDevicePairingOpts, 'dependant'>;
  history: ChildAskHistoryEntry[];
  onRevokeRule(rule: ChildRule): Promise<void>;
  onBlockApp(app: ConnectedChildApp): Promise<void>;
  onRemovePersona(pubkey: string): Promise<void>;
  onOpenStage(): void;
  onUnpaired(): void;
}

/** Guardian wiring: the rules payload the child would receive, the child's connected apps, and Unpair. */
export function ChildPermissionsGuardianRoute(p: ChildPermissionsGuardianRouteProps) {
  const dep = p.dependant;
  const pairing = useChildDevicePairing({ ...p.pairing, dependant: dep });
  const { apps } = useChildActivity({ dependant: dep, relays: p.relays, encryptionKey: p.encryptionKey, deviceEntries: NO_DEVICE_ENTRIES });
  const nowMs = Date.now();
  const payload = p.childRules ? childRulesPayloadFor(dep, p.childRules, p.approvedOnce, nowMs) : null;
  // The page shows usage times the wire strips; take them from the guardian's own rows.
  const rules = useMemo(() => {
    if (!payload || !p.childRules) return [];
    const byId = new Map(p.childRules.map(r => [r.id, r]));
    return payload.rules.map(r => ({ ...r, ...(byId.get(r.id)?.lastUsedAt ? { lastUsedAt: byId.get(r.id)!.lastUsedAt } : {}) }));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- payload derives from these
  }, [p.childRules, dep]);
  const history = useMemo(() => p.history.filter(h => h.ask.dependantId.toLowerCase() === dep.id.toLowerCase()), [p.history, dep.id]);
  return (
    <ChildPermissions
      viewer="guardian"
      childName={dep.displayName}
      personas={permissionPersonas(dep)}
      stage={dep.autonomyStage}
      paused={dep.defaultSchedule?.paused === true}
      rules={rules}
      ceilingKinds={payload ? payload.ceilingKinds : null}
      apps={apps}
      disconnectedApps={payload?.disconnectedApps ?? []}
      history={history}
      paired={dep.childDevice?.mode === 'heartwood-direct'}
      nowMs={nowMs}
      onRevokeRule={p.onRevokeRule}
      onBlockApp={p.onBlockApp}
      onRemovePersona={p.onRemovePersona}
      onUnpair={async () => { await pairing.unpair(); p.onUnpaired(); }}
      onOpenStage={p.onOpenStage}
    />
  );
}
