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
