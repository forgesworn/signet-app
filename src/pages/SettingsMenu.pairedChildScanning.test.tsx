// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { SettingsMenu } from './SettingsMenu';
import { SigningSettings } from './SigningSettings';
import type { SignetIdentity, AppPreferences } from '../types';

const identity = {
  id: 'a'.repeat(64),
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
  persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Sky' },
  primaryKeypair: 'persona',
} as unknown as SignetIdentity;

function renderMenu(signingMode: string | undefined) {
  const onNavigate = vi.fn();
  render(
    <SettingsMenu
      identity={identity}
      preferences={{ signingMode } as unknown as AppPreferences}
      onSetTheme={() => {}}
      onDeleteIdentity={() => {}}
      onRequestDeleteAuth={async () => false}
      powerMode={false}
      onSetPowerMode={() => {}}
      onNavigate={onNavigate}
      dependantsCount={0}
    />,
  );
  return onNavigate;
}

describe('camera settings on a paired-child install', () => {
  afterEach(cleanup);

  it('the menu leads a paired child to the camera page, named for what it holds', () => {
    const nav = renderMenu('paired-child');
    expect(screen.queryByText(/Bunker/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Scanning/ }));
    expect(nav).toHaveBeenCalledWith('settings-signing');
  });

  it('other installs still see Bunker & Scanning', () => {
    const nav = renderMenu(undefined);
    fireEvent.click(screen.getByRole('button', { name: /^Bunker & Scanning/ }));
    expect(nav).toHaveBeenCalledWith('settings-signing');
  });

  it('the page keeps the camera card and drops the Bunker master switch when showBunker is false', () => {
    render(<SigningSettings showBunker={false} bunkerServerEnabled={false} onSetBunkerServerEnabled={vi.fn()} />);
    expect(screen.getByText('Start the camera when I swipe to Scan')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn the Bunker on' })).toBeNull();
  });

  it('the page shows the Bunker switch by default', () => {
    render(<SigningSettings bunkerServerEnabled={false} onSetBunkerServerEnabled={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Turn the Bunker on' })).toBeTruthy();
  });
});
