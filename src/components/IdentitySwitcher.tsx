import { useEffect } from 'react';
import type { CarouselRow } from '../types';
import { resolveActiveIdentity } from '../lib/carousel-utils';
import { initialFromName, colourFromPubkey } from '../lib/avatar';
import { Icon } from './Icon';
import { Z } from '../lib/z-index';

/** One row of the ring as the switcher lists it. */
export function switcherRowLabel(row: CarouselRow): { name: string; kind: string } {
  if (row.type === 'add') return { name: 'Add persona or dependant', kind: 'New' };
  const resolved = resolveActiveIdentity(row);
  return { name: resolved.displayName, kind: resolved.isDependant ? 'Dependant' : resolved.type };
}

/**
 * The ring's rows as a list: tap one to slide the carousel to it. Vertical
 * swiping stays, but the 4px dots on the edge are the only other hint that
 * personas and dependants live above and below the card.
 */
export function IdentitySwitcher({ rows, current, onPick, onClose }: {
  rows: CarouselRow[];
  current: number;
  onPick: (row: number) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="identity-switcher-scrim"
      style={{ zIndex: Z.carouselOverlay }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      onTouchEnd={e => e.stopPropagation()}
    >
      <div className="identity-switcher" role="dialog" aria-modal="true" aria-label="Switch identity">
        <div className="identity-switcher-head">
          <h2>Your identities</h2>
          <button type="button" aria-label="Close" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        <ul className="identity-switcher-list">
          {rows.map((row, i) => {
            const { name, kind } = switcherRowLabel(row);
            const isAdd = row.type === 'add';
            const pubkey = isAdd ? '' : resolveActiveIdentity(row).publicKey;
            return (
              <li key={i}>
                <button
                  type="button"
                  className={`identity-switcher-row${i === current ? ' is-current' : ''}`}
                  aria-current={i === current ? 'true' : undefined}
                  onClick={() => onPick(i)}
                >
                  <span className="identity-switcher-avatar" aria-hidden="true"
                    style={isAdd ? undefined : { background: colourFromPubkey(pubkey) }}>
                    {isAdd ? '+' : initialFromName(name)}
                  </span>
                  <span className="identity-switcher-text">
                    <span className="identity-switcher-name">{name}</span>
                    <span className="identity-switcher-kind">{kind}</span>
                  </span>
                  {i === current && <span className="identity-switcher-tick" aria-hidden="true">&#10003;</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
