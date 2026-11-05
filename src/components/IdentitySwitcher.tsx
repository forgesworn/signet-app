import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { CarouselRow } from '../types';
import { resolveActiveIdentity } from '../lib/carousel-utils';
import { initialFromName, colourFromPubkey } from '../lib/avatar';
import { Icon } from './Icon';
import { Z } from '../lib/z-index';

/**
 * Which Add card the ring ends in, and so what the Add row can honestly say:
 * the top-level ring offers a persona or a dependant, a dependant's child-mode
 * ring only a persona, and a paired child's own install has an informational
 * card with nothing to add.
 */
export type SwitcherSurface = 'guardian' | 'child' | 'paired-child';

/** One row of the ring as the switcher lists it. */
export function switcherRowLabel(row: CarouselRow, surface: SwitcherSurface = 'guardian'): { name: string; kind: string } {
  if (row.type === 'add') {
    if (surface === 'paired-child') return { name: 'Personas are managed for you', kind: 'Info' };
    if (surface === 'child') return { name: 'Add persona', kind: 'New' };
    return { name: 'Add persona or dependant', kind: 'New' };
  }
  const resolved = resolveActiveIdentity(row);
  return { name: resolved.displayName, kind: resolved.isDependant ? 'Dependant' : resolved.type };
}

/**
 * The ring's rows as a list: tap one to slide the carousel to it. Vertical
 * swiping stays, but the 4px dots on the edge are the only other hint that
 * personas and dependants live above and below the card.
 */
export function IdentitySwitcher({ rows, current, onPick, onClose, blurIdentityNames, surface = 'guardian' }: {
  rows: CarouselRow[];
  current: number;
  /** Same preference the cards honour: names (and the initial that spells them) render blurred. */
  blurIdentityNames?: boolean;
  /** Which Add card the ring ends in; decides the Add row's label. */
  surface?: SwitcherSurface;
  onPick: (row: number) => void;
  onClose: () => void;
}) {
  const blurStyle = blurIdentityNames ? { filter: 'blur(6px)', userSelect: 'none' as const } : undefined;
  const sheetRef = useRef<HTMLDivElement | null>(null);

  // Focus belongs inside the sheet while it is open: start on the row the
  // carousel is showing, and hand focus back to whatever opened it on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const sheet = sheetRef.current;
    const target = sheet?.querySelector<HTMLElement>('.identity-switcher-row.is-current')
      ?? sheet?.querySelector<HTMLElement>('.identity-switcher-row');
    target?.focus();
    return () => {
      if (opener && opener.isConnected && opener !== document.body) opener.focus();
    };
  }, []);

  // Tab stays inside the sheet: wrap at both ends, and pull focus back in if
  // it ever sits outside.
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const items = Array.from(sheet.querySelectorAll<HTMLElement>('button:not([disabled])'));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!(active instanceof Node) || !sheet.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="identity-switcher-scrim"
      style={{ zIndex: Z.carouselOverlay }}
      // aria-modal sits on the scrim, not the sheet: the carousel's swipe hook
      // ignores presses inside a modal, and a press on the scrim that reached
      // it would tap the card behind (on a dependant's card, entering child mode).
      role="dialog"
      aria-modal="true"
      aria-label="Switch identity"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={trapTab}
    >
      <div className="identity-switcher" ref={sheetRef}>
        <div className="identity-switcher-head">
          <h2>Your identities</h2>
          <button type="button" aria-label="Close" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        <ul className="identity-switcher-list">
          {rows.map((row, i) => {
            const { name, kind } = switcherRowLabel(row, surface);
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
                    style={isAdd ? undefined : { background: colourFromPubkey(pubkey), ...blurStyle }}>
                    {isAdd ? '+' : initialFromName(name)}
                  </span>
                  <span className="identity-switcher-text">
                    <span className="identity-switcher-name" style={isAdd ? undefined : blurStyle}>{name}</span>
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
