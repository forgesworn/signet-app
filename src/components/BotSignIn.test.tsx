// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BotSignIn } from './BotSignIn';
vi.mock('./QRScanner', () => ({ QRScanner: () => <div>Camera</div> }));
afterEach(cleanup);
const pubkey = 'b'.repeat(64);
const request = () => JSON.stringify({ type: 'signet-auth-request', requestId: 'a'.repeat(32), challenge: 'challenge-123456789',
  timestamp: Math.floor(Date.now() / 1000), origin: 'https://consumer.test/path', relay: 'wss://relay.test', sessionPubkey: 'c'.repeat(64) });
function scan(raw = request()) {
  fireEvent.change(screen.getByLabelText('Paste bot sign-in QR'), { target: { value: raw } });
  fireEvent.click(screen.getByText('Review bot sign-in'));
}
it('requires explicit bot consent, allows decline, and submits only the bot selection', async () => {
  const approve = vi.fn().mockResolvedValue(undefined);
  render(<BotSignIn pubkey={pubkey} label="Helper" onApprove={approve} />);
  scan(); expect(approve).not.toHaveBeenCalled();
  expect(screen.getByText('https://consumer.test')).toBeTruthy();
  fireEvent.click(screen.getByText('Decline')); expect(approve).not.toHaveBeenCalled();
  scan(); fireEvent.click(screen.getByText('Approve bot sign-in'));
  expect(approve.mock.calls[0][0]).toEqual({ source: 'bot', botPubkey: pubkey });
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('delivered'));
});
it('invalidates pending consent when navigating away and prevents duplicate approval', async () => {
  let finish!: () => void;
  const approve = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const view = render(<BotSignIn pubkey={pubkey} label="Helper" onApprove={approve} />);
  scan(); fireEvent.click(screen.getByText('Approve bot sign-in')); fireEvent.click(screen.getByText('Approve bot sign-in'));
  expect(approve).toHaveBeenCalledOnce();
  const current = (approve.mock.calls[0] as unknown as [unknown, unknown, () => boolean])[2];
  expect(current()).toBe(true); view.unmount(); expect(current()).toBe(false); finish();
});
it('refuses human credential requests on the bot camera', () => {
  const approve = vi.fn(); render(<BotSignIn pubkey={pubkey} label="Helper" onApprove={approve} />);
  scan(request().replace('signet-auth-request', 'signet-login-request'));
  expect(screen.getByRole('alert').textContent).toContain('Credentials and app connections');
  expect(screen.queryByText('Approve bot sign-in')).toBeNull(); expect(approve).not.toHaveBeenCalled();
});
