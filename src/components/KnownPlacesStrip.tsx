import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KnownPlace } from '../types/known-places';
import type { Badge } from '../lib/known-place-badges';
import { fitChips } from '../lib/chip-fit';
import { placeLabel, placeTint, sortPlaces } from '../lib/known-place-label';
import { KnownPlaceBadgeGlyph } from './KnownPlaceBadgeGlyph';

export interface KnownPlacesStripProps {
  places: KnownPlace[];
  /** The one badge a chip shows, or null. */
  badges: (place: KnownPlace) => Badge | null;
  locked: boolean;
  onUnlock: () => void;
  /** A chip passes its id; the "+N" chip passes null (open the list at the top). */
  onOpenPlace: (id: string | null) => void;
  /** A data-URL icon for a place (NIP-55 apps), or null for the letter tile. */
  iconFor?: (place: KnownPlace) => string | null;
  blur?: boolean;
}

const DEFAULT_ROWS = 2;
const DEFAULT_GAP = 8;
const BLUR = { filter: 'blur(6px)', userSelect: 'none' } as const;

/**
 * Where this identity is known, as chips filled by space rather than by count.
 * Every chip stays in the DOM (the ones that do not fit are visually removed
 * but still measurable) so a width never reads 0 and the fit cannot oscillate.
 * A record, not a launcher: nothing here opens anything outside the app.
 */
export function KnownPlacesStrip({ places, badges, locked, onUnlock, onOpenPlace, iconFor, blur }: KnownPlacesStripProps) {
  const sorted = useMemo(() => sortPlaces(places), [places]);
  const chipsRef = useRef<HTMLDivElement | null>(null);
  // null = not laid out yet (or no layout engine): show every chip.
  const [shown, setShown] = useState<number | null>(null);
  const signature = sorted.map(p => `${p.id}|${placeLabel(p)}`).join('\n');

  useLayoutEffect(() => {
    const root = chipsRef.current;
    if (locked || !root) return;
    const measure = () => {
      const chips = Array.from(root.querySelectorAll<HTMLElement>('[data-kp-chip]'));
      const more = root.querySelector<HTMLElement>('[data-kp-more]');
      const containerWidth = root.offsetWidth;
      if (chips.length === 0 || !(containerWidth > 0)) { setShown(null); return; }
      const style = window.getComputedStyle(root);
      const rowsRaw = parseInt(style.getPropertyValue('--kp-rows'), 10);
      const gapRaw = parseFloat(style.columnGap);
      const rows = Number.isFinite(rowsRaw) && rowsRaw > 0 ? rowsRaw : DEFAULT_ROWS;
      const gap = Number.isFinite(gapRaw) ? gapRaw : DEFAULT_GAP;
      const fit = fitChips(chips.map(c => c.offsetWidth), containerWidth, rows, gap, more?.offsetWidth ?? 0);
      setShown(fit.shown);
    };
    measure();
    window.addEventListener('resize', measure);
    if (typeof ResizeObserver === 'undefined') return () => window.removeEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => { window.removeEventListener('resize', measure); observer.disconnect(); };
  }, [locked, signature]);

  if (locked) {
    return (
      <div className="card-launcher">
        <button
          type="button"
          className="card-launcher-chip card-launcher-chip--locked"
          onClick={e => { e.stopPropagation(); onUnlock(); }}
          aria-label="Unlock to see where this identity is known"
        >
          Unlock to see where this identity is known
        </button>
      </div>
    );
  }

  if (sorted.length === 0) {
    return <p className="kp-strip-empty">Not known anywhere yet</p>;
  }

  const visibleCount = shown === null ? sorted.length : Math.min(shown, sorted.length);
  const hiddenCount = sorted.length - visibleCount;

  return (
    <div className="kp-strip" ref={chipsRef} aria-label="Where this identity is known">
      {sorted.map((place, i) => {
        const label = placeLabel(place);
        const badge = badges(place);
        const icon = iconFor?.(place) ?? null;
        const hidden = i >= visibleCount;
        return (
          <button
            key={place.id}
            type="button"
            data-kp-chip=""
            className={`card-launcher-chip kp-chip${hidden ? ' kp-chip--hidden' : ''}`}
            aria-hidden={hidden || undefined}
            tabIndex={hidden ? -1 : undefined}
            onClick={e => { e.stopPropagation(); onOpenPlace(place.id); }}
            aria-label={badge ? `${label}, ${badge.label}` : label}
          >
            {icon ? (
              <img className="card-launcher-tile kp-tile-img" src={icon} alt="" aria-hidden="true" style={blur ? BLUR : undefined} />
            ) : (
              <span className="card-launcher-tile" aria-hidden="true" style={{ background: placeTint(place), ...(blur ? BLUR : {}) }}>
                {label.charAt(0).toUpperCase()}
              </span>
            )}
            <span className="card-launcher-label" style={blur ? BLUR : undefined}>{label}</span>
            {badge && <KnownPlaceBadgeGlyph badge={badge} />}
          </button>
        );
      })}
      <button
        type="button"
        data-kp-more=""
        className={`card-launcher-chip kp-chip kp-chip--more${hiddenCount === 0 ? ' kp-chip--hidden' : ''}`}
        aria-hidden={hiddenCount === 0 || undefined}
        tabIndex={hiddenCount === 0 ? -1 : undefined}
        onClick={e => { e.stopPropagation(); onOpenPlace(null); }}
        aria-label={`${hiddenCount} more places`}
      >
        +{hiddenCount}
      </button>
    </div>
  );
}
