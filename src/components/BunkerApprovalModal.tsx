import { useState } from 'react';
import type { PendingApproval } from '../hooks/useBunkerServer';
import type { PendingChildAsk } from '../hooks/useChildAsks';
import { shortPubkey, safeAppName } from '../lib/bunker-display';
import { ChildAskCard, childAskOutcomeText, type ChildAskDecide } from './ChildAskCard';
import { CHILD_ASK_COPY, CHILD_DEVICE_COPY } from '../lib/child-device-copy';

/**
 * Modal surfaced when a NIP-46 client has asked the bunker server to
 * sign an event (Phase 2). Three-way choice:
 *
 * - **Allow once** — sign this request only; next request from the
 *   same client will prompt again.
 * - **Allow always for <app>** — same + persist `allowAlways` for this
 *   client pubkey in IndexedDB. Future sign_event requests auto-
 *   approve without prompting.
 * - **Deny** — tell the client the user rejected the request. Denial
 *   is not persisted (user can change their mind next time).
 *
 * Rendering is handled by the caller — this component just shows the
 * card and exposes the callbacks.
 */

interface Props {
  approval: PendingApproval;
  onApproveOnce: (handle: number) => void;
  onApproveAlways: (handle: number) => void;
  onDeny: (handle: number) => void;
}

function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.origin + u.pathname.slice(0, 40);
  } catch {
    return null;
  }
}

export function BunkerApprovalModal({ approval, onApproveOnce, onApproveAlways, onDeny }: Props) {
  const name = safeAppName(approval.client.appName);
  const url = safeUrl(approval.client.appUrl);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bunker-approval-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'var(--scrim)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: 480,
          background: 'var(--bg-card)',
          borderRadius: 16,
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <div>
          <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 4 }}>
            Signature request
          </div>
          <h2 id="bunker-approval-title" style={{ margin: 0, fontSize: '1.2rem', lineHeight: 1.3 }}>
            <strong>{name}</strong> wants to sign a {approval.description}.
          </h2>
        </div>

        <div className="card" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', padding: 12, borderRadius: 8, fontSize: '0.85rem' }}>
          {url && (
            <div style={{ marginBottom: 6 }}>
              <span style={{ color: 'var(--text-muted)' }}>App URL: </span>
              <span style={{ wordBreak: 'break-all' }}>{url}</span>
            </div>
          )}
          <div style={{ marginBottom: 6 }}>
            <span style={{ color: 'var(--text-muted)' }}>Client key: </span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{shortPubkey(approval.client.pubkey)}</span>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)' }}>Event kind: </span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{approval.template.kind}</span>
          </div>
        </div>

        {!approval.client.existing && (
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '4px 2px' }}>
            This is the first request we've seen from this client. Only approve if you started this.
          </div>
        )}

        {/* Button hierarchy is conditional on whether the parent has already
            vouched for this client once. First contact keeps "Allow once" as
            the primary — friction stays deliberate alongside the
            first-request warning above. Returning client promotes "Allow
            always" to primary so the second-and-subsequent encounters with
            a trusted site stop costing kid-side foreground-wait latency.
            Buttons keep their wiring — only the visual weight flips. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          {approval.client.existing ? (
            <>
              <button className="btn btn-primary" onClick={() => onApproveAlways(approval.handle)}>
                Allow always for {name.slice(0, 30)}
              </button>
              <button className="btn btn-secondary" onClick={() => onApproveOnce(approval.handle)}>
                Allow once
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-primary" onClick={() => onApproveOnce(approval.handle)}>
                Allow once
              </button>
              <button className="btn btn-secondary" onClick={() => onApproveAlways(approval.handle)}>
                Allow always for {name.slice(0, 30)}
              </button>
            </>
          )}
          <button className="btn btn-ghost" onClick={() => onDeny(approval.handle)}>
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A dependant's own phone asking (child-direct, spec §7): the same bottom
 * sheet, ONE ask at a time, oldest first, with "N more waiting". "Later"
 * (A37) dismisses the sheet; the asks stay in the Bunker panel's "Family
 * asks" until they expire (the caller filters what was put off out of
 * `asks`). After a verdict that did not go as chosen (device unreachable,
 * ceiling full…) the sheet stays on that ask with the reason until the
 * guardian closes it.
 */
export function ChildAskApprovalModal({ asks, alwaysAvailableFor, onDecide, onLater }: {
  asks: PendingChildAsk[];
  /** False at full-control (no "Always"). */
  alwaysAvailableFor: (dependantId: string) => boolean;
  onDecide: ChildAskDecide;
  /** A37: put off every ask now in the sheet; they stay answerable in the Bunker panel. */
  onLater?: (askIds: string[]) => void;
}) {
  const [held, setHeld] = useState<{ pending: PendingChildAsk; text: string } | null>(null);
  const shown = held?.pending ?? asks[0];
  if (!shown) return null;
  const more = asks.filter(a => a.ask.id !== shown.ask.id).length;
  return (
    <div role="dialog" aria-modal="true" aria-label="Child request" style={{
      position: 'fixed', inset: 0, zIndex: 10000, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end',
      justifyContent: 'center', padding: 16,
    }}>
      <div className="card" style={{ width: '100%', maxWidth: 480, background: 'var(--bg-card)', borderRadius: 16, padding: 20,
        display: 'flex', flexDirection: 'column', gap: 12, boxShadow: 'var(--shadow-lg)' }}>
        {held ? (
          <>
            <div role="alert" style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--danger)' }}>{held.text}</div>
            <button className="btn btn-primary" onClick={() => setHeld(null)}>{CHILD_DEVICE_COPY.done}</button>
          </>
        ) : (
          <>
            <ChildAskCard key={shown.ask.id} pending={shown} alwaysAvailable={alwaysAvailableFor(shown.dependantId)} onDecide={onDecide}
              onOutcome={(r) => { const text = childAskOutcomeText(r); if (r.sent && text) setHeld({ pending: shown, text }); }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span data-testid="child-ask-more" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {more > 0 ? CHILD_ASK_COPY.moreWaiting(more) : ''}
              </span>
              {onLater && (
                <button type="button" className="btn btn-ghost" onClick={() => onLater(asks.map(a => a.ask.id))}>{CHILD_ASK_COPY.later}</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
