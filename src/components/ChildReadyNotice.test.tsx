// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChildReadyNotice } from './ChildReadyNotice';
import { CHILD_READY_COPY as COPY } from '../lib/child-ready-copy';
import { readySummary, type ReadyRow } from '../lib/child-ready-check';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const row = (pubkey: string, state: ReadyRow['state'], extra: Partial<ReadyRow> = {}): ReadyRow =>
  ({ pubkey, name: pubkey.slice(0, 2), who: 'child', state, ...extra });

function notice(rows: ReadyRow[], over: Partial<Parameters<typeof ChildReadyNotice>[0]> = {}) {
  return <ChildReadyNotice rows={rows} summary={readySummary(rows, { paused: over.summary?.kind === 'paused' })} name="Lily" showReady onFinishNow={() => {}} {...over} />;
}

describe('ChildReadyNotice', () => {
  it('one press owed: singular copy, the at-home line and Finish now', () => {
    render(notice([row(A, 'waiting'), row(B, 'ready')]));
    expect(screen.getByText(COPY.notReadyHeading)).toBeTruthy();
    expect(screen.getByText('1 press still needed on your Heartwood.')).toBeTruthy();
    expect(screen.getByText(COPY.doAtHome)).toBeTruthy();
    expect(screen.getByText(COPY.finishNow)).toBeTruthy();
  });

  it('two presses owed (a skipped one still counts): plural copy', () => {
    render(notice([row(A, 'waiting'), row(B, 'skipped')], { showReady: false }));
    expect(screen.getByText('2 presses still needed on your Heartwood.')).toBeTruthy();
  });

  it('Finish now opens the checklist and retries', () => {
    const onFinishNow = vi.fn();
    render(notice([row(A, 'waiting', { failed: true })], { onFinishNow }));
    expect(screen.queryByTestId('ready-checklist')).toBeNull();
    fireEvent.click(screen.getByText(COPY.finishNow));
    expect(onFinishNow).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('ready-checklist')).toBeTruthy();
  });

  it('a probe waiting on the device shows the checklist with the press-and-hold line', () => {
    render(notice([row(A, 'waiting', { probing: true })]));
    expect(screen.getByText(COPY.pressAndHold)).toBeTruthy();
  });

  it('cleared once confirmed: the ready line when asked for, otherwise nothing', () => {
    const { rerender, container } = render(notice([row(A, 'waiting')]));
    expect(screen.getByText(COPY.notReadyHeading)).toBeTruthy();
    rerender(notice([row(A, 'ready')]));
    expect(screen.queryByText(COPY.notReadyHeading)).toBeNull();
    expect(screen.getByText(COPY.ready)).toBeTruthy();
    rerender(notice([row(A, 'ready')], { showReady: false }));
    expect(container.innerHTML).toBe('');
  });

  it('unknown: "Can\'t confirm from this phone", never Ready, a press count or Finish now', () => {
    render(notice([row(A, 'unknown'), row(B, 'ready')]));
    expect(screen.getByText(COPY.unknownHeading)).toBeTruthy();
    expect(screen.getByText(COPY.unknownBody('Lily'))).toBeTruthy();
    expect(screen.queryByText(COPY.ready)).toBeNull();
    expect(screen.queryByText(/still needed/)).toBeNull();
    expect(screen.queryByText(COPY.finishNow)).toBeNull();
  });

  it('a full slot: says the Heartwood cannot remember it, with no press count and no Finish now', () => {
    render(notice([row(A, 'full'), row(B, 'ready')]));
    expect(screen.getByText(COPY.fullHeading)).toBeTruthy();
    expect(screen.getByText(COPY.fullBody('Lily'))).toBeTruthy();
    expect(screen.queryByText(/still needed/)).toBeNull();
    expect(screen.queryByText(COPY.finishNow)).toBeNull();
  });

  it('paused: one line, no count, no button; ready still shows when everything is confirmed', () => {
    const rows = [row(A, 'waiting')];
    render(<ChildReadyNotice rows={rows} summary={readySummary(rows, { paused: true })} name="Lily" showReady onFinishNow={() => {}} />);
    expect(screen.getByText(COPY.paused('Lily'))).toBeTruthy();
    expect(screen.queryByText(/still needed/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
