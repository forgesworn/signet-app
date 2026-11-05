// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SettingsMenu } from './SettingsMenu';
import type { SignetIdentity, AppPreferences } from '../types';

const identity = {
  id: 'a'.repeat(64),
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
  persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Sky' },
  primaryKeypair: 'persona',
} as unknown as SignetIdentity;

function renderMenu(showChildPermissions: boolean) {
  const onNavigate = vi.fn();
  render(
    <SettingsMenu
      identity={identity}
      preferences={{ signingMode: 'paired-child' } as unknown as AppPreferences}
      onSetTheme={() => {}}
      onDeleteIdentity={() => {}}
      onRequestDeleteAuth={async () => false}
      powerMode={false}
      onSetPowerMode={() => {}}
      onNavigate={onNavigate}
      showChildPermissions={showChildPermissions}
      dependantsCount={0}
    />,
  );
  return onNavigate;
}

describe('SettingsMenu — child permissions entry', () => {
  it('links a direct-paired child to the read-only Permissions page', () => {
    const nav = renderMenu(true);
    fireEvent.click(screen.getByRole('button', { name: 'See permissions' }));
    expect(nav).toHaveBeenCalledWith('child-permissions');
  });
  it('is hidden otherwise', () => {
    renderMenu(false);
    expect(screen.queryByRole('button', { name: 'See permissions' })).toBeNull();
  });
});
