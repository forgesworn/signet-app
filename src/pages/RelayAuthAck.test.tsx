// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RelayAuthAck } from './RelayAuthAck';

it('explains the requesting app relay and shows the actual rejection without calling it a primary failure', async () => {
  const retry = vi.fn(async () => {});
  render(<RelayAuthAck state="failed" relayHost="chosen.example" requestedRelay="chosen.example" primaryRelay="primary.example" siteName="V4V" failureReason="blocked: event kind not accepted" onRetry={retry} onCancel={vi.fn()} />);
  expect(screen.getByRole('alert').textContent).toBe('blocked: event kind not accepted');
  expect(screen.getByText(/V4V chose/).textContent).toContain('the app is listening for this response on its chosen relay');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(retry).toHaveBeenCalledOnce());
});

it('app permission decided by a guardian says the guardian decided, not the person holding the phone', () => {
  const { unmount } = render(<RelayAuthAck variant="app-permission" state="denied" siteName="Twang Thang" byGuardian onClose={() => {}} />);
  expect(screen.getByText('Your guardian said no to Twang Thang.')).toBeTruthy();
  unmount();
  render(<RelayAuthAck variant="app-permission" state="approved" siteName="Twang Thang" byGuardian onClose={() => {}} />);
  expect(screen.getByText(/^Your guardian let Twang Thang show other players who you are\./)).toBeTruthy();
});

it('app permission decided by the person themselves keeps the first-person copy', () => {
  render(<RelayAuthAck variant="app-permission" state="denied" siteName="Twang Thang" onClose={() => {}} />);
  expect(screen.getByText('You said no to Twang Thang.')).toBeTruthy();
});

it('names every relay the app chose when it chose several', () => {
  render(<RelayAuthAck state="failed" relayHost="nos.lol / relay.trotters.cc" requestedRelays={['nos.lol', 'relay.trotters.cc']} primaryRelay="primary.example" siteName="KithMoot" onRetry={vi.fn()} onCancel={vi.fn()} />);
  const text = screen.getByText(/KithMoot chose/).textContent ?? '';
  expect(text).toContain('chose nos.lol, relay.trotters.cc for this sign-in');
  expect(text).toContain('listening for this response on the relays it chose');
});

it('does not call the primary relay separate when it is one of the chosen relays', () => {
  render(<RelayAuthAck state="failed" relayHost="nos.lol" requestedRelays={['nos.lol', 'relay.trotters.cc']} primaryRelay="relay.trotters.cc" siteName="KithMoot" onRetry={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByText(/KithMoot chose/).textContent).not.toContain('Your primary relay');
});
