import { useState } from 'react';
import { CHILD_MODE_SIGN_IN_COPY } from '../lib/child-device-copy';

interface Props {
  /** The child-mode dependant's name (`childModeSignInRefusal`). */
  child: string;
  /** Today's Deny: the site gets exactly the answer a Deny gives. */
  onDecline: () => void;
  /** On home, over the carousel, in place of the approval sheet. */
  overlay?: boolean;
}

/**
 * Shown in place of every sign-in picker while the guardian's phone is in
 * child mode for a child who signs in on their own phone. Names no guardian
 * identity and offers one action, Decline: no PIN, and child mode stays on.
 */
export function ChildSignInRefusal({ child, onDecline, overlay = false }: Props) {
  const [declined, setDeclined] = useState(false);
  const card = (
    <div className={overlay ? 'approval-card' : 'card section'} data-testid="child-sign-in-refusal">
      <h3 style={{ marginTop: 0 }}>{CHILD_MODE_SIGN_IN_COPY.refusalHeading(child)}</h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
        {CHILD_MODE_SIGN_IN_COPY.refusalBody(child)}
      </p>
      <button
        type="button"
        className="btn btn-primary"
        style={{ width: '100%' }}
        disabled={declined}
        onClick={() => { setDeclined(true); onDecline(); }}
      >
        {CHILD_MODE_SIGN_IN_COPY.decline}
      </button>
    </div>
  );
  return overlay ? <div className="approval-overlay">{card}</div> : <div className="fade-in" role="main">{card}</div>;
}
