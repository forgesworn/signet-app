// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { SettingsMenu } from './SettingsMenu';
import type { SignetIdentity, AppPreferences } from '../types';

const identity = {
  id: 'a'.repeat(64),
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
  persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Sky' },
  primaryKeypair: 'persona',
} as unknown as SignetIdentity;

function renderMenu(powerMode: boolean, signingMode?: string) {
  const onNavigate = vi.fn();
  render(
    <SettingsMenu
      identity={identity}
      preferences={{ signingMode } as unknown as AppPreferences}
      onSetTheme={() => {}}
      onDeleteIdentity={() => {}}
      onRequestDeleteAuth={async () => false}
      powerMode={powerMode}
      onSetPowerMode={() => {}}
      onNavigate={onNavigate}
      dependantsCount={0}
    />,
  );
  return onNavigate;
}

describe('the way to Handshake calibration', () => {
  afterEach(cleanup);

  it('Power Mode says it is behind that switch, even while off', () => {
    renderMenu(false);
    expect(screen.getByText(/Show advanced features: .*Handshake calibration/)).toBeDefined();
  });

  it('the Advanced row names it and goes to the page that holds it', () => {
    const nav = renderMenu(true);
    fireEvent.click(screen.getByRole('button', { name: /^Advanced.*Handshake calibration/ }));
    expect(nav).toHaveBeenCalledWith('settings-advanced');
  });

  it('a paired child is not sent looking for it, because Advanced does not hold it there', () => {
    renderMenu(true, 'paired-child');
    expect(screen.getByText(/Show advanced features/)).toBeDefined();
    expect(screen.queryByText(/Handshake calibration/)).toBeNull();
  });
});
