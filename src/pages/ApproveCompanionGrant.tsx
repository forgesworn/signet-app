/**
 * Confirm screen for the companion data rail pairing flow. Shown when a
 * scanned/URL pairing request (`PairingRequest`, parsed by
 * `companion-pair.ts`) is pending. On approve, the caller (App.tsx)
 * derives the per-app rail key, writes the grant, and publishes the ack +
 * first snapshot — this component only collects the user's scope choice.
 *
 * `bunkerMode` disables the flow entirely: `deriveRailKeypair` needs the
 * local mnemonic, which isn't available when keys are held by a remote
 * signer (Heartwood). See companion-data-rail-plan Task 10.
 */
import { useState } from 'react';
import type { PairingRequest } from '../lib/companion-pair';
import type { GrantScope } from '../types';

interface Props {
  request: PairingRequest;
  personas: Array<{ pubkey: string; label: string }>; // owner keypairs to offer
  bunkerMode: boolean;                                  // mnemonic absent -> disable
  onApprove: (scope: GrantScope) => Promise<void>;
  onDeny: () => void;
}

const TIER_LABELS: Record<'kin' | 'kith' | 'ken', string> = {
  kin: 'Family (kin)', kith: 'Verified contacts (kith)', ken: 'Recognised keys (ken)',
};

export function ApproveCompanionGrant({ request, personas, bunkerMode, onApprove, onDeny }: Props) {
  const [tiers, setTiers] = useState<Array<'kin' | 'kith' | 'ken'>>(request.tiers);
  const [allPersonas, setAllPersonas] = useState(true);
  const [chosen, setChosen] = useState<string[]>(personas.map(p => p.pubkey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const crossesPersona = allPersonas ? personas.length > 1 : chosen.length > 1;

  async function approve() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onApprove({ tiers, personas: allPersonas ? 'all' : chosen });
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : 'Could not connect — please try again');
      return;
    }
    setBusy(false);
  }

  if (bunkerMode) {
    return (
      <div className="fade-in" role="main">
        <div className="section">
          <h2 style={{ marginBottom: 8 }}>Connect companion app</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
            <strong>{request.appName}</strong> wants to sync your contacts.
          </p>
          <div
            className="card"
            style={{ background: 'var(--warning-light)', borderColor: 'var(--warning)', marginBottom: 20 }}
          >
            <p style={{ fontSize: '0.9rem', color: 'var(--warning)', marginBottom: 0 }}>
              Companion sync needs your recovery phrase on this device. It isn&apos;t available while
              your keys are held by a remote signer (Heartwood). Disconnect the remote signer to use
              companion sync.
            </p>
          </div>
          <button className="btn btn-ghost" onClick={onDeny}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" role="main">
      <div className="section">
        <h2 style={{ marginBottom: 8 }}>Connect companion app</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
          <strong>{request.appName}</strong> wants a live, encrypted copy of your contacts.
        </p>

        <fieldset style={{ border: 'none', padding: 0, margin: '0 0 20px' }}>
          <legend style={{ fontWeight: 600, marginBottom: 8, fontSize: '0.9rem' }}>Share which contacts?</legend>
          {(['kin', 'kith', 'ken'] as const).map(t => (
            <label
              key={t}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: '0.9rem', marginBottom: 10, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={tiers.includes(t)}
                onChange={e => setTiers(prev => e.target.checked ? [...new Set([...prev, t])] : prev.filter(x => x !== t))}
                disabled={busy}
                style={{ marginTop: 3 }}
              />
              <span>{TIER_LABELS[t]}</span>
            </label>
          ))}
        </fieldset>

        <fieldset style={{ border: 'none', padding: 0, margin: '0 0 20px' }}>
          <legend style={{ fontWeight: 600, marginBottom: 8, fontSize: '0.9rem' }}>From which personas?</legend>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: '0.9rem', marginBottom: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={allPersonas}
              onChange={e => setAllPersonas(e.target.checked)}
              disabled={busy}
              style={{ marginTop: 3 }}
            />
            <span>All personas</span>
          </label>
          {!allPersonas && personas.map(p => (
            <label
              key={p.pubkey}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: '0.9rem', marginBottom: 10, marginLeft: 24, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={chosen.includes(p.pubkey)}
                onChange={e => setChosen(prev => e.target.checked ? [...prev, p.pubkey] : prev.filter(x => x !== p.pubkey))}
                disabled={busy}
                style={{ marginTop: 3 }}
              />
              <span>{p.label}</span>
            </label>
          ))}
        </fieldset>

        {crossesPersona && (
          <div
            className="card"
            style={{ background: 'var(--info-light, var(--accent-light))', borderColor: 'var(--info, var(--accent))', marginBottom: 20 }}
          >
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
              This app signs in with one persona but will receive contacts from more than one. Narrow
              the personas above if you want to keep them separate.
            </p>
          </div>
        )}

        {error && (
          <div
            className="card"
            style={{ background: 'var(--danger-light)', borderColor: 'var(--danger)', marginBottom: 16 }}
          >
            <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginBottom: 0 }}>{error}</p>
          </div>
        )}

        <button
          className="btn btn-primary"
          onClick={approve}
          disabled={busy || tiers.length === 0 || (!allPersonas && chosen.length === 0)}
        >
          {busy ? 'Connecting…' : 'Approve'}
        </button>
        <button className="btn btn-ghost" onClick={onDeny} disabled={busy} style={{ marginTop: 8 }}>
          Deny
        </button>
      </div>
    </div>
  );
}
