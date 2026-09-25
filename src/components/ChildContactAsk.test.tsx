// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ChildContactAsk } from './ChildContactAsk';

const invite = { v: 1 as const, recipient: '6'.repeat(64), secret: '7'.repeat(64), relays: ['wss://invite.example/'], caption: 'From the football club' };

it('shows the persona that will be used and the guardian name, sanitised', () => {
  render(<ChildContactAsk invite={invite} personaLabel="My persona" guardianName={'Mum‮'} onAsk={vi.fn()} onBack={vi.fn()} />);
  expect(screen.getByText(/You'll ask Mum to connect using My persona\./)).toBeTruthy();
  expect(screen.getByText('From the football club')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Ask Mum to connect' })).toBeTruthy();
});

it('falls back to "your guardian" when no cached name is available', () => {
  render(<ChildContactAsk invite={invite} personaLabel="My persona" guardianName={null} onAsk={vi.fn()} onBack={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Ask your guardian to connect' })).toBeTruthy();
});

it('shows the sent confirmation once the ask completes', async () => {
  const onAsk = vi.fn(async () => 'sent' as const);
  render(<ChildContactAsk invite={invite} personaLabel="My persona" guardianName="Mum" onAsk={onAsk} onBack={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mum to connect' }));
  await waitFor(() => expect(screen.getByText('Mum will review this request.')).toBeTruthy());
  expect(onAsk).toHaveBeenCalledTimes(1);
});

it('shows the queue-overflow message instead of a generic error', async () => {
  const onAsk = vi.fn(async () => 'full' as const);
  render(<ChildContactAsk invite={invite} personaLabel="My persona" guardianName="Mum" onAsk={onAsk} onBack={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mum to connect' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/too many requests waiting/));
});

it('shows a thrown error and lets the child try again', async () => {
  const onAsk = vi.fn(async () => { throw new Error('Pairing details are not available yet.'); });
  render(<ChildContactAsk invite={invite} personaLabel="My persona" guardianName="Mum" onAsk={onAsk} onBack={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mum to connect' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Pairing details are not available yet.'));
  expect(screen.getByRole('button', { name: 'Ask Mum to connect' })).not.toBeDisabled();
});

it('cancels back without asking', () => {
  const onBack = vi.fn();
  render(<ChildContactAsk invite={invite} personaLabel="My persona" guardianName="Mum" onAsk={vi.fn()} onBack={onBack} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onBack).toHaveBeenCalledTimes(1);
});

it('disables the ask and names no persona while none is available', () => {
  const onAsk = vi.fn();
  render(<ChildContactAsk invite={invite} personaLabel={null} guardianName="Mum" onAsk={onAsk} onBack={vi.fn()} />);
  expect(screen.queryByText(/connect using/)).toBeNull();
  expect(screen.getByRole('status').textContent).toMatch(/Waiting for Mum to share your personas/);
  const button = screen.getByRole('button', { name: 'Ask Mum to connect' });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(onAsk).not.toHaveBeenCalled();
});
