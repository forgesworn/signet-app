// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { PairedChildRequestReview } from './PairedChildRequestReview';
import type { GuardianChildRequest, GuardianChildStuckRequest } from '../hooks/useGuardianChildContactRequests';

type DecideArgs = { decision: string; requestId: string; execute(plan: unknown): Promise<void>; reply(plan: unknown, status: string): Promise<void> };
const decide = vi.fn(async (args: DecideArgs) => {
  const plan = { requestId: args.requestId };
  if (args.decision === 'approve') await args.execute(plan);
  await args.reply(plan, args.decision === 'approve' ? 'pending' : 'denied');
  return plan;
});
vi.mock('../lib/child-contact-lifecycle', () => ({ decideChildContactRequest: (args: DecideArgs) => decide(args),
  GUARDIAN_CHILD_HISTORY_LABEL: { approved: 'Approved', completed: 'Completed', denied: 'Denied', expired: 'Expired', conflict: 'Conflict' } }));
const scope = { guardian: '1'.repeat(64), child: '2'.repeat(64), endpoint: '3'.repeat(64), client: '4'.repeat(64), personas: ['5'.repeat(64)] };
const request = { v: 1, id: 'a'.repeat(32), guardian: '1'.repeat(64), endpoint: '3'.repeat(64), client: '4'.repeat(64), persona: '5'.repeat(64), revision: 1, createdAt: 1, expiresAt: 600, invite: { v: 1, recipient: '7'.repeat(64), secret: '8'.repeat(64), relays: ['wss://relay.example'] } };
const item = { source: { scope, endpointPrivateKey: '6'.repeat(64) },
  receipt: { id: 'a'.repeat(32), fingerprint: 'b'.repeat(64), status: 'pending', revision: 1, updatedAt: 1, request } } as unknown as GuardianChildRequest;
const stuck = { source: item.source, plan: { requestId: 'c'.repeat(32), request: { ...request, id: 'c'.repeat(32) } } } as unknown as GuardianChildStuckRequest;
const props = () => ({ keyMaterial: 'key', now: () => 2, current: () => true, mayConnect: () => true, childName: () => 'Robin‮',
  onExecute: vi.fn(async () => {}), onAbandon: vi.fn(async () => {}), onReply: vi.fn(async () => {}), onCancel: vi.fn(async () => {}), onChanged: vi.fn() });
beforeEach(() => { decide.mockClear(); });
it('requires an explicit decision and reports completion', async () => {
  const p = props(); render(<PairedChildRequestReview requests={[item]} {...p} />);
  expect(screen.getByRole('heading', { name: 'Requests from paired children' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(p.onChanged).toHaveBeenCalled());
  expect(decide.mock.calls[0][0]).toMatchObject({ decision: 'approve', requestId: 'a'.repeat(32) });
  expect(p.onExecute).toHaveBeenCalledTimes(1);
  expect(p.onReply).toHaveBeenCalledWith(item, expect.anything(), 'pending');
});
it('sends a denial reply without executing an exchange', async () => {
  const p = props(); render(<PairedChildRequestReview requests={[item]} {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
  await waitFor(() => expect(p.onReply).toHaveBeenCalledWith(item, expect.anything(), 'denied'));
  expect(p.onExecute).not.toHaveBeenCalled();
});
it('shows a stuck request with one Cancel action and no approval buttons', async () => {
  const p = props(); render(<PairedChildRequestReview requests={[]} stuck={[stuck]} {...p} />);
  expect(screen.getByText('This request stopped partway. Cancel it so Robin can ask again.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
  await waitFor(() => expect(p.onCancel).toHaveBeenCalledWith(stuck));
  await waitFor(() => expect(p.onChanged).toHaveBeenCalled());
});
it('reports a failed cancellation', async () => {
  const p = props(); p.onCancel.mockRejectedValueOnce(new Error('Relay unavailable'));
  render(<PairedChildRequestReview requests={[]} stuck={[stuck]} {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Relay unavailable'));
});
it('shows recent terminal decisions (D4) even with nothing pending or stuck', () => {
  const p = props();
  const history = [{ source: item.source, receipt: { id: 'd'.repeat(32), fingerprint: 'b'.repeat(64), status: 'denied' as const, revision: 1, updatedAt: 1 } }];
  render(<PairedChildRequestReview requests={[]} history={history} {...p} />);
  expect(screen.getByText('Recent decisions')).toBeTruthy();
  expect(screen.getByText('Robin — Denied')).toBeTruthy();
});
it('renders nothing when there is no pending, stuck or history item', () => {
  const p = props();
  const { container } = render(<PairedChildRequestReview requests={[]} {...p} />);
  expect(container.firstChild).toBeNull();
});
