// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { PendingChildAsk } from '../hooks/useChildAsks';
import { ChildAskApprovalModal } from './BunkerApprovalModal';
import { BunkerPanel } from './BunkerPanel';
import { CHILD_ASK_COPY } from '../lib/child-device-copy';

const PERSONA = 'b'.repeat(64);

function pending(over: Partial<PendingChildAsk['ask']> = {}): PendingChildAsk {
  return {
    ask: {
      v: 1, id: '0'.repeat(31) + '1', dependantId: 'd'.repeat(64), persona: PERSONA, scope: 'post-public', kind: 1, method: 'sign_event',
      target: 'site:https://game.example.com', targetLabel: 'game.example.com',
      template: { kind: 1, pubkey: PERSONA, created_at: 1, tags: [], content: 'hello world' },
      createdAt: 1, expiresAt: 601, templateHash: 'a'.repeat(64), contentTruncated: false, contentLength: 11, tagsTruncated: false, ...over,
    },
    dependantId: 'd'.repeat(64), dependantName: 'Lily', personaName: 'Lil', receivedAt: 1,
  };
}

describe('ChildAskApprovalModal', () => {
  it('shows who, as which persona, where, and what; three answers', () => {
    render(<ChildAskApprovalModal asks={[pending()]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    expect(screen.getByText(CHILD_ASK_COPY.heading('Lily', 'note (kind 1)'))).toBeTruthy();
    expect(screen.getByText(CHILD_ASK_COPY.as('Lil'))).toBeTruthy();
    expect(screen.getByText(CHILD_ASK_COPY.on('game.example.com'))).toBeTruthy();
    expect(screen.getByRole('button', { name: CHILD_ASK_COPY.allowOnce })).toBeTruthy();
    expect(screen.getByRole('button', { name: CHILD_ASK_COPY.allowAlways('game.example.com', 'Lil') })).toBeTruthy();
    expect(screen.getByRole('button', { name: CHILD_ASK_COPY.deny })).toBeTruthy();
  });

  it('full-control: no Always button', () => {
    render(<ChildAskApprovalModal asks={[pending()]} alwaysAvailableFor={() => false} onDecide={vi.fn()} />);
    expect(screen.queryByRole('button', { name: CHILD_ASK_COPY.allowAlways('game.example.com', 'Lil') })).toBeNull();
  });

  it('A12: a truncated request says how much is hidden', () => {
    render(<ChildAskApprovalModal asks={[pending({ contentTruncated: true, contentLength: 5011, template: { kind: 1, pubkey: PERSONA, created_at: 1, tags: [], content: 'x'.repeat(4096) } })]}
      alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    expect(screen.getByText(CHILD_ASK_COPY.hidden(915))).toBeTruthy();
  });

  it('a push failure keeps the reason on screen after the ask has gone', async () => {
    const onDecide = vi.fn(async () => ({ sent: true, reason: 'device-unreachable' as const }));
    const { rerender } = render(<ChildAskApprovalModal asks={[pending()]} alwaysAvailableFor={() => true} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: CHILD_ASK_COPY.allowOnce }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(pending().ask.id, 'once', undefined));
    rerender(<ChildAskApprovalModal asks={[]} alwaysAvailableFor={() => true} onDecide={onDecide} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(CHILD_ASK_COPY.reasons['device-unreachable']));
  });

  it('Deny carries the "Always deny" tick', async () => {
    const onDecide = vi.fn(async () => ({ sent: true }));
    render(<ChildAskApprovalModal asks={[pending()]} alwaysAvailableFor={() => true} onDecide={onDecide} />);
    fireEvent.click(screen.getByLabelText(CHILD_ASK_COPY.alwaysDeny));
    fireEvent.click(screen.getByRole('button', { name: CHILD_ASK_COPY.deny }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(pending().ask.id, 'deny', { alwaysDeny: true }));
  });
});

describe('BunkerPanel — child asks in Family asks', () => {
  it('lists each child ask and answers through onChildAskDecide', async () => {
    const onChildAskDecide = vi.fn(async () => ({ sent: true }));
    render(<BunkerPanel onClose={vi.fn()} bunkerAllowed stayAwakeUntil={null} onGoToSecurity={vi.fn()} onArmStayAwake={vi.fn()} onCloseStayAwake={vi.fn()}
      wakeLockSupported={false} pendingApprovals={[]} onApproveOnce={vi.fn()} onApproveAlways={vi.fn()} onDeny={vi.fn()}
      dependantNameFor={() => undefined} hasDependants serveStatus={{ state: 'idle' } as never} locked={false}
      onRequestUnlockWithPendingArm={vi.fn()} isNative={false} backgroundServing={false} onSetBackgroundServing={vi.fn(async () => {})}
      childAsks={[pending()]} childAskAlwaysAvailable={() => true} onChildAskDecide={onChildAskDecide} />);
    expect(screen.getByText('Family asks')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: CHILD_ASK_COPY.allowAlways('game.example.com', 'Lil') }));
    await waitFor(() => expect(onChildAskDecide).toHaveBeenCalledWith(pending().ask.id, 'always', undefined));
  });
});
