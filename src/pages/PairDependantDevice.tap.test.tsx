// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

vi.mock('../components/QRCode', () => ({ QRCode: ({ data }: { data: string }) => <div data-testid="qr" data-uri={data} /> }));

// The pairing ceremony is tested in useChildDevicePairing.tap.test.ts; the page is driven by the hook's state.
const hook = vi.hoisted(() => {
  const nearby = (over: Record<string, unknown> = {}) => ({
    phase: 'idle', available: null, reason: undefined, secondPhone: false, wrongScreen: null,
    tap: {}, probe: vi.fn(async (): Promise<Record<string, unknown>> => ({ phase: 'idle', available: true, secondPhone: false, wrongScreen: null })), begin: vi.fn(), end: vi.fn(), ...over,
  });
  const make = (state: unknown, nearbyOver: Record<string, unknown> = {}) => ({
    state, start: vi.fn(), cancel: vi.fn(), confirmMatch: vi.fn(async () => {}), rejectMatch: vi.fn(), unpair: vi.fn(async () => {}),
    nearby: nearby(nearbyOver),
  });
  return { make, current: make({ phase: 'idle' }) as ReturnType<typeof make> };
});
vi.mock('../hooks/useChildDevicePairing', () => ({ useChildDevicePairing: () => hook.current }));
const radio = vi.hoisted(() => ({ radioSettings: vi.fn(async () => {}), native: false }));
vi.mock('../lib/native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/native')>();
  return { ...actual, isNativeApp: () => radio.native, SignetNative: { ...actual.SignetNative, radioSettings: radio.radioSettings } };
});

import { buildPersonaFirstDependant } from '../lib/dependant-record';
import { CHILD_DEVICE_COPY as COPY, PAIR_WITH_GUARDIAN_LABEL } from '../lib/child-device-copy';
import type { DependantIdentity } from '../types';
import type { HeartwoodMgmtClient } from '../lib/heartwood-mgmt';
import { PairDependantDevice } from './PairDependantDevice';

function makeDep(): DependantIdentity {
  return buildPersonaFirstDependant({
    guardianPubkey: 'f'.repeat(64), enteredName: 'Lily', derivationPath: 'dependant-0',
    naturalPerson: { publicKey: getPublicKey(generateSecretKey()), privateKey: '' },
    persona: { publicKey: getPublicKey(generateSecretKey()), privateKey: '' }, createdAt: 1,
  });
}
const RADIOS = (over: Record<string, unknown>) => ({ phase: 'idle', available: null, secondPhone: false, wrongScreen: null, ...over });
const future = () => Date.now() + 600_000;

function renderPage() {
  const onBack = vi.fn();
  const r = render(<PairDependantDevice dependant={makeDep()} relayUrl="wss://rail.example.com" bunkerServerEnabled={false}
    ensureDependantBunkerEndpoint={vi.fn()} clearDependantBunkerEndpoint={vi.fn()} saveDependantPairingSecret={vi.fn()}
    requestAuth={vi.fn(async () => 'k'.repeat(64))} onBack={onBack} signingMode="bunker"
    direct={{ operator: { isOpen: true } as unknown as HeartwoodMgmtClient, operatorStatus: null, guardianNpPubkey: 'f'.repeat(64),
      railRelay: 'wss://rail.example.com', hwRelays: ['wss://hw.example.com'], encryptionKey: 'k'.repeat(64), grants: [], onDependantUpdated: vi.fn() }} />);
  return { ...r, onBack };
}
const settle = () => waitFor(() => expect(screen.queryByText(COPY.checking)).toBeNull());
const setRadios = (probed: Record<string, unknown>) => {
  hook.current = hook.make({ phase: 'idle' });
  hook.current.nearby.probe.mockResolvedValue(RADIOS(probed));
};

beforeEach(() => { hook.current = hook.make({ phase: 'idle' }); radio.radioSettings.mockClear(); radio.native = false; });

