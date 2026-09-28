interface Props {
  /** Open Security → Backup Words. */
  onBackup: () => void;
  /** Snooze — for seven days normally, 48 hours once a dependant is held. */
  onDismiss: () => void;
  /** Card heading. Always "Write down your recovery words" today, passed in from `backupNudgeCopy`. */
  title: string;
  /** Body copy, named for whose keys are riding on it — see `backupNudgeCopy`. */
  body: string;
}

/**
 * Home-ring backup nudge (spec §10). Occupies the slot the retired no-lock nag
 * used, with the same dismiss mechanics, but says something honest and
 * actionable: the identity is already secured on this device, and the one thing
 * still missing is a way back in on a different one.
 */
export function BackupCard({ onBackup, onDismiss, title, body }: Props) {
  return (
    <div
      className="card section"
      style={{ borderLeft: '3px solid var(--accent)' }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
        {body}
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" onClick={onBackup}>Write them down</button>
        <button className="btn btn-ghost" onClick={onDismiss}>Not now</button>
      </div>
    </div>
  );
}
