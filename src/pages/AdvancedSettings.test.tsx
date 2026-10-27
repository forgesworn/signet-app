// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RelayState } from 'signet-protocol';
import type { SignetIdentity } from '../types';
import { AdvancedSettings } from './AdvancedSettings';
import { usePreferences } from '../hooks/usePreferences';
import * as db from '../lib/db';

const observed = vi.hoisted(() => ({ connections: {} as Record<string, RelayState> }));
vi.mock('../lib/relay-service', async original => ({
  ...await original<typeof import('../lib/relay-service')>(),
  getRelayConnectionStates: () => ({ ...observed.connections }),
}));
vi.mock('../lib/relay-health', () => ({ checkRelayHealth: vi.fn(async () => ({
  status: 'reachable', latencyMs: 12, checkedAt: Date.now(), detail: 'Read check completed.',
})) }));

const first = 'wss://first.example', second = 'wss://second.example', read = 'wss://read.example';
function Settings() {
  const { preferences, loading, setRelays } = usePreferences();
  if (loading) return <p>Loading settings</p>;
  return <AdvancedSettings identity={{ backedUp: true } as SignetIdentity} preferences={preferences}
    relays={preferences.relays ?? []} onSetRelays={setRelays} onNavigateBridge={() => {}}
    onSetDefaultBlossomUrl={async () => {}} onSetBlossomConsent={async () => {}} />;
}

beforeEach(async () => {
  observed.connections = { [first]: 'connected' };
  await db.purgeAllUserData();
  await db.savePreferences({ id: 'current', theme: 'dark', relays: [
    { url: first, enabled: true, read: true, write: true },
    { url: second, enabled: true, read: true, write: true },
    { url: read, enabled: true, read: true, write: false },
  ] });
});
afterEach(cleanup);

describe('relay settings', () => {
  it('separates live connection state from a successful reachability snapshot', async () => {
    render(<Settings />);
    const firstRow = await screen.findByRole('group', { name: `Relay ${first}` });
    const secondRow = screen.getByRole('group', { name: `Relay ${second}` });
    expect(within(firstRow).getByText('App connection: Connected')).toBeDefined();
    expect(within(secondRow).getByText('App connection: Not in use')).toBeDefined();
    await within(secondRow).findByText(/Reachability:.*Reachable/);
    observed.connections = { [first]: 'disconnected', [second]: 'connecting' };
    await waitFor(() => {
      expect(within(firstRow).getByText('App connection: Disconnected')).toBeDefined();
      expect(within(secondRow).getByText('App connection: Connecting…')).toBeDefined();
    }, { timeout: 3000 });
    // A successful earlier check remains a snapshot, never a live socket claim.
    expect(within(secondRow).getByText(/Reachability:.*Reachable/)).toBeDefined();
  });

  it('persists reordering and the preferred write relay without changing access modes', async () => {
    const view = render(<Settings />);
    fireEvent.click(await screen.findByRole('button', { name: `Move ${read} up` }));
    fireEvent.click(screen.getByRole('button', { name: `Move ${read} up` }));
    await waitFor(async () => expect((await db.getPreferences()).relays?.map(r => r.url)).toEqual([read, first, second]));
    expect(within(screen.getByRole('group', { name: `Relay ${read}` })).getByLabelText('Read-only')).toHaveProperty('checked', true);
    expect(within(screen.getByRole('group', { name: `Relay ${first}` })).getByText('PREFERRED PRIMARY')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: `Move ${second} up` }));
    await waitFor(async () => expect((await db.getPreferences()).relayUrl).toBe(second));
    view.unmount();
    render(<Settings />);
    const readUp = await screen.findByRole('button', { name: `Move ${read} up` });
    expect(readUp).toHaveProperty('disabled', true);
    expect(screen.getAllByRole('group', { name: /^Relay / }).map(row => row.getAttribute('aria-label'))).toEqual([
      `Relay ${read}`, `Relay ${second}`, `Relay ${first}`,
    ]);
    expect(within(screen.getByRole('group', { name: `Relay ${second}` })).getByText('PREFERRED PRIMARY')).toBeDefined();
  });
});

describe('Show My Keep switch', () => {
  function Switch({ withSetter = true }: { withSetter?: boolean }) {
    const { preferences, loading, setRelays, setShowMyKeep } = usePreferences();
    if (loading) return <p>Loading settings</p>;
    return <AdvancedSettings identity={{ backedUp: true } as SignetIdentity} preferences={preferences}
      relays={preferences.relays ?? []} onSetRelays={setRelays} onNavigateBridge={() => {}}
      onSetDefaultBlossomUrl={async () => {}} onSetBlossomConsent={async () => {}}
      onSetShowMyKeep={withSetter ? (show => { void setShowMyKeep(show); }) : undefined} />;
  }

  it('starts off, and turning it on persists the preference that shows the Settings row', async () => {
    render(<Switch />);
    const toggle = await screen.findByRole('switch', { name: 'Show My Keep' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Show My Keep' }).getAttribute('aria-checked')).toBe('true'));
    await waitFor(async () => expect((await db.getPreferences()).showMyKeep).toBe(true));
    fireEvent.click(screen.getByRole('switch', { name: 'Show My Keep' }));
    await waitFor(async () => expect((await db.getPreferences()).showMyKeep).toBe(false));
  });

  it('is not offered where My Keep is not (no setter)', async () => {
    render(<Switch withSetter={false} />);
    await screen.findByText(/Image hosting/);
    expect(screen.queryByRole('switch', { name: 'Show My Keep' })).toBeNull();
  });
});

