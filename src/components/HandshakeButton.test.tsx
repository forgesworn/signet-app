// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HandshakeButton } from './HandshakeButton';
const radio = vi.hoisted(() => ({ value: null as null | { nfc: string; bluetooth: string } }));
vi.mock('../hooks/useRadioStatus', () => ({ useRadioStatus: () => radio.value }));
afterEach(() => { cleanup(); vi.useRealTimers(); radio.value = null; });
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
it('shows no radio icons on the web', () => {
  const { container } = render(<HandshakeButton onStart={vi.fn()} />);
  expect(container.querySelector('.handshake-radio')).toBeNull();
  expect(screen.getByRole('button', { name: 'Handshake' })).not.toHaveAttribute('aria-description');
});
it('greys a radio that is off, keeps the name, and describes the state', () => {
  radio.value = { nfc: 'on', bluetooth: 'off' };
  const { container } = render(<HandshakeButton onStart={vi.fn()} />);
  const icons = container.querySelectorAll('.handshake-radio');
  expect(icons).toHaveLength(2);
  expect(icons[0]).not.toHaveClass('is-off'); expect(icons[1]).toHaveClass('is-off');
  expect(screen.getByRole('button', { name: 'Handshake' })).toHaveAttribute('aria-description', 'NFC on. Bluetooth off.');
});
it('hides the icon of a radio the phone does not have, and greys a refused permission', () => {
  radio.value = { nfc: 'none', bluetooth: 'denied' };
  const { container } = render(<HandshakeButton onStart={vi.fn()} />);
  const icons = container.querySelectorAll('.handshake-radio');
  expect(icons).toHaveLength(1); expect(icons[0]).toHaveClass('is-off');
  expect(screen.getByRole('button', { name: 'Handshake' })).toHaveAttribute('aria-description', 'Bluetooth not allowed.');
});
