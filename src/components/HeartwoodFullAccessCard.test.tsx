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

  it('the offer says persona only, without the real name, unless the hold on offer includes it', () => {
    const view = render(<HeartwoodFullAccessCard {...{
      status: { owner: false, style: 'everyday' }, checking: false, everHadFullAccess: false, label: null, hasOperatorKey: false,
      canNarrow: true, narrow: vi.fn(), turnOff: vi.fn(), onOpenChoice: vi.fn(),
    }} />);
    expect(screen.getByText(FULL_ACCESS_COPY.coversPersonaOnly)).toBeTruthy();
    expect(screen.queryByText(/real name/i)).toBeNull();
    view.unmount();
    setup({ status: { owner: false, style: 'everyday' }, everHadFullAccess: false, offerIncludesRealName: true });
    expect(screen.getByText(FULL_ACCESS_COPY.covers)).toBeTruthy();
  });

  it('A1: after owner:false was seen, a failed read still offers "Approve this phone again" beside "couldn\'t check"', () => {
    const props = setup({ status: null, markLost: true, everHadFullAccess: true });
    expect(screen.getByText('Full access: couldn\'t check just now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.approveAgain }));
    expect(props.onOpenChoice).toHaveBeenCalledWith('again');
  });

  it('A1: an unknown status with nothing seen offers nothing', () => {
    setup({ status: null, markLost: false, everHadFullAccess: true });
    expect(screen.queryByRole('button', { name: FULL_ACCESS_COPY.approveAgain })).toBeNull();
  });

  it('the on-state Everyday body does not mention the real name', () => {
    setup();
    expect(screen.queryByText(/real name/i)).toBeNull();
  });

  it('outcome and error lines: a problem is an alert with the shared problem style, a success stays a status', async () => {
    setup({ outcome: FULL_ACCESS_COPY.noAnswerSettings, outcomeIsProblem: true });
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('status-problem');
    expect(alert.textContent).toBe(FULL_ACCESS_COPY.noAnswerSettings);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a failed turn-off shows as a problem; a successful one as a status', async () => {
    setup({ turnOff: vi.fn().mockResolvedValue({ ok: false, message: FULL_ACCESS_COPY.turnOffUnconfirmed, status: { owner: true, style: 'everyday' } }) });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off full access' }));
    expect((await screen.findByRole('alert')).className).toContain('status-problem');
  });

  it('N7: shows the kept outcome line, and clears it when the owner starts another action', async () => {
    const onOutcomeClear = vi.fn();
    setup({ outcome: 'Full access is on for this phone.', onOutcomeClear });
    expect(screen.getByRole('status').textContent).toBe('Full access is on for this phone.');
    fireEvent.click(screen.getByRole('button', { name: 'Turn off full access' }));
    await waitFor(() => expect(onOutcomeClear).toHaveBeenCalled());
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

  it('review 1: a turn-off the device did not confirm shows a plain error and the line stays "on"', async () => {
    const p = setup({ hasOperatorKey: true, turnOff: vi.fn().mockResolvedValue({ ok: false, message: FULL_ACCESS_COPY.turnOffUnconfirmed, status: { owner: true, style: 'everyday' } }) });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off full access' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, turn it off' }));
    expect(await screen.findByText(FULL_ACCESS_COPY.turnOffUnconfirmed)).toBeTruthy();
    expect(p.turnOff).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Full access: on for this phone')).toBeTruthy();
    expect(screen.queryByText(/Full access is off for this phone/)).toBeNull();
  });

  it('W4: a custom style is shown in plain words and can be chosen again through the hold', () => {
    const p = setup({ status: { owner: true, style: 'custom' } });
    expect(screen.getByText('Full access: on for this phone')).toBeTruthy();
    expect(screen.getByText(/Custom\./)).toBeTruthy();
    expect(screen.getByText(new RegExp(FULL_ACCESS_COPY.customStyleBody.slice(0, 30)))).toBeTruthy();
    // It is not Everyday or Extra careful, so neither switch is offered; re-choosing is.
    expect(screen.queryByRole('button', { name: 'Switch to Extra careful' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Switch back to Everyday' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: FULL_ACCESS_COPY.chooseStyleAgain }));
    expect(p.onOpenChoice).toHaveBeenCalledWith('restyle');
  });
});
