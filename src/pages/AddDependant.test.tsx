// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddDependant } from './AddDependant';

describe('AddDependant — success screen', () => {
  async function arriveAtSuccess(props: Partial<Parameters<typeof AddDependant>[0]> = {}) {
    const onCreateDependant = vi.fn().mockResolvedValue('dep-id-123');
    render(
      <AddDependant
        onCreateDependant={onCreateDependant}
        onSwitchToDependant={vi.fn()}
        onPairDevice={vi.fn()}
        onTurnOnBunker={vi.fn()}
        bunkerServerEnabled={true}
        onBack={vi.fn()}
        {...props}
      />
    );
    fireEvent.change(screen.getByLabelText(/Their name/i), { target: { value: 'Lily' } });
    fireEvent.click(screen.getByText('Create identity'));
    await waitFor(() => screen.getByText(/Lily's identity is ready/));
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
});
