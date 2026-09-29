import { useEffect, useState } from 'react';
import { CHILD_WAITING_COPY } from '../lib/child-device-copy';

interface Props {
  /** Threshold in ms before the long-wait nudge appears. Default 8000. */
  longWaitMs?: number;
  /**
   * Cancel handler — wired to the existing Deny/Cancel path so the kid
   * isn't stuck staring at the wait indefinitely. Only rendered after the
   * long-wait threshold elapses; the early wait stays untouchable so a
   * stray tap doesn't abort a request the parent is just about to approve.
   */
  onCancel: () => void;
  /**
   * Child-direct install: the request is an ask on the guardian's phone (it
   * waits up to 10 minutes and they get a notice), not a NIP-46 round trip
   * to a guardian app that may be closed.
   */
  direct?: boolean;
}

/**
 * Status panel shown on the paired-child surface while a sign-in request
 * is in flight to the guardian's NIP-46 server. The actual wait length is
 * dominated by whether the guardian's app is foregrounded (a known PWA
 * push-notification limitation). We can't shorten the wait without native
 * push, but we can stop the kid from wondering whether the app is broken.
 *
 * Progressive disclosure:
 *   0 → longWaitMs:  spinner + "Asking your guardian to approve…"
 *   ≥ longWaitMs:    add a soft "they may not be in the app yet" line and
 *                    expose a Cancel button.
 */
export function PairedChildApprovalWaiting({ longWaitMs = 8000, onCancel, direct = false }: Props) {
  const [waitedLong, setWaitedLong] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setWaitedLong(true), longWaitMs);
    return () => window.clearTimeout(t);
  }, [longWaitMs]);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '14px 16px',
        background: 'var(--accent-light)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        textAlign: 'center',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        <span
          aria-hidden="true"
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: '2px solid var(--accent)',
            borderTopColor: 'transparent',
            animation: 'pcwait-spin 0.8s linear infinite',
            display: 'inline-block',
          }}
        />
        <span style={{ fontWeight: 600, color: 'var(--accent-text)' }}>
          {direct
            ? (waitedLong ? CHILD_WAITING_COPY.longTitle : CHILD_WAITING_COPY.title)
            : (waitedLong ? 'Still waiting…' : 'Asking your guardian to approve…')}
        </span>
      </div>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
        {direct
          ? (waitedLong ? CHILD_WAITING_COPY.longBody : CHILD_WAITING_COPY.body)
          : waitedLong
            ? 'Your guardian might not be in the Signet app yet. Ask them to open it so they can approve.'
            : "They'll only see this once they open the Signet app."}
      </div>
      {waitedLong && (
        <button
          className="btn btn-ghost"
          onClick={onCancel}
          style={{ marginTop: 4 }}
        >
          Cancel
        </button>
      )}
      <style>{`@keyframes pcwait-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
