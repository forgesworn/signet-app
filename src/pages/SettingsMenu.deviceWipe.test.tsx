// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SettingsMenu } from './SettingsMenu';
import type { DeviceWipeInventory } from '../lib/device-wipe';
import type { SignetIdentity, AppPreferences } from '../types';

afterEach(cleanup);

const identity = {
  id: 'a'.repeat(64),
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
  primaryKeypair: 'persona',
} as unknown as SignetIdentity;

const EMPTY: DeviceWipeInventory = { phoneOnly: [], recoverable: [], takedown: { profiles: 0, appGrants: 0 } };

async function openCard(deviceWipe: DeviceWipeInventory) {
  const onDeleteIdentity = vi.fn();
  render(
    <SettingsMenu
      identity={identity}
      preferences={{} as unknown as AppPreferences}
      onSetTheme={() => {}}
      onDeleteIdentity={onDeleteIdentity}
      deviceWipe={deviceWipe}
      onRequestDeleteAuth={async () => true}
      powerMode={true}
      onSetPowerMode={() => {}}
      onNavigate={() => {}}
      dependantsCount={0}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove MySignet from this phone…' }));
  await screen.findByText(/This removes your Signet from this phone/);
  return onDeleteIdentity;
}

const FULL: DeviceWipeInventory = {
  phoneOnly: [{ id: 'recovery-words', label: 'Your recovery words' }],
  recoverable: [{ id: 'heartwood-operator', label: 'Heartwood operator key — import again from Sapwood' }],
  takedown: { profiles: 2, appGrants: 1 },
};

describe('SettingsMenu: remove from this phone', () => {
  it('does not show the card until auth succeeds', async () => {
    render(
      <SettingsMenu
        identity={identity}
        preferences={{} as unknown as AppPreferences}
        onSetTheme={() => {}}
        onDeleteIdentity={() => {}}
        onRequestDeleteAuth={async () => false}
        powerMode={true}
        onSetPowerMode={() => {}}
        onNavigate={() => {}}
        dependantsCount={0}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove MySignet from this phone…' }));
    await waitFor(() => expect(screen.queryByText(/This removes your Signet/)).toBeNull());
  });

  it('keeps the action disabled until "I\'ve saved these" is ticked', async () => {
    const onDelete = await openCard(FULL);
    expect(screen.getByText('Only on this phone — gone unless you\'ve saved them:')).toBeInTheDocument();
    expect(screen.getByText('Your recovery words')).toBeInTheDocument();
    expect(screen.getByText('You can bring these back afterwards:')).toBeInTheDocument();
    const action = screen.getByRole('button', { name: 'Remove from this phone' });
    expect(action).toBeDisabled();
    fireEvent.click(action);
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("I've saved these"));
    expect(action).toBeEnabled();
  });

  it('removes from this phone only by default', async () => {
    const onDelete = await openCard(FULL);
    fireEvent.click(screen.getByLabelText("I've saved these"));
    expect(screen.getByLabelText('Also take it down on Nostr')).not.toBeChecked();
    expect(screen.getByText('2 public profiles will be blanked · 1 connected app loses access')).toBeInTheDocument();
    expect(screen.queryByText(/Some relays may keep a copy/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this phone' }));
    expect(onDelete).toHaveBeenCalledWith({ takeDownOnNostr: false });
  });

  it('flips to "Delete everywhere" when the takedown is ticked', async () => {
    const onDelete = await openCard(FULL);
    fireEvent.click(screen.getByLabelText("I've saved these"));
    fireEvent.click(screen.getByLabelText('Also take it down on Nostr'));
    expect(screen.getByText(/Some relays may keep a copy/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove from this phone' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete everywhere' }));
    expect(onDelete).toHaveBeenCalledWith({ takeDownOnNostr: true });
  });

  it('hides the takedown box when there is nothing to take down, and needs no tick with nothing to save', async () => {
    const onDelete = await openCard(EMPTY);
    expect(screen.queryByLabelText('Also take it down on Nostr')).toBeNull();
    expect(screen.queryByLabelText("I've saved these")).toBeNull();
    expect(screen.queryByText(/bring these back/)).toBeNull();
    const action = screen.getByRole('button', { name: 'Remove from this phone' });
    expect(action).toBeEnabled();
    fireEvent.click(action);
    expect(onDelete).toHaveBeenCalledWith({ takeDownOnNostr: false });
  });

  it('says only the non-zero parts of the takedown', async () => {
    await openCard({ ...EMPTY, takedown: { profiles: 1, appGrants: 0 } });
    expect(screen.getByText('1 public profile will be blanked')).toBeInTheDocument();
  });

  it('Cancel closes the card and resets both ticks', async () => {
    await openCard(FULL);
    fireEvent.click(screen.getByLabelText("I've saved these"));
    fireEvent.click(screen.getByLabelText('Also take it down on Nostr'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/This removes your Signet/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove MySignet from this phone…' }));
    await screen.findByText(/This removes your Signet from this phone/);
    expect(screen.getByLabelText("I've saved these")).not.toBeChecked();
    expect(screen.getByLabelText('Also take it down on Nostr')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Remove from this phone' })).toBeDisabled();
  });
});
