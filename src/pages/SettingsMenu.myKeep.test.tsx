// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SettingsMenu } from './SettingsMenu';
import type { SignetIdentity, AppPreferences } from '../types';

afterEach(cleanup);

const identity = {
  id: 'a'.repeat(64),
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
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

describe('SettingsMenu: My Keep row', () => {
  it('opens the My Keep page', () => {
    const nav = renderMenu(undefined);
    fireEvent.click(screen.getByRole('button', { name: /My Keep/ }));
    expect(nav).toHaveBeenCalledWith('my-keep');
  });
  it('is hidden on a paired child install', () => {
    renderMenu('paired-child');
    expect(screen.queryByRole('button', { name: /My Keep/ })).toBeNull();
  });
});
