import type { Badge } from '../lib/known-place-badges';
import { Icon } from './Icon';

/**
 * One small badge glyph. Heartwood is the text "HW" and pinned a filled dot
 * (brand guide: no lock, no shield); the rest reuse the line-icon set.
 */
export function KnownPlaceBadgeGlyph({ badge, size = 14 }: { badge: Badge; size?: number }) {
  switch (badge.kind) {
    case 'expires-soon': return <Icon name="alertTriangle" size={size} className="kp-glyph" />;
    case 'auto': return <Icon name="repeat" size={size} className="kp-glyph" />;
    case 'heartwood': return <span className="kp-glyph kp-glyph-text" aria-hidden="true">HW</span>;
    case 'other-device': return <Icon name="devices" size={size} className="kp-glyph" />;
    case 'shared': return <Icon name="user" size={size} className="kp-glyph" />;
    case 'pinned': return <span className="kp-glyph kp-glyph-dot" aria-hidden="true" />;
    case 'dormant': return <Icon name="clock" size={size} className="kp-glyph" />;
  }
}
