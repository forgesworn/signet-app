interface Props {
  /** Open Security → Backup Words. */
  onBackup: () => void;
  /** Snooze for seven days. */
  onDismiss: () => void;
}

/**
 * Home-ring backup nudge (spec §10). Occupies the slot the retired no-lock nag
 * used, with the same dismiss mechanics, but says something honest and
 * actionable: the identity is already secured on this device, and the one thing
 * still missing is a way back in on a different one.
 */
export function BackupCard({ onBackup, onDismiss }: Props) {
  return (
    <div
      className="card section"
      style={{ borderLeft: '3px solid var(--accent)' }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Write down your recovery words</div>
      <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
        They&rsquo;re the only way back in on a new phone.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" onClick={onBackup}>Write them down</button>
        <button className="btn btn-ghost" onClick={onDismiss}>Not now</button>
      </div>
    </div>
  );
}
