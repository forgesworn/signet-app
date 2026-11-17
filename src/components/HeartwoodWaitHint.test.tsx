// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { HeartwoodWaitHint, HEARTWOOD_WAIT_HINT_DELAY_MS } from './HeartwoodWaitHint';
import { SIGNER_WAITING_COPY } from '../lib/signer-error-copy';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('HeartwoodWaitHint', () => {
  it('renders nothing while inactive, however long it waits', () => {
    render(<HeartwoodWaitHint active={false} />);
    advance(HEARTWOOD_WAIT_HINT_DELAY_MS * 3);
    expect(screen.queryByText(SIGNER_WAITING_COPY)).toBeNull();
  });

  it('is hidden before the delay and shown (as a polite status) after it', () => {
    render(<HeartwoodWaitHint active />);
    advance(HEARTWOOD_WAIT_HINT_DELAY_MS - 1);
    expect(screen.queryByText(SIGNER_WAITING_COPY)).toBeNull();
    advance(1);
    const hint = screen.getByText(SIGNER_WAITING_COPY);
    expect(hint.getAttribute('role')).toBe('status');
    expect(hint.getAttribute('aria-live')).toBe('polite');
  });

  it('honours a custom delay', () => {
    render(<HeartwoodWaitHint active delayMs={100} />);
    advance(100);
    expect(screen.getByText(SIGNER_WAITING_COPY)).toBeTruthy();
  });

  it('hides at once when active goes false, and restarts the wait on re-activation', () => {
    const { rerender } = render(<HeartwoodWaitHint active />);
    advance(HEARTWOOD_WAIT_HINT_DELAY_MS);
    expect(screen.getByText(SIGNER_WAITING_COPY)).toBeTruthy();
    rerender(<HeartwoodWaitHint active={false} />);
    expect(screen.queryByText(SIGNER_WAITING_COPY)).toBeNull();
    rerender(<HeartwoodWaitHint active />);
    expect(screen.queryByText(SIGNER_WAITING_COPY)).toBeNull();
    advance(HEARTWOOD_WAIT_HINT_DELAY_MS - 1);
    expect(screen.queryByText(SIGNER_WAITING_COPY)).toBeNull();
    advance(1);
    expect(screen.getByText(SIGNER_WAITING_COPY)).toBeTruthy();
  });

  it('a short activation never shows it: going inactive cancels the pending timer', () => {
    const { rerender } = render(<HeartwoodWaitHint active />);
    advance(HEARTWOOD_WAIT_HINT_DELAY_MS - 1);
    rerender(<HeartwoodWaitHint active={false} />);
    advance(HEARTWOOD_WAIT_HINT_DELAY_MS);
    expect(screen.queryByText(SIGNER_WAITING_COPY)).toBeNull();
  });

  it('clears its timer on unmount', () => {
    const { unmount } = render(<HeartwoodWaitHint active />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
