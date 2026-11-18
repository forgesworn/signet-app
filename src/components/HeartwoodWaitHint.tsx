import { useEffect, useState } from 'react';
import { SIGNER_WAITING_COPY } from '../lib/signer-error-copy';

/** A Heartwood sign normally answers in about a second; past this, it is probably holding a card for a press. */
export const HEARTWOOD_WAIT_HINT_DELAY_MS = 4000;

/**
 * A gentle nudge shown only once `active` has been continuously true for
 * `delayMs`, telling the user to press the Heartwood's button if it is showing
 * a card. Becoming inactive hides it at once and restarts the wait.
 */
export function HeartwoodWaitHint({ active, delayMs = HEARTWOOD_WAIT_HINT_DELAY_MS }: { active: boolean; delayMs?: number }) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  if (!active || !shown) return null;
  return (
    <p role="status" aria-live="polite" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '8px 0 0' }}>
      {SIGNER_WAITING_COPY}
    </p>
  );
}
