import type { ReactNode } from 'react';
import { useCardBackdrop } from '../hooks/useCardBackdrop';

/**
 * Paints an identity's backdrop (its "wallpaper") behind whichever card of
 * that identity the carousel is showing, so the image carries across the
 * ring — identity, QR, contacts and settings.
 *
 * The wrapper is always rendered, with or without an image, so the card
 * inside keeps the same parent while the backdrop loads: re-parenting it
 * would remount the card (and rebuild its QR canvas) on every swipe. With
 * no backdrop the stage is just a sized box and the card looks as it always
 * did; `.has-backdrop` turns the card translucent over the image and scrim.
 */
export function CardStage({ pubkey, blur, children }: {
  pubkey?: string;
  /** The blur-names preference: the backdrop may be a photo of the same person, so it blurs too. */
  blur?: boolean;
  children: ReactNode;
}) {
  const { url } = useCardBackdrop(pubkey);
  return (
    <div className={`card-stage${url ? ' has-backdrop' : ''}`}>
      {url && (
        <>
          <div
            className="card-backdrop"
            // Scaled up a touch so the blurred edge does not fade to transparent at the card's rim.
            style={{ backgroundImage: `url(${url})`, ...(blur ? { filter: 'blur(18px)', transform: 'scale(1.15)' } : {}) }}
            aria-hidden="true"
          />
          <div className="card-backdrop-scrim" aria-hidden="true" />
        </>
      )}
      {children}
    </div>
  );
}
