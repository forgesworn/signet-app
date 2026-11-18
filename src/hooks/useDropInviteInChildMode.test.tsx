// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDropInviteInChildMode } from './useDropInviteInChildMode';
import type { ChildModeState } from '../lib/child-mode-sign-in';

type Props = { childMode: ChildModeState; pendingInvite: string | undefined };
function setup(initial: Props) {
  const onDrop = vi.fn();
  const view = renderHook((p: Props) => useDropInviteInChildMode({ ...p, onDrop }), { initialProps: initial });
  return { onDrop, ...view };
}

describe('useDropInviteInChildMode: a contact invite that arrives by link or hash in child mode is dropped, like a scanned one', () => {
  it('drops a pending invite when child mode is on', () => {
    const { onDrop } = setup({ childMode: 'on', pendingInvite: '{"invite":1}' });
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it('drops an invite that arrived while child mode was still unknown, once it resolves to on', () => {
    const { onDrop, rerender } = setup({ childMode: 'unknown', pendingInvite: '{"invite":1}' });
    expect(onDrop).not.toHaveBeenCalled();
    rerender({ childMode: 'on', pendingInvite: '{"invite":1}' });
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it('keeps the invite when child mode resolves to off (the guardian opens it as before)', () => {
    const { onDrop, rerender } = setup({ childMode: 'unknown', pendingInvite: '{"invite":1}' });
    rerender({ childMode: 'off', pendingInvite: '{"invite":1}' });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('does nothing with no pending invite', () => {
    const { onDrop } = setup({ childMode: 'on', pendingInvite: undefined });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('drops an invite that arrives later, while child mode is on', () => {
    const { onDrop, rerender } = setup({ childMode: 'on', pendingInvite: undefined });
    rerender({ childMode: 'on', pendingInvite: '{"invite":2}' });
    expect(onDrop).toHaveBeenCalledTimes(1);
  });
});
