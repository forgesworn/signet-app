// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChildReadyNotice } from './ChildReadyNotice';
import { CHILD_READY_COPY as COPY } from '../lib/child-ready-copy';
import type { ReadyRow } from '../lib/child-ready-check';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const row = (pubkey: string, state: ReadyRow['state'], extra: Partial<ReadyRow> = {}): ReadyRow =>
  ({ pubkey, name: pubkey.slice(0, 2), who: 'child', state, verified: false, ...extra });

describe('ChildReadyNotice', () => {
  it('one press owed: singular copy, the at-home line and Finish now', () => {
    render(<ChildReadyNotice rows={[row(A, 'waiting'), row(B, 'ready')]} showReady onFinishNow={() => {}} />);
    expect(screen.getByText(COPY.notReadyHeading)).toBeTruthy();
    expect(screen.getByText('1 press still needed on your Heartwood.')).toBeTruthy();
    expect(screen.getByText(COPY.doAtHome)).toBeTruthy();
    expect(screen.getByText(COPY.finishNow)).toBeTruthy();
  });

  it('two presses owed (a skipped one still counts): plural copy', () => {
    render(<ChildReadyNotice rows={[row(A, 'waiting'), row(B, 'skipped')]} showReady={false} onFinishNow={() => {}} />);
    expect(screen.getByText('2 presses still needed on your Heartwood.')).toBeTruthy();
  });

  it('Finish now opens the checklist and retries', () => {
    const onFinishNow = vi.fn();
    render(<ChildReadyNotice rows={[row(A, 'waiting', { failed: true })]} showReady onFinishNow={onFinishNow} />);
    expect(screen.queryByTestId('ready-checklist')).toBeNull();
    fireEvent.click(screen.getByText(COPY.finishNow));
    expect(onFinishNow).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('ready-checklist')).toBeTruthy();
  });

  it('a probe waiting on the device shows the checklist with the press-and-hold line', () => {
    render(<ChildReadyNotice rows={[row(A, 'waiting', { probing: true })]} showReady onFinishNow={() => {}} />);
    expect(screen.getByText(COPY.pressAndHold)).toBeTruthy();
  });

  it('cleared once confirmed: the ready line when asked for, otherwise nothing', () => {
    const { rerender, container } = render(<ChildReadyNotice rows={[row(A, 'waiting')]} showReady onFinishNow={() => {}} />);
    expect(screen.getByText(COPY.notReadyHeading)).toBeTruthy();
    rerender(<ChildReadyNotice rows={[row(A, 'ready')]} showReady onFinishNow={() => {}} />);
    expect(screen.queryByText(COPY.notReadyHeading)).toBeNull();
    expect(screen.getByText(COPY.ready)).toBeTruthy();
    rerender(<ChildReadyNotice rows={[row(A, 'ready')]} showReady={false} onFinishNow={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});
