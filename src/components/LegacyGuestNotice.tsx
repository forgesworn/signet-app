interface Props {
  onSecure: () => void;
}

/**
 * One-screen notice for an identity created under the retired unprotected tier
 * (spec §9). Shown once, before anything else, on the next app open.
 *
 * Deliberately one button and no choices: the identity keeps its name, keeps
 * its activity, and keeps its keys — the only thing that changes is that it
 * gains a lock. Nothing about the real-name slot moves; it stays dormant.
 *
 * The word this notice must never use is the old tier's name; it describes the
 * state ("no lock"), not the label.
 */
export function LegacyGuestNotice({ onSecure }: Props) {
  return (
    <div className="page fade-in" role="main" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '80vh' }}>
      <div className="card section">
        <h1 style={{ marginBottom: 8, fontSize: '1.3rem' }}>
          Signets without a lock have been retired
        </h1>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
          This Signet was set up without a PIN or Face ID. Add one now to carry on using it.
        </p>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 20 }}>
          You keep your name and everything you've done — nothing is reset, and no keys change.
        </p>
        <button className="btn btn-primary" onClick={onSecure}>
          Secure my Signet
        </button>
      </div>
    </div>
  );
}
