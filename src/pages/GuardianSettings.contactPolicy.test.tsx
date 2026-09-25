// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { GuardianSettings } from './GuardianSettings';
import type { DependantIdentity } from '../types';

function dep(): DependantIdentity {
  return {
    id: 'c'.repeat(64), guardianPubkey: '1'.repeat(64), displayName: 'Sam',
    naturalPerson: { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Sam' },
    persona: { publicKey: 'd'.repeat(64), privateKey: '', displayName: 'Sam' },
    derivationPath: 'dependant-0', createdAt: 1, autonomyStage: 'full-control',
    primaryKeypair: 'persona',
  } as DependantIdentity;
}

function renderSettings(overrides: Record<string, unknown> = {}) {
  const onUpdateContactPolicy = vi.fn();
  const onUpdateDefaultChildCeiling = vi.fn();
  render(
    <GuardianSettings
      activeDependant={dep()}
      onSwitchDependantPrimary={() => {}}
      requestAuth={async () => null}
      ownerTier="standard"
      onUpdatePhoto={() => {}}
      currentContactPolicy="kin-only"
      onUpdateContactPolicy={onUpdateContactPolicy}
      currentDefaultChildCeiling="ken"
      onUpdateDefaultChildCeiling={onUpdateDefaultChildCeiling}
      viewer="guardian"
      {...overrides}
    />,
  );
  return { onUpdateContactPolicy, onUpdateDefaultChildCeiling };
}

describe('GuardianSettings contact policy', () => {
  it('offers the kin-only, approved and open options with close-circle wording', () => {
    renderSettings();
    expect(screen.getByRole('button', { name: 'Close circle only' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Approved contacts' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Open' })).toBeDefined();
  });

  it('persists the kin-only value, not the retired family-only spelling', () => {
    const { onUpdateContactPolicy } = renderSettings({ currentContactPolicy: 'open' });
    fireEvent.click(screen.getByRole('button', { name: 'Close circle only' }));
    expect(onUpdateContactPolicy).toHaveBeenCalledWith('kin-only');
  });

  it('offers the default child ceiling with one line of helper copy', () => {
    const { onUpdateDefaultChildCeiling } = renderSettings();
    expect(screen.getByText('Contacts your child adds start as')).toBeDefined();
    expect(screen.getByText(/Contacts Sam adds themselves are capped/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Kith' }));
    expect(onUpdateDefaultChildCeiling).toHaveBeenCalledWith('kith');
  });

  it('hides both controls from the child viewer', () => {
    renderSettings({ viewer: 'child' });
    expect(screen.queryByText('Contact policy')).toBeNull();
    expect(screen.queryByText('Contacts your child adds start as')).toBeNull();
  });

  // M8
  it('disables the ceiling buttons while a save is in flight, so a double-tap fires only one save', async () => {
    let resolveSave: () => void = () => {};
    const onUpdateDefaultChildCeiling = vi.fn(() => new Promise<void>(resolve => { resolveSave = resolve; }));
    renderSettings({ onUpdateDefaultChildCeiling });

    const kithButton = screen.getByRole('button', { name: 'Kith' });
    fireEvent.click(kithButton);
    expect(kithButton).toBeDisabled();
    fireEvent.click(kithButton); // no-op while busy
    fireEvent.click(screen.getByRole('button', { name: 'Kin' })); // no-op while busy — another cap button too
    expect(onUpdateDefaultChildCeiling).toHaveBeenCalledTimes(1);

    resolveSave();
    await waitFor(() => expect(kithButton).not.toBeDisabled());
  });

  // N4: `fireEvent.click` wraps each call in its own `act()`, which flushes
  // the `setCeilingBusy(true)` re-render before the next `fireEvent.click`
  // runs — so the test above never actually exercises the race a STATE-only
  // guard loses: two clicks landing in the exact same synchronous tick,
  // before either state update has committed. Dispatching both native
  // clicks inside ONE `act()` callback reproduces that — only the
  // synchronous `ceilingBusyRef` guard (not the `ceilingBusy` state read)
  // can catch it.
  it('a true same-tick double click, before any re-render commits, still fires exactly once', () => {
    let resolveSave: () => void = () => {};
    const onUpdateDefaultChildCeiling = vi.fn(() => new Promise<void>(resolve => { resolveSave = resolve; }));
    renderSettings({ onUpdateDefaultChildCeiling });

    const kithButton = screen.getByRole('button', { name: 'Kith' }) as HTMLButtonElement;
    act(() => {
      kithButton.click();
      kithButton.click();
    });
    expect(onUpdateDefaultChildCeiling).toHaveBeenCalledTimes(1);
    resolveSave();
  });
  it('guards policy double taps and shows a failed save without changing the selected policy', async () => {
    let rejectSave: (error: Error) => void = () => {};
    const onUpdateContactPolicy = vi.fn(() => new Promise<void>((_, reject) => { rejectSave = reject; }));
    renderSettings({ onUpdateContactPolicy });
    const open = screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement;
    act(() => { open.click(); open.click(); });
    expect(onUpdateContactPolicy).toHaveBeenCalledTimes(1);
    expect(open).toBeDisabled();
    rejectSave(new Error('This dependant is no longer managed here.'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('no longer managed here'));
    expect(open).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close circle only' })).toHaveClass('btn-tile-selected');
  });

});
