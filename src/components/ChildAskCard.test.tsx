// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { PendingChildAsk } from '../hooks/useChildAsks';
import { useState } from 'react';
import { ChildAskApprovalModal } from './BunkerApprovalModal';
import { askTargetText } from './ChildAskCard';
import { shortNpub } from '../lib/signet';
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
const panelProps = {
  onClose: vi.fn(), bunkerAllowed: true, stayAwakeUntil: null, onGoToSecurity: vi.fn(), onArmStayAwake: vi.fn(), onCloseStayAwake: vi.fn(),
  wakeLockSupported: false, pendingApprovals: [], onApproveOnce: vi.fn(), onApproveAlways: vi.fn(), onDeny: vi.fn(),
  dependantNameFor: () => undefined, hasDependants: true, serveStatus: { state: 'idle' } as never, locked: false,
  onRequestUnlockWithPendingArm: vi.fn(), onRequestUnlockForAlwaysOn: vi.fn(), isNative: false, backgroundServing: false, alwaysOnWanted: false, onSetBackgroundServing: vi.fn(async () => {}),
};

describe('A36: the card shows the re-derived target first, the child\'s label second', () => {
  it('site target: host as primary, label as a secondary note; Always names scope + target + persona', () => {
    const p = pending({ scope: 'sign-in', kind: 22242, target: 'site:https://school.org', targetLabel: 'Totally Safe Bank',
      template: { kind: 22242, pubkey: PERSONA, created_at: 1, tags: [], content: '' } });
    render(<ChildAskApprovalModal asks={[{ ...p, personaName: 'Sky' }]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    expect(screen.getByText(CHILD_ASK_COPY.on('school.org'))).toBeTruthy();
    expect(screen.queryByText(CHILD_ASK_COPY.on('Totally Safe Bank'))).toBeNull();
    expect(screen.getByTestId('child-ask-label').textContent).toBe(CHILD_ASK_COPY.labelNote('Totally Safe Bank'));
    expect(screen.getByRole('button', { name: 'Always allow sign-in to school.org for Sky' })).toBeTruthy();
  });
  it('peer / app targets are shown from the target, not the label', () => {
    const peer = 'c'.repeat(64);
    expect(askTargetText(`peer:${peer}`)).toBe(shortNpub(peer));
    expect(askTargetText('app:nip55:com.example.game')).toBe('com.example.game');
    expect(askTargetText('app:mysignet')).toBe(CHILD_ASK_COPY.appMySignet);
    expect(askTargetText(`app:${'a1'.repeat(32)}`)).toBe(CHILD_ASK_COPY.appHex('a1a1a1a1…'));
  });
  it('a label equal to the target is not repeated', () => {
    render(<ChildAskApprovalModal asks={[pending()]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    expect(screen.queryByTestId('child-ask-label')).toBeNull();
  });
});

describe('A34: an answer that has not reached the child', () => {
  it('offers only "Send again" of the chosen verdict', async () => {
    const onDecide = vi.fn(async () => ({ sent: true }));
    render(<ChildAskApprovalModal asks={[{ ...pending(), unsent: { verdict: 'once' } }]} alwaysAvailableFor={() => true} onDecide={onDecide} />);
    expect(screen.queryByRole('button', { name: CHILD_ASK_COPY.allowOnce })).toBeNull();
    expect(screen.queryByRole('button', { name: CHILD_ASK_COPY.deny })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: CHILD_ASK_COPY.sendAgain('Allow once') }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(pending().ask.id, 'once', undefined));
  });
});

describe('A37: one sheet at a time, "Later" keeps the ask in the panel', () => {
  function Harness({ asks }: { asks: PendingChildAsk[] }) {
    const [later, setLater] = useState<Set<string>>(new Set());
    const sheet = asks.filter(a => !later.has(a.ask.id));
    return (
      <>
        {sheet.length > 0 && (
          <ChildAskApprovalModal asks={sheet} alwaysAvailableFor={() => true} onDecide={vi.fn()}
            onLater={(ids) => setLater(new Set([...later, ...ids]))} />
        )}
        <BunkerPanel {...panelProps} childAsks={asks} childAskAlwaysAvailable={() => true} onChildAskDecide={vi.fn(async () => ({ sent: true }))} />
      </>
    );
  }
  it('shows one ask with "N more waiting"; Later closes the sheet and the asks stay in Family asks', () => {
    const second = pending({ id: '0'.repeat(31) + '2' });
    render(<Harness asks={[pending(), second]} />);
    expect(screen.getAllByRole('dialog').filter(d => d.getAttribute('aria-label') === 'Child request')).toHaveLength(1);
    expect(screen.getByTestId('child-ask-more').textContent).toBe(CHILD_ASK_COPY.moreWaiting(1));
    const before = screen.getAllByTestId('child-ask-card').length;
    expect(before).toBe(3); // one in the sheet, two in the panel
    fireEvent.click(screen.getByRole('button', { name: CHILD_ASK_COPY.later }));
    expect(screen.queryAllByRole('dialog').filter(d => d.getAttribute('aria-label') === 'Child request')).toHaveLength(0);
    expect(screen.getAllByTestId('child-ask-card')).toHaveLength(2);
  });
});

describe('ChildAskApprovalModal', () => {
  it('shows who, as which persona, where, and what; three answers', () => {
    render(<ChildAskApprovalModal asks={[pending()]} alwaysAvailableFor={() => true} onDecide={vi.fn()} />);
    expect(screen.getByText(CHILD_ASK_COPY.heading('Lily', 'note (kind 1)'))).toBeTruthy();
    expect(screen.getByText(CHILD_ASK_COPY.as('Lil'))).toBeTruthy();
    expect(screen.getByText(CHILD_ASK_COPY.on('game.example.com'))).toBeTruthy();
    expect(screen.getByRole('button', { name: CHILD_ASK_COPY.allowOnce })).toBeTruthy();
    expect(screen.getByRole('button', { name: CHILD_ASK_COPY.allowAlways('public posts on', 'game.example.com', 'Lil') })).toBeTruthy();
    expect(screen.getByRole('button', { name: CHILD_ASK_COPY.deny })).toBeTruthy();
  });

  it('full-control: no Always button', () => {
    render(<ChildAskApprovalModal asks={[pending()]} alwaysAvailableFor={() => false} onDecide={vi.fn()} />);
    expect(screen.queryByRole('button', { name: CHILD_ASK_COPY.allowAlways('public posts on', 'game.example.com', 'Lil') })).toBeNull();
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
    render(<BunkerPanel {...panelProps}
      childAsks={[pending()]} childAskAlwaysAvailable={() => true} onChildAskDecide={onChildAskDecide} />);
    expect(screen.getByText('Family asks')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: CHILD_ASK_COPY.allowAlways('public posts on', 'game.example.com', 'Lil') }));
    await waitFor(() => expect(onChildAskDecide).toHaveBeenCalledWith(pending().ask.id, 'always', undefined));
  });
});
