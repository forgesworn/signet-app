// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BunkerPanel } from './BunkerPanel';
import { BunkerApprovalModal } from './BunkerApprovalModal';
import type { PendingApproval } from '../hooks/useBunkerServer';
import { FAMILY_PURPOSE } from '../lib/kinterest-authority';
const family = 'a'.repeat(64);
function approval(handle: number): PendingApproval {
  return { handle, route: { pubkey: 'b'.repeat(64), dependantId: null }, method: 'sign_event',
    client: { appName: 'Kinterest', appUrl: 'https://example.com', existing: true, pubkey: 'c'.repeat(64) },
    description: 'Family authorisation', template: { pubkey: 'b'.repeat(64), kind: 30078, created_at: 1, content: FAMILY_PURPOSE,
      tags: [['d', `kin-jar/family-authorisation/v2/${family}`], ['scope', 'kin-jar:family:v2'], ['family', family], ['challenge', 'd'.repeat(64)], ['approval', 'request']] } };
}
afterEach(cleanup);
function renderPanel(approve = vi.fn(), deny = vi.fn()) {
  render(<BunkerPanel onClose={() => {}} bunkerAllowed onGoToSecurity={() => {}} stayAwakeUntil={null}
    onArmStayAwake={() => {}} onCloseStayAwake={() => {}} wakeLockSupported={false}
    pendingApprovals={[approval(10), approval(20)]} onApproveOnce={approve} onApproveAlways={() => {}} onDeny={deny}
    dependantNameFor={() => undefined} hasDependants={false} serveStatus={{ phase: 'idle', routePubkeys: [], relayUrl: 'wss://example.com' } as never}
    locked={false} onRequestUnlockWithPendingArm={() => {}} isNative={false} backgroundServing={false} onSetBackgroundServing={async () => {}} />);
}
it.each([['Back button', () => fireEvent.click(screen.getByRole('button', { name: 'Back' }))], ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })]])('returns from a Kinterest review to the list via %s without answering', (_name, back) => {
  const approve = vi.fn(), deny = vi.fn();
  renderPanel(approve, deny);
  fireEvent.click(screen.getAllByRole('button', { name: 'Review authorisation' })[0]);
  expect(screen.getByText(`Family key: ${family}`)).toBeTruthy();
  back();
  expect(screen.getAllByRole('button', { name: 'Review authorisation' })).toHaveLength(2);
  expect(screen.queryByText(`Family key: ${family}`)).toBeNull();
  expect(deny).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled();
});
it('renders no Back button and ignores Escape when the modal has no onBack', () => {
  const deny = vi.fn();
  render(<BunkerApprovalModal approval={approval(10)} onApproveOnce={() => {}} onApproveAlways={() => {}} onDeny={deny} />);
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(deny).not.toHaveBeenCalled(); expect(screen.getByRole('dialog')).toBeTruthy();
});
it('reviews the selected authority handle in full before approve-once, without Always', () => {
  const approve = vi.fn(), always = vi.fn();
  render(<BunkerPanel onClose={() => {}} bunkerAllowed onGoToSecurity={() => {}} stayAwakeUntil={null}
    onArmStayAwake={() => {}} onCloseStayAwake={() => {}} wakeLockSupported={false}
    pendingApprovals={[approval(10), approval(20)]} onApproveOnce={approve} onApproveAlways={always} onDeny={() => {}}
    dependantNameFor={() => undefined} hasDependants={false} serveStatus={{ phase: 'idle', routePubkeys: [], relayUrl: 'wss://example.com' } as never}
    locked={false} onRequestUnlockWithPendingArm={() => {}} isNative={false} backgroundServing={false} onSetBackgroundServing={async () => {}} />);
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Always' })).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'Review authorisation' })[1]);
  expect(approve).not.toHaveBeenCalled();
  expect(screen.getByText(`Family key: ${family}`)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve this Kinterest authorisation' }));
  expect(approve).toHaveBeenCalledWith(20);
  expect(always).not.toHaveBeenCalled();
});
