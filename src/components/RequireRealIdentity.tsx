interface Props {
  /** One line saying why THIS feature needs the real identity. */
  reason: string;
  /**
   * Card title. Defaults to the owner's first-person wording; a gate whose
   * subject is a DEPENDANT passes their own ("Lily's real identity") so the
   * guardian is not told to activate something of theirs.
   */
  title?: string;
  /** Primary button label. Defaults to the owner's first-person wording. */
  activateLabel?: string;
  onActivate: () => void;
  onCancel: () => void;
}

/**
 * Shared gate interstitial for every feature that needs an activated real
 * identity (spec §7.3). For these purposes the answer is not "set a PIN"
 * (every identity is secured at creation now) but "activate the real-name
 * slot".
 *
 * Presentation only — the host route decides the reason line, the subject
 * wording, and where "Activate" and "Not now" go.
 */
export function RequireRealIdentity({
  reason,
  title = 'Your real identity',
  activateLabel = 'Activate my real identity',
  onActivate,
  onCancel,
}: Props) {
  return (
    <div className="fade-in" role="main">
      <div className="card section">
        <div className="section-title">{title}</div>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 16 }}>
          {reason}
        </p>
        <button className="btn btn-primary" onClick={onActivate}>
          {activateLabel}
        </button>
        <button className="btn btn-ghost" onClick={onCancel} style={{ marginTop: 8 }}>
          Not now
        </button>
      </div>
    </div>
  );
}
