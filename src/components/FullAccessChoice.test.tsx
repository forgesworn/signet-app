// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FullAccessChoice } from './FullAccessChoice';
import { FULL_ACCESS_COPY, PAIRING_PROBLEM_COPY, classifyBundleError, separatelyHint, type BundleRunResult } from '../lib/heartwood-one-hold';

const WORDS = ['nice', 'never', 'repair', 'area', 'upgrade'];
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
  it('shows the heading, the covers line, the warning and the card with the five words', () => {
    setup();
    expect(screen.getByRole('heading', { name: FULL_ACCESS_COPY.heading })).toBeTruthy();
    expect(screen.getByText(FULL_ACCESS_COPY.coversPersonaOnly)).toBeTruthy();
    expect(screen.getByText(FULL_ACCESS_COPY.warning)).toBeTruthy();
    const card = screen.getByTestId('full-access-card');
    expect(card.textContent).toContain('FULL ACCESS');
    expect(card.textContent).toContain('nice never');
    expect(card.textContent).toContain('repair area');
    expect(card.textContent).toContain('upgrade');
    expect(card.textContent).toContain('PERSONA ONLY');
    expect(card.textContent).toContain('SIGN IN, POST, BACKUP');
    expect(card.textContent).toContain('HOLD 5 SECONDS');
  });

  it('draws PERSONA + REAL NAME when the real identity is included', () => {
    setup({ includeRealName: true });
    expect(screen.getByTestId('full-access-card').textContent).toContain('PERSONA + REAL NAME');
  });

  it('persona-only hold: neither the covers line nor the Everyday body mentions the real name; the real-name hold keeps its wording', () => {
    const view = render(<FullAccessChoice words={WORDS} includeRealName={false} onRun={vi.fn()} onApproved={vi.fn()} onSeparately={vi.fn()} />);
    expect(screen.getByTestId('full-access-card').textContent).toContain('PERSONA ONLY');
    expect(screen.queryByText(/real name/i)).toBeNull();
    view.unmount();
    setup({ includeRealName: true });
    expect(screen.getByText(FULL_ACCESS_COPY.covers)).toBeTruthy();
    expect(screen.queryByText(FULL_ACCESS_COPY.coversPersonaOnly)).toBeNull();
  });

  it('the Everyday body is the same either way and never mentions the real name', () => {
    expect(FULL_ACCESS_COPY.everyday.body).not.toMatch(/real name/);
    setup({ includeRealName: true });
    expect(screen.getByText(FULL_ACCESS_COPY.everyday.body)).toBeTruthy();
    expect(screen.getByText(FULL_ACCESS_COPY.careful.body)).toBeTruthy();
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
    expect(card.textContent).toContain('ALONE: BACKUPS, APP DATA');
    expect(card.textContent).not.toContain('SIGNS ALONE');
    expect(card.textContent).toContain('ASKS: EVERYTHING ELSE');
    expect(card.textContent).not.toContain('SIGN IN, POST, BACKUP');
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

  it('M4: a busy or changed refusal at onboarding shows Try again instead of falling into today\'s flow', async () => {
    const failure = classifyBundleError('signer is busy with another approval; retry shortly');
    const onRun = vi.fn().mockResolvedValueOnce({ ok: false, failure }).mockResolvedValueOnce(OK);
    const p = setup({ onRun });
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.setUp }));
    expect(await screen.findByText(FULL_ACCESS_COPY.busy)).toBeTruthy();
    expect(p.onSeparately).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.tryAgain }));
    await waitFor(() => expect(p.onApproved).toHaveBeenCalled());
  });

  it('M1: the real escalate-slot refusal shows the Phone may OK line', async () => {
    const failure = classifyBundleError('this request must be approved at the device; a guardian verdict cannot answer it');
    setup({ onRun: vi.fn().mockResolvedValue({ ok: false, failure }) });
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.setUp }));
    expect(await screen.findByText(PAIRING_PROBLEM_COPY.phoneMayOk)).toBeTruthy();
  });

  it('M3: the separately hint gives the real number of cards', () => {
    setup({ showSeparatelyHint: true });
    expect(screen.getByText(separatelyHint())).toBeTruthy();
    expect(separatelyHint()).toContain('about 19 times');
  });

  it('m4: a label is drawn as the firmware draws it, on the hold screen; without one a placeholder stands in', () => {
    const { unmount } = render(<FullAccessChoice words={WORDS} includeRealName={false} label="My Signet" onRun={vi.fn()} onApproved={vi.fn()} onSeparately={vi.fn()} />);
    expect(screen.getByTestId('full-access-hold-screen').textContent).toContain('My Signet');
    unmount();
    setup();
    expect(screen.getByTestId('full-access-hold-screen').textContent).toContain("(this pairing's name)");
  });

  it('m12: says why the real name is included when only older backups need it', () => {
    setup({ includeRealName: true, realNameForLegacyBackups: true });
    expect(screen.getByText(FULL_ACCESS_COPY.realNameForLegacyBackups)).toBeTruthy();
    expect(screen.getByTestId('full-access-card').textContent).toContain('PERSONA + REAL NAME');
  });

  it('m12: no such line when the real name is set up, or not included', () => {
    const { unmount } = render(<FullAccessChoice words={WORDS} includeRealName realNameForLegacyBackups={false} onRun={vi.fn()} onApproved={vi.fn()} onSeparately={vi.fn()} />);
    expect(screen.queryByText(FULL_ACCESS_COPY.realNameForLegacyBackups)).toBeNull();
    unmount();
    setup({ includeRealName: false, realNameForLegacyBackups: true });
    expect(screen.queryByText(FULL_ACCESS_COPY.realNameForLegacyBackups)).toBeNull();
  });

  it('W2: the five words are drawn in the Heartwood\'s pages, at rest, two at a time, not "while you hold"', () => {
    setup();
    expect(screen.getByText(FULL_ACCESS_COPY.expect)).toBeTruthy();
    expect(FULL_ACCESS_COPY.expect).toContain('five words, two at a time');
    const pages = screen.getAllByTestId('full-access-word-page').map(el => el.textContent);
    expect(pages).toEqual(['1-2 of 5nice never', '3-4 of 5repair area', '5 of 5upgrade']);
    const text = screen.getByTestId('full-access-card').textContent ?? '';
    expect(text).not.toContain('while you hold');
    // The Heartwood's order at rest (oled.rs show_full_access): header, the words, the scope, the style line, the hint.
    expect(text.indexOf('FULL ACCESS')).toBeLessThan(text.indexOf('nice never'));
    expect(text.indexOf('nice never')).toBeLessThan(text.indexOf('PERSONA ONLY'));
    expect(text.indexOf('PERSONA ONLY')).toBeLessThan(text.indexOf('SIGN IN, POST, BACKUP'));
    expect(text.indexOf('SIGN IN, POST, BACKUP')).toBeLessThan(text.indexOf('COMPARE ALL 5 WORDS'));
    expect(screen.getByTestId('full-access-card').getAttribute('aria-label')).toContain('1-2 of 5: nice never; 3-4 of 5: repair area; 5 of 5: upgrade');
  });

  it('S5: the resting card has no label and says COMPARE ALL 5 WORDS; the label and all five words are only on the hold screen', () => {
    setup({ label: 'My Signet' });
    // The resting part is everything above the hold-screen block.
    const card = screen.getByTestId('full-access-card');
    const hold = screen.getByTestId('full-access-hold-screen');
    const resting = (card.textContent ?? '').replace(hold.textContent ?? '', '');
    expect(resting).not.toContain('My Signet');
    expect(screen.getByTestId('full-access-hint').textContent).toBe('COMPARE ALL 5 WORDS');
    // HOLD 5 SECONDS is not the resting hint: it is named as what the last line changes to.
    expect(screen.getByTestId('full-access-hint').textContent).not.toContain('HOLD');
    expect(card.textContent).toContain(FULL_ACCESS_COPY.cardHintChange('HOLD 5 SECONDS'));
    // The hold screen: the label, then all five words as w1 w2 / w3 w4 / w5.
    expect(hold.textContent).toContain('My Signet');
    const holdLines = Array.from(hold.querySelectorAll('div')).filter(d => d.children.length === 0).map(d => d.textContent);
    expect(holdLines).toEqual(['My Signet', 'nice never', 'repair area', 'upgrade']);
  });

  it('W2: the running line is the same instruction, with no "words appear while you hold"', async () => {
    let release!: (r: BundleRunResult) => void;
    setup({ onRun: vi.fn(() => new Promise<BundleRunResult>(r => { release = r; })) });
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.setUp }));
    const running = await screen.findByText(FULL_ACCESS_COPY.holding);
    expect(running.textContent).toContain('hold its button for 5 seconds');
    expect(running.textContent).not.toMatch(/while you hold|appear/);
    // Not repeated: the long instruction is replaced while waiting.
    expect(screen.queryByText(FULL_ACCESS_COPY.expect)).toBeNull();
    release(OK);
  });

  it('fits at phone width: no drawn line is longer than 32 characters, even for the longest words, and the drawing wraps', () => {
    const longest = ['abstract', 'accident', 'activity', 'actually', 'aluminum'];
    setup({ words: longest, includeRealName: true, label: 'a'.repeat(30), initialStyle: 'careful' });
    const card = screen.getByTestId('full-access-card');
    const lines = Array.from(card.querySelectorAll('div')).filter(d => d.children.length === 0).map(d => d.textContent ?? '');
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(32);
    for (const page of screen.getAllByTestId('full-access-word-page')) {
      expect((page.textContent ?? '').length).toBeLessThanOrEqual(8 + 17);
    }
    expect(card.style.overflowWrap).toBe('anywhere');
  });

  it('W3: the two one-card-at-a-time refusals offer Try again with the wait-a-minute line', async () => {
    for (const text of ['unauthorised: another full access request arrived', 'unauthorised: full access card shown recently']) {
      const failure = classifyBundleError(text);
      const { unmount } = render(
        <FullAccessChoice words={WORDS} includeRealName={false} onRun={vi.fn().mockResolvedValue({ ok: false, failure })} onApproved={vi.fn()} onSeparately={vi.fn()} />,
      );
      fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.setUp }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/try again in a minute/i);
      expect(screen.getByRole('button', { name: FULL_ACCESS_COPY.tryAgain })).toBeTruthy();
      unmount();
    }
  });

  it('note 3: a failed save shows the plain line and Try again', async () => {
    const failure = classifyBundleError('could not persist client policy; request was not applied');
    setup({ onRun: vi.fn().mockResolvedValue({ ok: false, failure }) });
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.setUp }));
    expect((await screen.findByRole('alert')).textContent).toBe('Your Heartwood couldn\'t save that. Nothing changed. You can try again in a minute.');
    expect(screen.getByRole('button', { name: FULL_ACCESS_COPY.tryAgain })).toBeTruthy();
  });

  it('the declined line tells the owner to wait a minute', async () => {
    const failure = classifyBundleError('user denied');
    setup({ onRun: vi.fn().mockResolvedValue({ ok: false, failure }) });
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.setUp }));
    expect((await screen.findByRole('alert')).textContent).toContain('You can try again in a minute.');
  });

  it('W9: Extra careful\'s body is the honest one', () => {
    setup();
    expect(screen.getByText(FULL_ACCESS_COPY.careful.body)).toBeTruthy();
    expect(FULL_ACCESS_COPY.careful.body).toContain('Backups, app data and relay logins');
  });
});
