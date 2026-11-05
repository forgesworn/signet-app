// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BunkerPanel } from './BunkerPanel';
import type { PendingApproval } from '../hooks/useBunkerServer';

afterEach(cleanup);

const pending: PendingApproval = {
  handle: 1, route: { pubkey: 'b'.repeat(64), dependantId: null }, method: 'sign_event',
  client: { appName: 'Game', appUrl: '', existing: true, pubkey: 'c'.repeat(64) },
  description: 'Sign a note', alwaysAvailable: false,
  template: { pubkey: 'b'.repeat(64), kind: 1, created_at: 1, content: '', tags: [] },
} as unknown as PendingApproval;

function panel(over: Partial<ComponentProps<typeof BunkerPanel>> = {}) {
  render(<BunkerPanel onClose={() => {}} bunkerAllowed={false} onGoToSecurity={vi.fn()} stayAwakeUntil={null}
    onArmStayAwake={vi.fn()} onCloseStayAwake={() => {}} wakeLockSupported pendingApprovals={[]}
    onApproveOnce={() => {}} onApproveAlways={() => {}} onDeny={() => {}} dependantNameFor={() => undefined}
    hasDependants={false} serveStatus={{ phase: 'off', routePubkeys: [], relayUrl: 'wss://example.com' } as never}
    locked={false} onRequestUnlockWithPendingArm={() => {}} onRequestUnlockForAlwaysOn={() => {}}
    isNative backgroundServing={false} alwaysOnWanted={false} onSetBackgroundServing={async () => {}} {...over} />);
}

function expectNoServeControls() {
  expect(screen.queryByRole('button', { name: /Turn the Bunker/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Bunker settings/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /min$/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Always on/ })).toBeNull();
}

describe('BunkerPanel on a direct-paired child', () => {
  it.each([
    ['master switch off', { bunkerAllowed: false }],
    ['master switch left on by an older build', { bunkerAllowed: true }],
    ['a stay-awake window still running', { bunkerAllowed: true, stayAwakeUntil: Date.now() + 60_000 }],
    ['always-on still serving', { bunkerAllowed: true, backgroundServing: true, alwaysOnWanted: true }],
    ['locked', { bunkerAllowed: true, locked: true }],
  ])('says what the Bunker does and offers no control with %s', (_name, over) => {
    panel({ childDirect: true, ...over });
    expect(screen.getByText(/passes them to your family Heartwood/)).toBeDefined();
    expect(screen.queryByText('Serve signing requests')).toBeNull();
    expectNoServeControls();
  });

  it('never leads to the empty Bunker settings page, even without a master-switch setter', () => {
    panel({ childDirect: true, onSetBunkerAllowed: undefined });
    expect(screen.queryByRole('button', { name: /Bunker settings/ })).toBeNull();
    expect(screen.queryByText(/Settings → Bunker/)).toBeNull();
  });

  it('keeps the requests waiting on this phone', () => {
    panel({ childDirect: true, pendingApprovals: [pending] });
    expect(screen.getByText('Pending requests')).toBeDefined();
    expect(screen.getByText('Game')).toBeDefined();
  });
});

describe('BunkerPanel on an owner install is unchanged', () => {
  it('offers the master switch and settings when off', () => {
    panel({ bunkerAllowed: false, onSetBunkerAllowed: vi.fn() });
    expect(screen.getByText('Serve signing requests')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Turn the Bunker on' })).toBeDefined();
    expect(screen.getByRole('button', { name: /Bunker settings/ })).toBeDefined();
  });

  it('offers time and always-on controls when allowed', () => {
    panel({ bunkerAllowed: true });
    expect(screen.getAllByRole('button', { name: /min$/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Always on/ })).toBeDefined();
  });
});
