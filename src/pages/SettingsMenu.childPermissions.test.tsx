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

describe('SettingsMenu — Handshake Jigsaw edge distance', () => {
  const menu = (mm: number | undefined, onSet?: (mm: number | undefined) => void) => render(
    <SettingsMenu identity={identity} preferences={{ handshakeSeamGapMm: mm } as unknown as AppPreferences} onSetTheme={() => {}}
      onDeleteIdentity={() => {}} onRequestDeleteAuth={async () => false} powerMode={false} onSetPowerMode={() => {}}
      onNavigate={() => {}} dependantsCount={0} onSetHandshakeSeamGapMm={onSet} />);
  it('shows the default as the placeholder and the hint', () => {
    menu(undefined, vi.fn());
    const input = screen.getByLabelText('Jigsaw edge distance') as HTMLInputElement;
    expect(input.placeholder).toBe('12.7'); expect(input.value).toBe('');
    expect([input.min, input.max, input.step]).toEqual(['0', '30', '0.5']);
    expect(screen.getByText(/From the top of the Jigsaw lines to the top edge of your phone/)).toBeInTheDocument();
  });
  it('saves a valid distance, ignores an invalid or out-of-range one, and Use default clears it', () => {
    const onSet = vi.fn();
    menu(12, onSet);
    const input = screen.getByLabelText('Jigsaw edge distance') as HTMLInputElement;
    expect(input.value).toBe('12');
    fireEvent.change(input, { target: { value: '15.5' } });
    expect(onSet).toHaveBeenLastCalledWith(15.5);
    onSet.mockClear();
    for (const bad of ['31', '-2', '']) fireEvent.change(input, { target: { value: bad } });
    expect(onSet).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '0' } });
    expect(onSet).toHaveBeenLastCalledWith(0);
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }));
    expect(onSet).toHaveBeenLastCalledWith(undefined);
    expect(input.value).toBe('');
  });
  it('is not offered when the page gives no setter (paired child)', () => {
    menu(undefined);
    expect(screen.queryByLabelText('Jigsaw edge distance')).toBeNull();
  });
});
