import { useState } from 'react';
import { childModeGuardianRefusalCopy } from '../lib/child-mode-guardian-pages';

interface Props {
  /** The child-mode dependant's name; a plain fallback is used when it is empty. */
  child: string;
  /** Signs and publishes nothing; only clears the request and leaves the page. */
  onDecline: () => void;
}

/**
 * Shown in place of a guardian-only page (companion grant, contacts grant,
 * add dependant, Advanced settings) while the phone is in child mode. One
 * action, Decline: no PIN, and child mode stays on.
 */
export function ChildModeGuardianRefusal({ child, onDecline }: Props) {
  const [declined, setDeclined] = useState(false);
  const copy = childModeGuardianRefusalCopy(child);
  return (
    <div className="fade-in" role="main">
      <div className="card section" data-testid="child-mode-guardian-refusal">
        <h3 style={{ marginTop: 0 }}>{copy.title}</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{copy.body}</p>
        <button
          type="button"
          className="btn btn-primary"
          style={{ width: '100%' }}
          disabled={declined}
          onClick={() => { setDeclined(true); onDecline(); }}
        >
          Decline
        </button>
      </div>
    </div>
  );
}
