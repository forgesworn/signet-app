// src/components/DesktopFrame.tsx
import type { ReactNode } from 'react';
import { useWideViewport } from '../hooks/useViewportMode';
import { useCarouselArrows } from './CarouselArrowContext';

/**
 * On narrow windows this is a transparent passthrough (display:contents) so real
 * mobile renders unchanged. On wide windows it hosts the whole app inside a
 * centred phone frame on a desk backdrop, with directional arrows in the margins
 * wired to the carousel (when one is mounted; hidden otherwise).
 */
export function DesktopFrame({ children }: { children: ReactNode }) {
  const wide = useWideViewport();
  const arrows = useCarouselArrows();
  const showArrows = wide && arrows !== null;

  return (
    <div className={wide ? 'desk desk--wide' : 'desk desk--passthrough'}>
      <div className="desk-stage">
        {showArrows && (
          <>
            <button
              type="button"
              className="desk-arrow desk-arrow-up"
              aria-label="Previous identity"
              disabled={arrows.upDisabled}
              onClick={arrows.up}
            >▲</button>
            <button
              type="button"
              className="desk-arrow desk-arrow-left"
              aria-label="Previous card"
              onClick={arrows.left}
            >◀</button>
          </>
        )}

        <div className="desk-frame">
          <div className="desk-frame-app">{children}</div>
        </div>

        {showArrows && (
          <>
            <button
              type="button"
              className="desk-arrow desk-arrow-right"
              aria-label="Next card"
              onClick={arrows.right}
            >▶</button>
            <button
              type="button"
              className="desk-arrow desk-arrow-down"
              aria-label="Next identity"
              disabled={arrows.downDisabled}
              onClick={arrows.down}
            >▼</button>
          </>
        )}
      </div>
    </div>
  );
}
