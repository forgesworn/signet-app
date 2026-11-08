// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RelayProfileChangedModal } from './RelayProfileChangedModal';

afterEach(cleanup);

it('names the change, and each button reports its choice (#194)', () => {
  const onChoose = vi.fn();
  render(<RelayProfileChangedModal changedAt={1_794_000_000} onChoose={onChoose} />);
  expect(screen.getByRole('heading').textContent).toBe('This profile was changed in another app');
  expect(screen.getByText(/Nothing is published/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Use that version' }));
  fireEvent.click(screen.getByRole('button', { name: 'Replace it with my card' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onChoose.mock.calls.map(c => c[0])).toEqual(['adopt', 'replace', 'cancel']);
});
