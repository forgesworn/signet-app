// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KnownPlacesStrip } from './KnownPlacesStrip';
import type { KnownPlace } from '../types/known-places';

const CONTAINER = 300;
const CHIP = 100;
const MORE = 40;

function place(i: number, over: Partial<KnownPlace> = {}): KnownPlace {
  return {
    id: `https://s${i}.example:${'a'.repeat(64)}`, pubkey: 'a'.repeat(64), placeKey: `https://s${i}.example`,
    kind: 'sign-in', name: `Site ${i}`, origin: `https://s${i}.example`, channel: 'browser', signer: 'local',
    firstAt: 100, lastAt: 1000 - i, uses: 1, shared: {}, ...over,
  };
}
const many = (n: number) => Array.from({ length: n }, (_, i) => place(i));

let widthsActive = true;
const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const originalRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

beforeEach(() => {
  widthsActive = true;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (!widthsActive) return 0;
      if (this.hasAttribute('data-kp-chip')) return CHIP;
      if (this.hasAttribute('data-kp-more')) return MORE;
      if (this.classList.contains('kp-strip')) return CONTAINER;
      return 0;
    },
  });
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
});
afterEach(() => {
  cleanup();
  if (originalWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalWidth);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalRO;
  vi.restoreAllMocks();
});

const baseProps = { badges: () => null, locked: false, onUnlock: vi.fn(), onOpenPlace: vi.fn() };

describe('KnownPlacesStrip', () => {
  it('shows one quiet line when nothing is known', () => {
    render(<KnownPlacesStrip {...baseProps} places={[]} />);
    expect(screen.getByText('Not known anywhere yet')).toBeDefined();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('shows two chips and no +N', () => {
    render(<KnownPlacesStrip {...baseProps} places={many(2)} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('shows eight short chips when they fit in two rows', () => {
    // 300px wide, 100px chips: three per row would be 6; shrink the chips.
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.hasAttribute('data-kp-chip')) return 60;
        if (this.hasAttribute('data-kp-more')) return MORE;
        return this.classList.contains('kp-strip') ? 300 : 0;
      },
    });
    render(<KnownPlacesStrip {...baseProps} places={many(8)} />);
    expect(screen.getAllByRole('button')).toHaveLength(8);
  });

  it('folds the rest of thirty into a +N chip', () => {
    render(<KnownPlacesStrip {...baseProps} places={many(30)} />);
    const buttons = screen.getAllByRole('button');
    const more = buttons[buttons.length - 1];
    expect(more.textContent).toMatch(/^\+\d+$/);
    const hidden = Number(more.textContent!.slice(1));
    expect(hidden).toBeGreaterThan(0);
    expect(buttons.length - 1 + hidden).toBe(30);
  });

  it('shows every chip when the strip has not been laid out', () => {
    widthsActive = false;
    render(<KnownPlacesStrip {...baseProps} places={many(5)} />);
    expect(screen.getAllByRole('button')).toHaveLength(5);
  });

  it('orders pinned first, then most recent', () => {
    const places = [place(1), place(2, { pinned: true, lastAt: 1 }), place(3, { lastAt: 5000 })];
    render(<KnownPlacesStrip {...baseProps} places={places} />);
    const labels = screen.getAllByRole('button').map(b => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Site 2', 'Site 3', 'Site 1']);
  });

  it('labels a chip by alias, then name, then host', () => {
    const places = [
      place(1, { alias: 'Mine' }),
      place(2, { name: '', origin: 'https://www.host.example/x' }),
    ];
    render(<KnownPlacesStrip {...baseProps} places={places} />);
    expect(screen.getByRole('button', { name: 'Mine' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'host.example' })).toBeDefined();
  });

  it('shows the primary badge on the chip', () => {
    render(<KnownPlacesStrip {...baseProps} places={many(1)} badges={() => ({ kind: 'auto', label: 'Signs automatically' })} />);
    expect(screen.getByRole('button', { name: 'Site 0, Signs automatically' })).toBeDefined();
  });

  it('shows only the unlock chip when locked, and unlocks on tap', () => {
    const onUnlock = vi.fn();
    render(<KnownPlacesStrip {...baseProps} places={many(3)} locked onUnlock={onUnlock} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it('routes a chip tap to its id and +N to null, and never opens a window', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onOpenPlace = vi.fn();
    const places = many(30);
    render(<KnownPlacesStrip {...baseProps} places={places} onOpenPlace={onOpenPlace} />);
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);
    expect(onOpenPlace).toHaveBeenLastCalledWith(places[0].id);
    fireEvent.click(buttons[buttons.length - 1]);
    expect(onOpenPlace).toHaveBeenLastCalledWith(null);
    expect(open).not.toHaveBeenCalled();
  });

  it('uses the supplied icon in place of the letter tile', () => {
    const { container } = render(<KnownPlacesStrip {...baseProps} places={many(1)} iconFor={() => 'data:image/png;base64,AAAA'} />);
    expect(container.querySelector('img.kp-tile-img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });
});
