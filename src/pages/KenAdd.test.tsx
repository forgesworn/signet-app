// @vitest-environment jsdom
//
// kenspeckle 0.2.0 maintainer finding: pinKen now throws
// "ken: pubkeyHex must not equal ownerPubkeyHex" when the target key is the
// owner's own — and KenAdd called it outside any try/catch, so the UI
// silently did nothing. This file pins the fix: an up-front check (never
// even calling pinKen) plus a try/catch that maps any remaining throw to
// calm, human copy, on both the hex-paste and QR-confirm paths.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('@forgesworn/kenspeckle/ken', () => ({
  pinKen: vi.fn(),
  pinKenFromNip05: vi.fn(),
  buildKeyControlChallenge: vi.fn(() => ({ nonce: 'n'.repeat(64), createdAt: 0 })),
  verifyKeyControl: vi.fn(),
}));

vi.mock('../hooks/useCamera', () => ({
  useCamera: () => ({ hasPermission: true, error: null, requestPermission: vi.fn() }),
}));

const OWNER_HEX = 'a'.repeat(64);
const OTHER_HEX = 'b'.repeat(64);

vi.mock('../components/QRScanner', () => ({
  QRScanner: ({ onScan }: { onScan: (data: string) => void }) => (
    <div>
      <button onClick={() => onScan(OWNER_HEX)}>Simulate own-key scan</button>
      <button onClick={() => onScan(OTHER_HEX)}>Simulate other-key scan</button>
    </div>
  ),
}));

vi.mock('../hooks/useContactAvatar', () => ({
  useContactAvatar: () => undefined,
}));

vi.mock('../components/ContactAvatar', () => ({
  ContactAvatar: () => <div />,
}));

vi.mock('../lib/contact-qr', () => ({
  parseContactQR: vi.fn(() => null),
  resolveScannedContactName: vi.fn(async () => undefined),
}));

import { pinKen, pinKenFromNip05 } from '@forgesworn/kenspeckle/ken';
import { KenAdd } from './KenAdd';

const mockPinKen = vi.mocked(pinKen);
const mockPinKenFromNip05 = vi.mocked(pinKenFromNip05);

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderPage(onAddKen = vi.fn()) {
  return render(
    <KenAdd
      ownerPubkeyHex={OWNER_HEX}
      onAddKen={onAddKen}
      onDone={() => {}}
      onBack={() => {}}
      relayUrl="wss://relay.example.com"
      encryptionKey={null}
      onSaveContactAvatar={vi.fn()}
    />,
  );
}

const OWN_KEY_MESSAGE = "That's your own key — you can't add yourself as a ken.";

describe('KenAdd — adding your own key', () => {
  it('hex-paste path: shows a human message and never calls pinKen', () => {
    renderPage();
    fireEvent.click(screen.getByText('Paste an npub'));
    fireEvent.change(screen.getByPlaceholderText('npub1…'), { target: { value: OWNER_HEX } });
    fireEvent.click(screen.getByText('Pin key'));

    expect(screen.getByText(OWN_KEY_MESSAGE)).toBeDefined();
    expect(mockPinKen).not.toHaveBeenCalled();
  });

  it('QR-confirm path: shows the same human message after scanning the owner\'s own key', async () => {
    renderPage();
    fireEvent.click(screen.getByText('Scan a QR code'));
    await act(async () => {
      fireEvent.click(screen.getByText('Simulate own-key scan'));
    });
    fireEvent.click(screen.getByText('Pin key'));

    expect(screen.getByText(OWN_KEY_MESSAGE)).toBeDefined();
    expect(mockPinKen).not.toHaveBeenCalled();
  });

  it('a pinKen throw for a key that is NOT the owner\'s own is still caught and humanised (defence in depth)', () => {
    mockPinKen.mockImplementation(() => {
      throw new Error('ken: pubkeyHex must not equal ownerPubkeyHex');
    });
    renderPage();
    fireEvent.click(screen.getByText('Paste an npub'));
    fireEvent.change(screen.getByPlaceholderText('npub1…'), { target: { value: OTHER_HEX } });
    fireEvent.click(screen.getByText('Pin key'));

    expect(mockPinKen).toHaveBeenCalledTimes(1);
    expect(screen.getByText(OWN_KEY_MESSAGE)).toBeDefined();
    // The library's raw message text is never shown verbatim as the only
    // error node — it's mapped, not passed through.
    expect(screen.queryByText('ken: pubkeyHex must not equal ownerPubkeyHex')).toBeNull();
  });

  it('an unrelated pinKen throw is mapped to a generic human message, not the raw library text', () => {
    mockPinKen.mockImplementation(() => {
      throw new Error('ken: at most 64 corroborations');
    });
    renderPage();
    fireEvent.click(screen.getByText('Paste an npub'));
    fireEvent.change(screen.getByPlaceholderText('npub1…'), { target: { value: OTHER_HEX } });
    fireEvent.click(screen.getByText('Pin key'));

    expect(screen.getByText('Could not add that key. Check the details and try again.')).toBeDefined();
    expect(screen.queryByText('ken: at most 64 corroborations')).toBeNull();
  });

  it('nip05 path: a pinKenFromNip05 throw is humanised, not shown as the raw library message', async () => {
    mockPinKenFromNip05.mockRejectedValue(new Error('ken: nip05 lookup failed (HTTP 404)'));
    renderPage();
    fireEvent.click(screen.getByText('NIP-05 address (name@domain.com)'));
    fireEvent.change(screen.getByPlaceholderText('name@domain.com'), { target: { value: 'someone@example.com' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Resolve & pin'));
    });

    expect(screen.getByText('Could not reach that address right now. Check it is correct and try again.')).toBeDefined();
    expect(screen.queryByText('ken: nip05 lookup failed (HTTP 404)')).toBeNull();
  });
});
