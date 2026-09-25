/**
 * Companion apps list — one row per active data-rail grant (Task 11 of the
 * companion-data-rail plan). Revoking overwrites the replaceable snapshot
 * with a tombstone, best-effort kind-5 deletes the last snapshot, and
 * drops the local grant record (`revokeCompanionGrant`, companion-rail.ts).
 * Copy semantics: an app that already downloaded a snapshot keeps it —
 * revoking stops future updates, it doesn't recall the past.
 *
 * Mirrors `Connections.tsx`'s inline confirm/cancel toggle for the
 * destructive action rather than `window.confirm`.
 *
 * I3 — `bunkerMode` (mnemonic absent, e.g. keys held by a remote signer)
 * disables Revoke: `revokeCompanionGrant`'s caller re-derives the per-app
 * rail key from the local mnemonic (see App.tsx `handleRevoke`), which
 * isn't available in bunker mode. Same limitation and copy style as
 * `ApproveCompanionGrant`'s bunkerMode branch (design §9.4).
 */
import { useEffect, useState } from 'react';
import type { CompanionGrant } from '../types';
import * as db from '../lib/db';
import { Icon } from '../components/Icon';

interface Props {
  /** True when at COMPANION_GRANT_CAP — shows the "revoke one to add another" banner. */
  atCap: boolean;
  /** True when the local mnemonic isn't available (remote signer / Heartwood) — disables Revoke. */
  bunkerMode: boolean;
  onRevoke: (grant: CompanionGrant) => Promise<void>;
  onBack: () => void;
}

function formatScope(scope: CompanionGrant['scope']): string {
  const tiers = scope.tiers.join(', ') || 'no tiers';
  const personas = scope.personas === 'all'
    ? 'all personas'
    : `${scope.personas.length} persona${scope.personas.length === 1 ? '' : 's'}`;
  return `${tiers} · ${personas}`;
}

function formatSynced(lastPublishedAt?: number): string {
  return lastPublishedAt
    ? `Synced ${new Date(lastPublishedAt * 1000).toLocaleString()}`
    : 'Not yet synced';
}

export function CompanionApps({ atCap, bunkerMode, onRevoke, onBack }: Props) {
  const [grants, setGrants] = useState<CompanionGrant[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [confirmingPubkey, setConfirmingPubkey] = useState<string | null>(null);
  const [busyPubkey, setBusyPubkey] = useState<string | null>(null);

  async function reload() {
    setGrants(await db.listCompanionGrants());
    setLoaded(true);
  }

  useEffect(() => { void reload(); }, []);

  async function handleRevoke(grant: CompanionGrant) {
    setConfirmingPubkey(null);
    setBusyPubkey(grant.appPubkey);
    try {
      await onRevoke(grant);
      await reload();
    } finally {
      setBusyPubkey(null);
    }
  }

  if (loaded && grants.length === 0) {
    return (
      <div className="fade-in" role="main">
        <div className="empty-state">
          <div className="empty-state-icon"><Icon name="puzzle" size={36} /></div>
          <h3 className="empty-state-title">No companion apps connected</h3>
          <p className="empty-state-text">
            When you connect a companion app, it will appear here with a way to revoke its access.
          </p>
          <button className="btn btn-secondary" onClick={onBack}>
            Back to Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" role="main">
      <div className="section">
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
          Apps with a live, encrypted copy of your contacts. Revoking stops future updates and clears
          the relay copy — data an app already downloaded can&rsquo;t be recalled.
        </p>
        {bunkerMode && (
          <div
            className="card"
            style={{ background: 'var(--warning-light)', borderColor: 'var(--warning)', marginBottom: 16 }}
          >
            <p style={{ fontSize: '0.85rem', color: 'var(--warning)', marginBottom: 0 }}>
              Revoking needs your recovery phrase on this device. It isn&apos;t available while your
              keys are held by a remote signer (Heartwood). Disconnect the remote signer to manage
              companion apps.
            </p>
          </div>
        )}
        {atCap && (
          <div
            className="card"
            style={{ background: 'var(--warning-light)', borderColor: 'var(--warning)', marginBottom: 16 }}
          >
            <p style={{ fontSize: '0.85rem', color: 'var(--warning)', marginBottom: 0 }}>
              Slot limit reached — revoke an app before adding another.
            </p>
          </div>
        )}
      </div>

      <div className="card card-flush">
        {grants.map((g, i) => {
          const isConfirming = confirmingPubkey === g.appPubkey;
          const isBusy = busyPubkey === g.appPubkey;
          return (
            <div
              key={g.appPubkey}
              style={{
                padding: '14px 16px',
                borderBottom: i < grants.length - 1 ? '1px solid var(--border)' : 'none',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: 2 }}>
                    {g.appName}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    {formatScope(g.scope)}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {formatSynced(g.lastPublishedAt)}
                  </div>
                </div>
                {!isConfirming ? (
                  <button
                    className="btn btn-ghost"
                    onClick={() => setConfirmingPubkey(g.appPubkey)}
                    disabled={isBusy || bunkerMode}
                    title={bunkerMode ? 'Needs your recovery phrase on this device' : undefined}
                    style={{ color: 'var(--danger)', fontSize: '0.8rem', padding: '6px 12px', flexShrink: 0 }}
                  >
                    Revoke
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      className="btn btn-ghost"
                      onClick={() => { void handleRevoke(g); }}
                      disabled={isBusy}
                      style={{ color: '#fff', background: 'var(--danger)', fontSize: '0.8rem', padding: '6px 12px' }}
                    >
                      {isBusy ? 'Revoking…' : 'Confirm'}
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={() => setConfirmingPubkey(null)}
                      disabled={isBusy}
                      style={{ fontSize: '0.8rem', padding: '6px 12px' }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
