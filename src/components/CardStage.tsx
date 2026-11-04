import type { ReactNode } from 'react';
import { useCardBackdrop } from '../hooks/useCardBackdrop';

/**
 * Paints an identity's backdrop (its "wallpaper") behind whichever card of
 * that identity the carousel is showing, so the image carries across the
 * whole ring — identity, QR, contacts, settings and camera. With no
 * backdrop set this renders the card alone, unchanged.
 *
 * The scrim plus the translucent card backgrounds (`.card-stage > *` rules
 * in carousel.css) keep every card legible over any image.
 */
export function CardStage({ pubkey, children }: { pubkey?: string; children: ReactNode }) {
  const { url } = useCardBackdrop(pubkey);
  if (!url) return <>{children}</>;
  return (
    <div className="card-stage">
      <div
        className="card-backdrop"
        style={{ backgroundImage: `url(${url})` }}
        aria-hidden="true"
      />
      <div className="card-backdrop-scrim" aria-hidden="true" />
      {children}
    </div>
  );
}
