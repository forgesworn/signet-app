/**
 * Guardian-facing rate-limit alert banner.
 *
 * Shown on the home surface when a paired dependant crosses the
 * per-minute sign-request cap (default 10/min). The cap already rejects
 * the excess requests at the bunker level — this banner makes the
 * guardian aware so they can check on the child device or revoke
 * pairings if the flood is attacker-driven.
 *
 * Auto-dismisses after 5 minutes per the issue spec so a stale alert
 * doesn't linger after the flood has stopped.
 */

interface Props {
  /** Display name of the dependant whose endpoint hit the cap. */
  dependantName: string;
  /** Navigate to Guardian Settings where the dependant's pair + revoke actions live. */
  onReview: () => void;
  /** Dismiss the banner without acting. */
  onDismiss: () => void;
}

export function RateLimitBanner({ dependantName, onReview, onDismiss }: Props) {
  // Safe display — names come from synced dependant records and are
  // already sanitised upstream (DependantIdentity.displayName is bounded
  // at 100 chars and stripped of control / bidi chars on save).
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
        left: 12,
        right: 12,
        zIndex: 41,
        padding: 14,
        borderRadius: 'var(--radius)',
        background: 'var(--warning-light)',
        border: '1px solid var(--warning)',
        boxShadow: 'var(--shadow-lg)',
        color: 'var(--text-primary)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
        {dependantName} is making requests faster than usual.
      </div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
        Their paired device has been asked to slow down. If this looks wrong, review the pairing.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          className="btn btn-primary"
          onClick={onReview}
          style={{ flex: 1, padding: '6px 12px', fontSize: '0.85rem' }}
        >
          Review
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
