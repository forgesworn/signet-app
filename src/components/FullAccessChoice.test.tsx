// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FullAccessChoice } from './FullAccessChoice';
import { FULL_ACCESS_COPY, PAIRING_PROBLEM_COPY, type BundleRunResult } from '../lib/heartwood-one-hold';

const WORDS: [string, string, string] = ['nice', 'never', 'repair'];
const NP = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);
const OK: BundleRunResult = { ok: true, reply: { naturalPerson: NP, persona: PERSONA, actAs: ['persona'], style: 'everyday' } };

function setup(over: Partial<React.ComponentProps<typeof FullAccessChoice>> = {}) {
  const props = {
    words: WORDS,
    includeRealName: false,
    onRun: vi.fn().mockResolvedValue(OK),
    onApproved: vi.fn(),
    onSeparately: vi.fn(),
    onBack: vi.fn(),
    ...over,
  };
  render(<FullAccessChoice {...props} />);
  return props;
}

describe('FullAccessChoice', () => {
  it('shows the heading, the covers line, the warning and the card with the three words', () => {
    setup();
    expect(screen.getByRole('heading', { name: FULL_ACCESS_COPY.heading })).toBeTruthy();
    expect(screen.getByText(FULL_ACCESS_COPY.covers)).toBeTruthy();
    expect(screen.getByText(FULL_ACCESS_COPY.warning)).toBeTruthy();
    const card = screen.getByTestId('full-access-card');
    expect(card.textContent).toContain('FULL ACCESS');
    expect(card.textContent).toContain('nice never');
    expect(card.textContent).toContain('repair');
    expect(card.textContent).toContain('PERSONA ONLY');
    expect(card.textContent).toContain('SIGN IN, POST, BACK UP');
    expect(card.textContent).toContain('HOLD 5 SECONDS');
  });

  it('draws PERSONA + REAL NAME when the real identity is included', () => {
    setup({ includeRealName: true });
    expect(screen.getByTestId('full-access-card').textContent).toContain('PERSONA + REAL NAME');
  });

  it('sends nothing until the owner taps "Set up with one hold"', () => {
    const p = setup();
    expect(p.onRun).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: FULL_ACCESS_COPY.setUp })).toBeTruthy();
    expect(screen.getByRole('button', { name: FULL_ACCESS_COPY.separately })).toBeTruthy();
  });

  it('Extra careful redraws the card with its two lines and runs with that style', async () => {
    const p = setup();
    fireEvent.click(screen.getByLabelText(/Extra careful/));
    const card = screen.getByTestId('full-access-card');
    expect(card.textContent).toContain('SIGNS ALONE: BACKUPS');
    expect(card.textContent).toContain('ASKS: EVERYTHING ELSE');
    expect(card.textContent).not.toContain('SIGN IN, POST, BACK UP');
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.setUp }));
    await waitFor(() => expect(p.onApproved).toHaveBeenCalled());
    expect(p.onRun).toHaveBeenCalledWith('careful');
    expect(p.onApproved).toHaveBeenCalledWith(OK.ok ? OK.reply : null, 'careful');
  });

  it('a double tap sends one bundle', async () => {
    let release!: (r: BundleRunResult) => void;
    const onRun = vi.fn(() => new Promise<BundleRunResult>(r => { release = r; }));
    const p = setup({ onRun });
    const btn = screen.getByRole('button', { name: FULL_ACCESS_COPY.setUp });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(FULL_ACCESS_COPY.holding)).toBeTruthy();
    release(OK);
    await waitFor(() => expect(p.onApproved).toHaveBeenCalledTimes(1));
  });

  it('a declined card says nothing changed and offers Try again and separately; Try again is another tap', async () => {
    const onRun = vi.fn()
      .mockResolvedValueOnce({ ok: false, failure: { action: 'retry', code: 'declined', message: FULL_ACCESS_COPY.declined } })
      .mockResolvedValueOnce(OK);
    const p = setup({ onRun });
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.setUp }));
    expect(await screen.findByText(FULL_ACCESS_COPY.declined)).toBeTruthy();
    expect(onRun).toHaveBeenCalledTimes(1); // never retried by itself
    expect(screen.getByRole('button', { name: FULL_ACCESS_COPY.separately })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.tryAgain }));
    await waitFor(() => expect(p.onApproved).toHaveBeenCalled());
    expect(onRun).toHaveBeenCalledTimes(2);
  });

  it('a pairing problem shows the section 7 line, then Continue runs today\'s flow', async () => {
    const onRun = vi.fn().mockResolvedValue({ ok: false, failure: { action: 'continue', code: 'strict', message: PAIRING_PROBLEM_COPY.strict } });
    const p = setup({ onRun });
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.setUp }));
    expect(await screen.findByText(PAIRING_PROBLEM_COPY.strict)).toBeTruthy();
    expect(p.onSeparately).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(p.onSeparately).toHaveBeenCalledTimes(1);
  });

  it('a silent refusal (approval list full) carries straight on to today\'s flow', async () => {
    const onRun = vi.fn().mockResolvedValue({ ok: false, failure: { action: 'silent', code: 'approval-list-full', message: '' } });
    const p = setup({ onRun });
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.setUp }));
    await waitFor(() => expect(p.onSeparately).toHaveBeenCalledTimes(1));
    expect(p.onApproved).not.toHaveBeenCalled();
  });

  it('"Approve each thing separately" runs today\'s flow without sending anything', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.separately }));
    expect(p.onSeparately).toHaveBeenCalledTimes(1);
    expect(p.onRun).not.toHaveBeenCalled();
  });

  it('the Settings variants relabel the secondary button and can start on Everyday or Extra careful', () => {
    setup({ separatelyLabel: 'Not now', initialStyle: 'careful' });
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy();
    expect((screen.getByLabelText(/Extra careful/) as HTMLInputElement).checked).toBe(true);
  });
});
