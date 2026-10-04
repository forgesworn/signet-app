/**
 * "Approve from my phone" per app, for the owner's own app pairings on the
 * Heartwood (the slot's `escalate` flag). Rendered inside the Heartwood
 * operator key card in Advanced settings. Off by default; turning one on asks
 * the owner to accept the risks first. Turning one off never asks.
 *
 * Which pairings are listed, the gate, the write and its read-back all live
 * in `lib/away-approval.ts`; this component only owns view state.
 */

import { useCallback, useEffect, useState } from 'react';
import type { DeviceClientSlot } from '../lib/heartwood-mgmt-types';
import { AWAY_APPROVAL_RISKS } from '../lib/away-approval';

export interface AwayApprovalListProps {
  /** Why the switch cannot be used on this phone, or null when it can. */
  blocked: string | null;
  /** The owner's own app pairings, read from the device. */
  load: () => Promise<DeviceClientSlot[]>;
  /** Turn one on or off; resolves with the fresh list of own app pairings. */
  set: (slot: DeviceClientSlot, on: boolean) => Promise<DeviceClientSlot[]>;
}

function appName(s: DeviceClientSlot): string {
  return s.label.trim() || `App ${s.slotIndex}`;
}

export function AwayApprovalList({ blocked, load, set }: AwayApprovalListProps) {
  const [slots, setSlots] = useState<DeviceClientSlot[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSlots(await load());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the apps on your Heartwood.');
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    if (!blocked) void refresh();
  }, [blocked, refresh]);

  const apply = async (slot: DeviceClientSlot, on: boolean) => {
    setBusy(slot.slotIndex);
    setError(null);
    try {
      setSlots(await set(slot, on));
      setReviewing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change this setting.');
    } finally {
      setBusy(null);
    }
  };

  const hint = { fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 } as const;

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 4 }}>Approve from my phone</div>
      <p style={{ ...hint, marginBottom: 8 }}>
        When you are away from your Heartwood, requests from your own apps that need its button can be approved here
        instead, from the Bunker tab. Off for every app until you turn it on. Family members' apps follow their rules.
      </p>

      {blocked ? (
        <p style={hint}>{blocked}</p>
      ) : (
        <>
          {loading && !slots && <p style={hint}>Reading your apps…</p>}
          {slots && slots.length === 0 && <p style={hint}>No apps of your own are paired with your Heartwood.</p>}
          {slots?.map((s) => {
            const on = s.escalate;
            const rowBusy = busy === s.slotIndex;
            return (
              <div key={`${s.slotIndex}:${s.secretFingerprint}`} style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{appName(s)}</span>
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: on ? 'var(--warning)' : 'var(--text-secondary)' }}>{on ? 'ON' : 'OFF'}</span>
                  {on ? (
                    <button className="btn btn-secondary" disabled={busy !== null} onClick={() => { void apply(s, false); }}
                      style={{ fontSize: 13, padding: '4px 10px' }}>
                      {rowBusy ? 'Turning off…' : 'Turn off'}
                    </button>
                  ) : reviewing !== s.slotIndex ? (
                    <button className="btn btn-secondary" disabled={busy !== null}
                      onClick={() => { setReviewing(s.slotIndex); setAccepted(false); setError(null); }}
                      style={{ fontSize: 13, padding: '4px 10px' }}>
                      Turn on…
                    </button>
                  ) : null}
                </div>
                {!on && reviewing === s.slotIndex && (
                  <div style={{ marginTop: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--warning)', marginBottom: 6 }}>
                      Approve {appName(s)}'s requests from this phone?
                    </div>
                    <ul style={{ ...hint, margin: '0 0 8px', paddingLeft: 18 }}>
                      {AWAY_APPROVAL_RISKS.map((r) => <li key={r}>{r}</li>)}
                    </ul>
                    <p style={{ ...hint, marginBottom: 8 }}>
                      Only requests that would ask for the button come here; an app set to sign automatically is
                      unaffected. A request nobody answers is dropped after 10 minutes.
                    </p>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.85rem', marginBottom: 8 }}>
                      <input type="checkbox" checked={accepted} disabled={rowBusy} onChange={(e) => setAccepted(e.target.checked)} />
                      I understand this phone can now approve for this app
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-primary" disabled={!accepted || busy !== null} onClick={() => { void apply(s, true); }}
                        style={{ flex: 1, fontSize: 13 }}>
                        {rowBusy ? 'Turning on…' : 'Turn on'}
                      </button>
                      {!rowBusy && (
                        <button className="btn btn-ghost" onClick={() => setReviewing(null)} style={{ fontSize: 13 }}>Cancel</button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {error && <p role="alert" style={{ ...hint, color: 'var(--danger)', marginTop: 6 }}>{error}</p>}
          {slots && (
            <button className="btn btn-ghost" disabled={loading || busy !== null} onClick={() => { void refresh(); }}
              style={{ fontSize: 13, marginTop: 4 }}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
          {!slots && error && (
            <button className="btn btn-secondary" disabled={loading} onClick={() => { void refresh(); }} style={{ fontSize: 13 }}>Try again</button>
          )}
        </>
      )}
    </div>
  );
}
