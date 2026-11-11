// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const native = vi.hoisted(() => ({ on: true }));
const cap = vi.hoisted(() => ({
  listeners: [] as Array<{ cb: () => void; removed: boolean }>,
}));

vi.mock('../lib/native', () => ({ isNativeApp: () => native.on }));
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((_event: string, cb: () => void) => {
      const entry = { cb, removed: false };
      cap.listeners.push(entry);
      return Promise.resolve({ remove: async () => { entry.removed = true; } });
    }),
  },
}));

import { useNativeBack } from './useNativeBack';

function Screen({ onBack }: { onBack: (() => void) | null }) {
  useNativeBack(onBack);
  return null;
}

/** Fire the gesture the way Capacitor does: every registered listener. */
function pressBack() {
  for (const l of cap.listeners) if (!l.removed) l.cb();
}

const live = () => cap.listeners.filter(l => !l.removed).length;
const flush = () => new Promise(r => setTimeout(r, 0));

describe('useNativeBack', () => {
  beforeEach(() => { native.on = true; cap.listeners = []; });
  afterEach(() => { cleanup(); });

  it('registers nothing outside the native app', () => {
    native.on = false;
    render(<Screen onBack={vi.fn()} />);
    expect(cap.listeners).toHaveLength(0);
  });

  it('registers nothing for a null handler, so the platform default stands', () => {
    render(<Screen onBack={null} />);
    expect(cap.listeners).toHaveLength(0);
  });

  it('runs the handler on back, and the latest handler after a re-render', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Screen onBack={first} />);
    pressBack();
    expect(first).toHaveBeenCalledTimes(1);
    rerender(<Screen onBack={second} />);
    pressBack();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(cap.listeners).toHaveLength(1);
  });

  it('only the most recently activated screen handles back; it hands back on null', () => {
    const host = vi.fn();
    const child = vi.fn();
    const { rerender } = render(<><Screen onBack={host} /></>);
    rerender(<><Screen onBack={host} /><Screen onBack={child} /></>);
    pressBack();
    expect(child).toHaveBeenCalledTimes(1);
    expect(host).not.toHaveBeenCalled();
    rerender(<><Screen onBack={host} /><Screen onBack={null} /></>);
    pressBack();
    expect(host).toHaveBeenCalledTimes(1);
    expect(child).toHaveBeenCalledTimes(1);
  });

  it('drops the listener once no handler is active, and a stale one never fires', async () => {
    const onBack = vi.fn();
    const { rerender } = render(<Screen onBack={onBack} />);
    const stale = cap.listeners[0];
    rerender(<Screen onBack={null} />);
    stale.cb(); // fired before its async removal lands
    expect(onBack).not.toHaveBeenCalled();
    await flush();
    expect(live()).toBe(0);
  });
});
