// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddDependant } from './AddDependant';

function baseProps(overrides: Partial<Parameters<typeof AddDependant>[0]> = {}) {
  return {
    onCreateDependant: vi.fn().mockResolvedValue('dep-id-123'),
    onSwitchToDependant: vi.fn(),
    onPairDevice: vi.fn(),
    onTurnOnBunker: vi.fn(),
    bunkerServerEnabled: true,
    onBack: vi.fn(),
    showRoleConfirm: false,
    recoveryWords: null,
    onMarkBackedUp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('AddDependant — success screen', () => {
  async function arriveAtSuccess(props: Partial<Parameters<typeof AddDependant>[0]> = {}) {
    const merged = baseProps(props);
    render(<AddDependant {...merged} />);
    fireEvent.change(screen.getByLabelText(/Their name/i), { target: { value: 'Lily' } });
    fireEvent.click(screen.getByText(merged.showRoleConfirm ? "I'll hold their keys" : 'Create identity'));
    await waitFor(() => screen.getByText(/Lily's identity is ready/));
    return merged;
  }

  it('shows three buttons in the new order when bunker is enabled', async () => {
    await arriveAtSuccess();
    const pairBtn = screen.getByText(/Pair their phone now/);
    const handBtn = screen.getByText(/Hand this phone to Lily/);
    const doneBtn = screen.getByText(/Done for now/);
    expect(pairBtn).toBeDefined();
    expect(handBtn).toBeDefined();
    expect(doneBtn).toBeDefined();
    // Order check: Pair before Hand before Done
    const buttons = screen.getAllByRole('button');
    const pairIdx = buttons.findIndex(b => b === pairBtn);
    const handIdx = buttons.findIndex(b => b === handBtn);
    const doneIdx = buttons.findIndex(b => b === doneBtn);
    expect(pairIdx).toBeLessThan(handIdx);
    expect(handIdx).toBeLessThan(doneIdx);
  });

  it('replaces Pair CTA with "Turn the Bunker on first" when bunker is off', async () => {
    await arriveAtSuccess({ bunkerServerEnabled: false });
    expect(screen.queryByText(/Pair their phone now/)).toBeNull();
    expect(screen.getByText(/Turn the Bunker on first/)).toBeDefined();
  });

  it('calls onPairDevice with the new dependant id when Pair is tapped', async () => {
    const onPairDevice = vi.fn();
    await arriveAtSuccess({ onPairDevice });
    fireEvent.click(screen.getByText(/Pair their phone now/));
    expect(onPairDevice).toHaveBeenCalledWith('dep-id-123');
  });

  it('calls onTurnOnBunker when bunker-off CTA is tapped', async () => {
    const onTurnOnBunker = vi.fn();
    await arriveAtSuccess({ bunkerServerEnabled: false, onTurnOnBunker });
    fireEvent.click(screen.getByText(/Turn the Bunker on first/));
    expect(onTurnOnBunker).toHaveBeenCalled();
  });

  it('goes straight to success when recoveryWords is null', async () => {
    await arriveAtSuccess({ recoveryWords: null });
    expect(screen.getByText(/Lily's identity is ready/)).toBeDefined();
  });
});

describe('AddDependant — role confirm', () => {
  it('shows the role-confirm button label and three lines when showRoleConfirm is true', () => {
    render(<AddDependant {...baseProps({ showRoleConfirm: true })} />);
    expect(screen.getByText("I'll hold their keys")).toBeDefined();
    expect(screen.getByText('You will hold their keys. They come from your recovery words.')).toBeDefined();
    expect(screen.getByText('Sites will ask you to approve things for them.')).toBeDefined();
    expect(screen.getByText("One day they take these keys with them. That's a ceremony, not a delete.")).toBeDefined();
  });

  it('shows the ordinary button label and no role-confirm lines when showRoleConfirm is false', () => {
    render(<AddDependant {...baseProps({ showRoleConfirm: false })} />);
    expect(screen.getByText('Create identity')).toBeDefined();
    expect(screen.queryByText('You will hold their keys. They come from your recovery words.')).toBeNull();
  });
});

describe('AddDependant — backup step', () => {
  async function arriveAtBackup(props: Partial<Parameters<typeof AddDependant>[0]> = {}) {
    const merged = baseProps({ recoveryWords: ['a', 'b', 'c'], ...props });
    render(<AddDependant {...merged} />);
    fireEvent.change(screen.getByLabelText(/Their name/i), { target: { value: 'Lily' } });
    fireEvent.click(screen.getByText('Create identity'));
    await waitFor(() => screen.getByText(/keys are inside yours/));
    return merged;
  }

  it('shows the backup step when recoveryWords is non-empty', async () => {
    await arriveAtBackup();
    expect(screen.getByText(/Lily's keys are inside yours/)).toBeDefined();
  });

  it('"Not here" reaches success without calling onMarkBackedUp', async () => {
    const merged = await arriveAtBackup();
    fireEvent.click(screen.getByText('Not here'));
    await waitFor(() => screen.getByText(/Lily's identity is ready/));
    expect(merged.onMarkBackedUp).not.toHaveBeenCalled();
  });

  it('ticking the checkbox then Done calls onMarkBackedUp once and reaches success', async () => {
    const merged = await arriveAtBackup();
    const doneBtn = screen.getByText('Done');
    expect(doneBtn).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText(/written these down somewhere safe/i));
    fireEvent.click(doneBtn);
    await waitFor(() => screen.getByText(/Lily's identity is ready/));
    expect(merged.onMarkBackedUp).toHaveBeenCalledTimes(1);
  });
});
