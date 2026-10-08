// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HandshakeButton } from './HandshakeButton';
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('taps start and long presses choose, without a following click starting twice', () => {
  vi.useFakeTimers(); const start = vi.fn(); render(<HandshakeButton onStart={start} />);
  const button = screen.getByRole('button', { name: 'Handshake' });
  fireEvent.click(button); expect(start).toHaveBeenLastCalledWith(false);
  start.mockClear(); fireEvent.pointerDown(button); vi.advanceTimersByTime(550);
  fireEvent.pointerUp(button); fireEvent.click(button);
  expect(start).toHaveBeenCalledExactlyOnceWith(true);
});
it('cancelled gestures never start, and keyboard users can open the chooser', () => {
  vi.useFakeTimers(); const start = vi.fn(); render(<HandshakeButton onStart={start} />);
  const button = screen.getByRole('button', { name: 'Handshake' });
  fireEvent.pointerDown(button); fireEvent.pointerCancel(button); vi.advanceTimersByTime(550);
  fireEvent.click(button); expect(start).not.toHaveBeenCalled();
  fireEvent.keyDown(button, { key: 'Enter', shiftKey: true }); expect(start).toHaveBeenCalledExactlyOnceWith(true);
});
