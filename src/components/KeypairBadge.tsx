import type { KeypairToken } from '../types';
import { keypairTypeLabel, badgeColour } from '../lib/identity-label';

/**
 * Small pill badge rendering the keypair type next to a display name
 * in every identity-listing surface (picker, Connections, Settings).
 * Consistent labels across the app.
 */
export function KeypairBadge({ token }: { token: KeypairToken }) {
  const { background, color } = badgeColour(token);
  return (
    <span
      style={{
        fontSize: '0.65rem',
        fontWeight: 600,
        letterSpacing: '0.02em',
        padding: '2px 6px',
        borderRadius: 4,
        background,
        color,
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {keypairTypeLabel(token)}
    </span>
  );
}
