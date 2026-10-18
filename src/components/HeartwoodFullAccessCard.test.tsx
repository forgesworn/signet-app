// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HeartwoodFullAccessCard, type HeartwoodFullAccessCardProps } from './HeartwoodFullAccessCard';
import { FULL_ACCESS_COPY } from '../lib/heartwood-one-hold';

function setup(over: Partial<HeartwoodFullAccessCardProps> = {}) {
  const props: HeartwoodFullAccessCardProps = {
    status: { owner: true, style: 'everyday' },
    checking: false,
    everHadFullAccess: true,
    label: null,
    hasOperatorKey: false,
    canNarrow: true,
    narrow: vi.fn().mockResolvedValue({ ok: true, changed: true }),
    turnOff: vi.fn().mockResolvedValue({ ok: true }),
    onOpenChoice: vi.fn(),
    ...over,
  };
  render(<HeartwoodFullAccessCard {...props} />);
  return props;
}

describe('HeartwoodFullAccessCard', () => {
  it('on: shows the status line, the style, and the lost-phone copy', () => {
    setup();
    expect(screen.getByText('Full access: on for this phone')).toBeTruthy();
    expect(screen.getByText(/Everyday\./)).toBeTruthy();
    expect(screen.getByText(FULL_ACCESS_COPY.lostPhone)).toBeTruthy();
  });

  it('A9 names the pairing label when an operator key supplied it', () => {
    setup({ label: 'Pixel 8' });
    expect(screen.getByText(/This phone's pairing: Pixel 8\. If you lose this phone, remove it in Sapwood\./)).toBeTruthy();
  });

  it('turn off without an operator key goes straight to turnOff (which clears the style) and shows the Sapwood line', async () => {
    const p = setup({ hasOperatorKey: false, turnOff: vi.fn().mockResolvedValue({ ok: false, message: FULL_ACCESS_COPY.sapwoodForget }) });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off full access' }));
    expect(await screen.findByText(FULL_ACCESS_COPY.sapwoodForget)).toBeTruthy();
    expect(p.turnOff).toHaveBeenCalledTimes(1);
  });

  it('m7: with an operator key, turning off needs a second tap that says what it takes back', async () => {
    const p = setup({ hasOperatorKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off full access' }));
    expect(p.turnOff).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog').textContent).toMatch(/everything your Heartwood has approved/);
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(p.turnOff).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Turn off full access' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off full access' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, turn it off' }));
    await waitFor(() => expect(p.turnOff).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Full access is off for this phone/)).toBeTruthy();
  });

  it('Everyday -> Extra careful is one tap with no choice screen', async () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Extra careful' }));
    await waitFor(() => expect(p.narrow).toHaveBeenCalledTimes(1));
    expect(p.onOpenChoice).not.toHaveBeenCalled();
  });

  it('no narrow button when the firmware lacks the narrow method', () => {
    setup({ canNarrow: false });
    expect(screen.queryByRole('button', { name: 'Switch to Extra careful' })).toBeNull();
  });

  it('Extra careful -> Everyday opens the choice screen (it needs the hold)', () => {
    const p = setup({ status: { owner: true, style: 'careful' } });
    expect(screen.queryByRole('button', { name: 'Switch to Extra careful' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Switch back to Everyday' }));
    expect(p.onOpenChoice).toHaveBeenCalledWith('everyday');
    expect(p.narrow).not.toHaveBeenCalled();
  });

  it('A10: an install that never had it is offered the one hold', () => {
    const p = setup({ status: { owner: false, style: 'everyday' }, everHadFullAccess: false });
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.offerExisting }));
    expect(p.onOpenChoice).toHaveBeenCalledWith('offer');
  });

  it('A8: a lost mark offers "Approve this phone again on your Heartwood"', () => {
    const p = setup({ status: { owner: false, style: 'everyday' }, everHadFullAccess: true });
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.approveAgain }));
    expect(p.onOpenChoice).toHaveBeenCalledWith('again');
  });

  it('unknown status is not shown as off and offers nothing', () => {
    setup({ status: null });
    expect(screen.getByText(/couldn't check just now/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: FULL_ACCESS_COPY.offerExisting })).toBeNull();
    expect(screen.queryByRole('button', { name: FULL_ACCESS_COPY.approveAgain })).toBeNull();
  });

  it('shows checking while the status is being asked', () => {
    setup({ status: null, checking: true });
    expect(screen.getByText('Full access: checking…')).toBeTruthy();
  });
});
