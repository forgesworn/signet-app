/**
 * Post-restore "re-pair your children's devices" banner
 *
 * Shown on the home surface when ALL of:
 *   - a restore happened in the recent-restore window (7 days)
 *   - the guardian has at least one dependant
 *   - none of the dependants has a `bunkerEndpoint` record
 *
 * Visible caveat: a brand-new guardian who just created a dependant will
 * also satisfy "has dependant + no endpoint". The recent-restore marker
 * is the disambiguator — without a recent restore the banner doesn't
 * render at all.
 *
 * Dismiss clears the marker so the banner stays hidden even if nothing
 * gets paired. Review navigates to Guardian Settings where the per-
 * dependant pair action lives.
 */

interface Props {
  /** Tapped when the guardian wants to open a dependant to pair. Navigates to Guardian Settings. */
  onReview: () => void;
  /** Tapped when the guardian has dismissed the prompt. Clears the marker. */
  onDismiss: () => void;
}

export function RepairBanner({ onReview, onDismiss }: Props) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
        left: 12,
        right: 12,
        zIndex: 40,
        padding: 14,
        borderRadius: 'var(--radius)',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-lg)',
        color: 'var(--text-primary)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
        Your children's devices need to be re-paired.
      </div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
        Your backup words don't include the special pairing keys each device uses. Open a dependant to generate a new pairing QR.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          className="btn btn-primary"
          onClick={onReview}
          style={{ flex: 1, padding: '6px 12px', fontSize: '0.85rem' }}
        >
          See your dependants
        </button>
        <button
          className="btn btn-ghost"
          onClick={onDismiss}
          style={{ flex: 0, padding: '6px 12px', fontSize: '0.85rem' }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
