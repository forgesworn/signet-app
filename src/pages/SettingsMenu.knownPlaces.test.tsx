// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SettingsMenu } from './SettingsMenu';
import { Connections } from './Connections';
import type { SignetIdentity, AppPreferences } from '../types';

afterEach(cleanup);

const identity = {
  id: 'a'.repeat(64),
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
  primaryKeypair: 'persona',
} as unknown as SignetIdentity;

function renderMenu(extra: { knownPlaceCount?: number; connectedAppsCount?: number; onOpenKnownPlaces?: () => void }) {
  const onNavigate = vi.fn();
  render(
    <SettingsMenu
      identity={identity}
      preferences={{} as unknown as AppPreferences}
      onSetTheme={() => {}}
      onDeleteIdentity={() => {}}
      onRequestDeleteAuth={async () => false}
      powerMode={false}
      onSetPowerMode={() => {}}
      onNavigate={onNavigate}
      dependantsCount={0}
      {...extra}
    />,
  );
  return onNavigate;
}

describe('SettingsMenu: Where you\'re known and Connected apps rows', () => {
  it('opens the known-places column, with the place count', () => {
    const open = vi.fn();
    const nav = renderMenu({ knownPlaceCount: 4, onOpenKnownPlaces: open });
    const row = screen.getByRole('button', { name: /Where you're known/ });
    expect(row).toHaveTextContent('4');
    fireEvent.click(row);
    expect(open).toHaveBeenCalledTimes(1);
    expect(nav).not.toHaveBeenCalled();
    expect(screen.queryByText(/Connected Sites/i)).toBeNull();
  });

  it('keeps a Connected apps row that opens the page, with the clients-plus-apps count', () => {
    const nav = renderMenu({ connectedAppsCount: 3 });
    const row = screen.getByRole('button', { name: /Connected apps/ });
    expect(row).toHaveTextContent('3');
    fireEvent.click(row);
    expect(nav).toHaveBeenCalledWith('connections');
  });
});

describe('Connections page', () => {
  it('points at the card column and lists only clients and phone apps', () => {
    render(
      <Connections
        connectedClients={[{ clientPubkey: 'c'.repeat(64), appName: 'Some app', lastSeenAt: 1, allowAlways: false } as never]}
        phoneApps={[{ packageName: 'org.x', label: 'X', pubkey: 'b'.repeat(64), allowAlways: true, denyAlways: false, grantedAt: 1 }]}
        onDisconnectClient={() => {}}
        onForgetPhoneApp={() => {}}
        onBack={() => {}}
      />,
    );
    expect(screen.getByText("Sites and apps this identity has signed in to are on the card's Where you're known column.")).toBeInTheDocument();
    expect(screen.getByText('Some app')).toBeInTheDocument();
    expect(screen.getByText('X')).toBeInTheDocument();
  });

  it('says there are no connected apps when both lists are empty', () => {
    render(<Connections onBack={() => {}} />);
    expect(screen.getByText('No connected apps')).toBeInTheDocument();
  });
});
