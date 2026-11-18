// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOnChildModeEntered } from './useOnChildModeEntered';
import type { ChildModeState } from '../lib/child-mode-sign-in';

function setup(initial: ChildModeState) {
  const onEntered = vi.fn();
  const view = renderHook((childMode: ChildModeState) => useOnChildModeEntered(childMode, onEntered), { initialProps: initial });
  return { onEntered, ...view };
}

describe('useOnChildModeEntered', () => {
  it('fires once when child mode goes from off to on', () => {
    const { onEntered, rerender } = setup('off');
    expect(onEntered).not.toHaveBeenCalled();
    rerender('on');
    expect(onEntered).toHaveBeenCalledTimes(1);
    rerender('on');
    expect(onEntered).toHaveBeenCalledTimes(1);
  });

  it('fires when it resolves from unknown to on, and again on the next entry', () => {
    const { onEntered, rerender } = setup('unknown');
    expect(onEntered).not.toHaveBeenCalled();
    rerender('on');
    rerender('off');
    rerender('on');
    expect(onEntered).toHaveBeenCalledTimes(2);
  });

  it('does not fire when it resolves to off', () => {
    const { onEntered, rerender } = setup('unknown');
    rerender('off');
    expect(onEntered).not.toHaveBeenCalled();
  });
});
