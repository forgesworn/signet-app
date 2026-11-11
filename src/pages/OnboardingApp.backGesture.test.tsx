// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

const cap = vi.hoisted(() => ({
  listeners: [] as Array<{ cb: () => void; removed: boolean }>,
}));

vi.mock('../lib/native', async (orig) => ({ ...(await orig<typeof import('../lib/native')>()), isNativeApp: () => true }));
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((_event: string, cb: () => void) => {
      const entry = { cb, removed: false };
      cap.listeners.push(entry);
      return Promise.resolve({ remove: async () => { entry.removed = true; } });
    }),
  },
}));
vi.mock('../components/QRScanner', () => ({ QRScanner: () => <div data-testid="fake-scanner" /> }));

import { OnboardingApp } from './OnboardingApp';

function pressBack() {
  act(() => { for (const l of cap.listeners) if (!l.removed) l.cb(); });
}
const live = () => cap.listeners.filter(l => !l.removed).length;

function renderApp() {
  render(<OnboardingApp onCreate={vi.fn()} onImport={vi.fn()} onImportLiteMnemonic={vi.fn()} onImportNsec={vi.fn()}
    onConnectHeartwood={vi.fn()} onConnectNip07={vi.fn()} onStartChildPair={vi.fn()} />);
}

describe('OnboardingApp Android back gesture', () => {
  beforeEach(() => { cap.listeners = []; });
  afterEach(() => { cleanup(); });

  it('leaves the welcome screen to the platform default', () => {
    renderApp();
    expect(screen.getByRole('button', { name: 'I already have a Signet' })).toBeTruthy();
    expect(cap.listeners).toHaveLength(0);
  });

  it('steps back from "Connect your remote signer" to the restore choices, then to welcome', async () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'I already have a Signet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect a remote signer' }));
    expect(screen.getByText('Connect your remote signer')).toBeTruthy();

    pressBack();
    expect(screen.queryByText('Connect your remote signer')).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect a remote signer' })).toBeTruthy();

    pressBack();
    expect(screen.getByRole('button', { name: 'I already have a Signet' })).toBeTruthy();
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(live()).toBe(0);
  });

  it('steps back from the remote signer name step to the URI step', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'I already have a Signet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect a remote signer' }));
    fireEvent.change(screen.getByPlaceholderText('bunker://...'), {
      target: { value: 'bunker://' + 'a'.repeat(64) + '?relay=wss://relay.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByPlaceholderText('Name or handle')).toBeTruthy();
    pressBack();
    expect(screen.getByText('Connect your remote signer')).toBeTruthy();
  });
});
