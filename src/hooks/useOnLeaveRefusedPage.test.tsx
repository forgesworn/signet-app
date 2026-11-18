// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOnLeaveRefusedPage } from './useOnLeaveRefusedPage';
import type { Page } from '../types';
import type { ChildModePageDecision } from '../lib/child-mode-page-allowlist';

type Props = { page: Page; decision: ChildModePageDecision; childModeOn: boolean };
function setup(initial: Props) {
  const onLeave = vi.fn();
  const view = renderHook((p: Props) => useOnLeaveRefusedPage({ ...p, onLeave }), { initialProps: initial });
  return { onLeave, ...view };
}

describe('useOnLeaveRefusedPage: staged request state is cleared however the child leaves a refused page', () => {
  it('fires when a refused page gives way to home (tab bar, Back, Home), not only on Decline', () => {
    const { onLeave, rerender } = setup({ page: 'settings-advanced', decision: 'refuse', childModeOn: true });
    expect(onLeave).not.toHaveBeenCalled();
    rerender({ page: 'home', decision: 'allow', childModeOn: true });
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('fires when a refused page gives way to another refused page', () => {
    const { onLeave, rerender } = setup({ page: 'settings-advanced', decision: 'refuse', childModeOn: true });
    rerender({ page: 'connections', decision: 'refuse', childModeOn: true });
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('does not fire while staying on the refused page, nor for a page that was not refused', () => {
    const { onLeave, rerender } = setup({ page: 'settings-advanced', decision: 'refuse', childModeOn: true });
    rerender({ page: 'settings-advanced', decision: 'refuse', childModeOn: true });
    expect(onLeave).not.toHaveBeenCalled();
    const second = setup({ page: 'contacts', decision: 'allow', childModeOn: true });
    second.rerender({ page: 'home', decision: 'allow', childModeOn: true });
    expect(second.onLeave).not.toHaveBeenCalled();
  });

  it('does not fire when child mode is off (the guardian leaving their own page)', () => {
    const { onLeave, rerender } = setup({ page: 'settings-advanced', decision: 'refuse', childModeOn: true });
    rerender({ page: 'settings-advanced', decision: 'allow', childModeOn: false });
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('a hold is not a refusal', () => {
    const { onLeave, rerender } = setup({ page: 'contacts', decision: 'hold', childModeOn: true });
    rerender({ page: 'home', decision: 'allow', childModeOn: true });
    expect(onLeave).not.toHaveBeenCalled();
  });
});
