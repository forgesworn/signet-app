// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AwayApprovalList } from './AwayApprovalList';
import type { DeviceClientSlot } from '../lib/heartwood-mgmt-types';

function slot(overrides: Partial<DeviceClientSlot> = {}): DeviceClientSlot {
  return {
    slotIndex: 1, label: 'Primal', secretFingerprint: 'f'.repeat(64), autoApprove: false, signingApproved: true,
    strictPermissions: false, currentPubkey: null, authorizedPubkeys: [], allowedKinds: [], allowedMethods: [],
    escalate: false, petitionOnDeny: false, auditChildWrap: false, boundIdentity: null, ...overrides,
  };
}

describe('AwayApprovalList', () => {
  it('shows why it is blocked and never reads the device', () => {
    const load = vi.fn();
    render(<AwayApprovalList blocked="Import the operator key first." load={load} set={vi.fn()} />);
    expect(screen.getByText('Import the operator key first.')).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
  });

  it('turns on only after the risks are accepted', async () => {
    const set = vi.fn(async () => [slot({ escalate: true })]);
    render(<AwayApprovalList blocked={null} load={async () => [slot()]} set={set} />);
    fireEvent.click(await screen.findByText('Turn on…'));
    const turnOn = screen.getByText('Turn on') as HTMLButtonElement;
    expect(turnOn.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(turnOn);
    await waitFor(() => expect(set).toHaveBeenCalledWith(expect.objectContaining({ slotIndex: 1 }), true));
    expect(await screen.findByText('ON')).toBeTruthy();
  });

  it('turns off without asking, and shows a refusal', async () => {
    const set = vi.fn(async () => { throw new Error('Your Heartwood did not turn this off.'); });
    render(<AwayApprovalList blocked={null} load={async () => [slot({ escalate: true })]} set={set} />);
    fireEvent.click(await screen.findByText('Turn off'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ slotIndex: 1 }), false);
  });

  it('says so when the owner has no apps of their own paired', async () => {
    render(<AwayApprovalList blocked={null} load={async () => []} set={vi.fn()} />);
    expect(await screen.findByText(/No apps of your own/)).toBeTruthy();
  });
});