describe('PairDependantDevice — tap first', () => {
  it('shows Checking while the radios are probed, then starts the tap when they are available', async () => {
    setRadios({ available: true });
    renderPage();
    expect(screen.getByText(COPY.checking)).toBeTruthy();
    await waitFor(() => expect(hook.current.start).toHaveBeenCalledWith('tap'));
    expect(hook.current.start).not.toHaveBeenCalledWith('qr');
  });

  it('leads with "Hold <name>\'s phone against this one" and a button to show the QR instead', async () => {
    hook.current = hook.make({ phase: 'offer', uri: 'signet-child:x', expiresAt: future(), via: 'tap' }, { phase: 'waiting', available: true });
    renderPage();
    await settle();
    expect(screen.getByRole('heading', { name: "Hold Lily's phone against this one" })).toBeTruthy();
    expect(screen.queryByTestId('qr')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: COPY.tap.qrInstead }));
    expect(hook.current.start).toHaveBeenCalledWith('qr');
  });

  it('with the pairing in QR mode today\'s QR screen is unchanged', async () => {
    hook.current = hook.make({ phase: 'offer', uri: 'signet-child:x', expiresAt: future(), via: 'qr' });
    renderPage();
    await settle();
    expect(screen.getByTestId('qr').getAttribute('data-uri')).toBe('signet-child:x');
    expect(screen.getByText(COPY.offerIntro('Lily'))).toBeTruthy();
    expect(screen.getByText(COPY.offerIntro('Lily')).textContent).toContain(PAIR_WITH_GUARDIAN_LABEL);
    expect(screen.queryByRole('button', { name: COPY.tap.qrInstead })).toBeNull();
  });

  it('NFC off: one line, an Open NFC settings button, and the QR one tap away', async () => {
    setRadios({ available: false, reason: 'off' });
    renderPage();
    await screen.findByText(COPY.tap.nfcOff);
    expect(hook.current.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: COPY.tap.openNfc }));
    expect(radio.radioSettings).toHaveBeenCalledWith({ which: 'nfc' });
    fireEvent.click(screen.getByRole('button', { name: COPY.tap.qrInstead }));
    expect(hook.current.start).toHaveBeenCalledWith('qr');
  });

  it('NFC off, then turned on: Check again starts the tap', async () => {
    setRadios({ available: false, reason: 'off' });
    renderPage();
    await screen.findByText(COPY.tap.nfcOff);
    hook.current.nearby.probe.mockResolvedValue(RADIOS({ available: true }));
    fireEvent.click(screen.getByRole('button', { name: COPY.tap.checkAgain }));
    await waitFor(() => expect(hook.current.start).toHaveBeenCalledWith('tap'));
  });

  it('radios unsupported or refused: straight to the QR flow, no tap screen', async () => {
    radio.native = true;
    setRadios({ available: false, reason: 'denied' });
    renderPage();
    await waitFor(() => expect(hook.current.start).toHaveBeenCalledWith('qr'));
    expect(screen.queryByText(COPY.tap.nfcOff)).toBeNull();
  });

  it('a QR shown because Bluetooth was refused says why, on a phone', async () => {
    radio.native = true;
    hook.current = hook.make({ phase: 'offer', uri: 'signet-child:x', expiresAt: future(), via: 'qr' }, { available: false, reason: 'denied' });
    renderPage();
    await settle();
    expect(screen.getByText(COPY.tap.qrBecause.denied)).toBeTruthy();
    expect(screen.getByTestId('qr')).toBeTruthy();
  });

  it('via tap: the confirm asks about the phone just tapped, with Pair and Cancel, and no words', async () => {
    hook.current = hook.make({ phase: 'confirm', words: ['apple', 'banana', 'cherry', 'damson'], clientPubkey: 'a'.repeat(64), expiresAt: future(), via: 'tap' });
    renderPage();
    await settle();
    expect(screen.getByRole('heading', { name: "Pair Lily's phone — the phone you just tapped?" })).toBeTruthy();
    expect(screen.queryByTestId('pair-check-words')).toBeNull();
    expect(screen.queryByText('apple')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(hook.current.confirmMatch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: COPY.cancel }));
    expect(hook.current.rejectMatch).toHaveBeenCalled();
  });

  it('via qr: the confirm still shows the four words exactly', async () => {
    hook.current = hook.make({ phase: 'confirm', words: ['apple', 'banana', 'cherry', 'damson'], clientPubkey: 'a'.repeat(64), expiresAt: future(), via: 'qr' });
    renderPage();
    await settle();
    expect(screen.getByTestId('pair-check-words').textContent).toBe('applebananacherrydamson');
    expect(screen.getByText(COPY.confirmMatch)).toBeTruthy();
    expect(screen.getByText(COPY.confirmNoMatch)).toBeTruthy();
  });

  it('a second phone touching is explained', async () => {
    hook.current = hook.make({ phase: 'offer', uri: 'signet-child:x', expiresAt: future(), via: 'tap' }, { phase: 'linking', secondPhone: true });
    renderPage();
    await settle();
    expect(screen.getByText("Another phone touched this one. Only Lily's phone can pair — start again if that was the wrong phone.")).toBeTruthy();
  });

  it('a phone on the Handshake screen is explained, naming the button to choose', async () => {
    hook.current = hook.make({ phase: 'offer', uri: 'signet-child:x', expiresAt: future(), via: 'tap' }, { phase: 'waiting', wrongScreen: 'handshake' });
    renderPage();
    await settle();
    expect(screen.getByText("That phone is on the Handshake screen. On Lily's phone choose “Pair with my guardian's phone”.")).toBeTruthy();
  });
});
