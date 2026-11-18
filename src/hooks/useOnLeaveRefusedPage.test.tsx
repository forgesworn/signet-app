// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOnLeaveRefusedPage } from './useOnLeaveRefusedPage';
import type { Page } from '../types';
import type { ChildModePageDecision } from '../lib/child-mode-page-allowlist';

type Props = { page: Page; decision: ChildModePageDecision; locked?: boolean };
function setup(initial: Props) {
  const onLeave = vi.fn();
  const view = renderHook((p: Props) => useOnLeaveRefusedPage({ ...p, onLeave }), { initialProps: initial });
  return { onLeave, ...view };
}

describe('useOnLeaveRefusedPage: staged request state is cleared however the child leaves a refused page', () => {
  it('fires when a refused page gives way to home (tab bar, Back, Home), not only on Decline', () => {
    const { onLeave, rerender } = setup({ page: 'settings-advanced', decision: 'refuse' });
    expect(onLeave).not.toHaveBeenCalled();
    rerender({ page: 'home', decision: 'allow' });
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('fires when a refused page gives way to another refused page', () => {
    const { onLeave, rerender } = setup({ page: 'settings-advanced', decision: 'refuse' });
    rerender({ page: 'connections', decision: 'refuse' });
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('does not fire while staying on the refused page, nor for a page that was not refused', () => {
    const { onLeave, rerender } = setup({ page: 'settings-advanced', decision: 'refuse' });
    rerender({ page: 'settings-advanced', decision: 'refuse' });
    expect(onLeave).not.toHaveBeenCalled();
    const second = setup({ page: 'contacts', decision: 'allow' });
    second.rerender({ page: 'home', decision: 'allow' });
    expect(second.onLeave).not.toHaveBeenCalled();
  });

  it('fires when the guardian\'s PIN turns child mode off on the refused page (nothing the child staged waits for them)', () => {
    const { onLeave, rerender } = setup({ page: 'approve-verification', decision: 'refuse' });
    rerender({ page: 'approve-verification', decision: 'allow' });
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('does not fire when child mode was never on (the guardian leaving their own page)', () => {
    const { onLeave, rerender } = setup({ page: 'settings-advanced', decision: 'allow' });
    rerender({ page: 'home', decision: 'allow' });
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('ignores a refuse-then-allow flip on the same page while locked (the lock-window dependants reload), not after a page change', () => {
    const { onLeave, rerender } = setup({ page: 'contact-detail', decision: 'refuse', locked: true });
    rerender({ page: 'contact-detail', decision: 'allow', locked: true });
    expect(onLeave).not.toHaveBeenCalled();
    const second = setup({ page: 'contact-detail', decision: 'refuse', locked: true });
    second.rerender({ page: 'home', decision: 'allow', locked: true });
    expect(second.onLeave).toHaveBeenCalledTimes(1);
  });

  it('still fires on a same-page refuse-then-allow flip while unlocked', () => {
    const { onLeave, rerender } = setup({ page: 'contact-detail', decision: 'refuse', locked: false });
    rerender({ page: 'contact-detail', decision: 'allow', locked: false });
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('a hold is not a refusal', () => {
    const { onLeave, rerender } = setup({ page: 'contacts', decision: 'hold' });
    rerender({ page: 'home', decision: 'allow' });
    expect(onLeave).not.toHaveBeenCalled();
  });
});
