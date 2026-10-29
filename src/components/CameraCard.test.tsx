// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedIdentity } from '../lib/carousel-utils';

// Capture the props the card hands the scanner so tests can drive a scan.
let scannerProps: { active: boolean; onScan: (d: string) => void; fill?: boolean } | null = null;
vi.mock('./QRScanner', () => ({
  QRScanner: (props: { active: boolean; onScan: (d: string) => void; fill?: boolean }) => {
    scannerProps = props;
    return <div data-testid="qr-scanner" data-active={String(props.active)} />;
  },
}));
vi.mock('./MiniIdBadge', () => ({ MiniIdBadge: () => null }));

import { CameraCard, CAMERA_AUTOSTART_DELAY_MS } from './CameraCard';

const resolved = { displayName: 'Sam', displayNameIsSet: true, publicKey: 'a'.repeat(64), type: 'Persona', isDependant: false } as ResolvedIdentity;

beforeEach(() => {
  scannerProps = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function submit(value: string) {
  fireEvent.click(document.querySelector('.viewfinder')!);
  fireEvent.click(screen.getByText('Paste a link'));
  fireEvent.change(screen.getByTestId('camera-card-paste-input'), { target: { value } });
  fireEvent.click(screen.getByText('Submit'));
}

describe('CameraCard scan errors', () => {
  it('shows an error the scan handler returns, and clears it on the next scan', async () => {
    const onQRScanned = vi.fn().mockResolvedValueOnce('That is one of your own keys.').mockReturnValueOnce(undefined);
    render(<CameraCard resolved={resolved} onQRScanned={onQRScanned} />);
    await submit('npub1x');
    expect(await screen.findByRole('alert')).toHaveTextContent('That is one of your own keys.');
    await submit('npub1y');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(onQRScanned).toHaveBeenCalledTimes(2);
  });

  it('offers Scan again next to the error, and tapping it restarts the camera', async () => {
    render(<CameraCard resolved={resolved} onQRScanned={() => 'Not a Signet code.'} />);
    await submit('junk');
    expect(await screen.findByRole('alert')).toHaveTextContent('Not a Signet code.');
    fireEvent.click(screen.getByRole('button', { name: 'Scan again' }));
    expect(screen.getByTestId('qr-scanner')).toHaveAttribute('data-active', 'true');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows nothing when the handler returns nothing', async () => {
    render(<CameraCard resolved={resolved} onQRScanned={() => undefined} />);
    await submit('npub1x');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('CameraCard auto-start', () => {
  it('does not start the camera when rendered not live, however long it sits there', () => {
    vi.useFakeTimers();
    render(<CameraCard resolved={resolved} onQRScanned={vi.fn()} live={false} />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.queryByTestId('qr-scanner')).toBeNull();
    expect(screen.getByText('Scan QR Code')).toBeInTheDocument();
  });

  it('starts the camera after the debounce once live, and fills the card', () => {
    vi.useFakeTimers();
    render(<CameraCard resolved={resolved} onQRScanned={vi.fn()} live />);
    expect(screen.queryByTestId('qr-scanner')).toBeNull();
    act(() => { vi.advanceTimersByTime(CAMERA_AUTOSTART_DELAY_MS - 1); });
    expect(screen.queryByTestId('qr-scanner')).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByTestId('qr-scanner')).toHaveAttribute('data-active', 'true');
    expect(scannerProps?.fill).toBe(true);
  });

  it('never starts if the card stops being live inside the debounce', () => {
    vi.useFakeTimers();
    const { rerender } = render(<CameraCard resolved={resolved} onQRScanned={vi.fn()} live />);
    act(() => { vi.advanceTimersByTime(CAMERA_AUTOSTART_DELAY_MS - 50); });
    rerender(<CameraCard resolved={resolved} onQRScanned={vi.fn()} live={false} />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByTestId('qr-scanner')).toBeNull();
  });

  it('stops the camera at once when the card stops being live', () => {
    vi.useFakeTimers();
    const { rerender } = render(<CameraCard resolved={resolved} onQRScanned={vi.fn()} live />);
    act(() => { vi.advanceTimersByTime(CAMERA_AUTOSTART_DELAY_MS); });
    expect(screen.getByTestId('qr-scanner')).toBeInTheDocument();
    rerender(<CameraCard resolved={resolved} onQRScanned={vi.fn()} live={false} />);
    expect(screen.queryByTestId('qr-scanner')).toBeNull();
  });

  it('does not restart after a successful scan until Scan again, and re-arms after leaving and returning', () => {
    vi.useFakeTimers();
    const onQRScanned = vi.fn();
    const { rerender } = render(<CameraCard resolved={resolved} onQRScanned={onQRScanned} live />);
    act(() => { vi.advanceTimersByTime(CAMERA_AUTOSTART_DELAY_MS); });
    act(() => { scannerProps!.onScan('signet-code'); });
    expect(onQRScanned).toHaveBeenCalledWith('signet-code');
    expect(screen.queryByTestId('qr-scanner')).toBeNull();

    // Still live: no auto-restart.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.queryByTestId('qr-scanner')).toBeNull();

    // Tap restarts.
    fireEvent.click(screen.getByRole('button', { name: 'Scan again' }));
    expect(screen.getByTestId('qr-scanner')).toBeInTheDocument();

    // Scan again, then swipe away and back: auto-start is re-armed.
    act(() => { scannerProps!.onScan('another'); });
    expect(screen.queryByTestId('qr-scanner')).toBeNull();
    rerender(<CameraCard resolved={resolved} onQRScanned={onQRScanned} live={false} />);
    rerender(<CameraCard resolved={resolved} onQRScanned={onQRScanned} live />);
    act(() => { vi.advanceTimersByTime(CAMERA_AUTOSTART_DELAY_MS); });
    expect(screen.getByTestId('qr-scanner')).toBeInTheDocument();
  });

  it('keeps the paste box as an overlay, with Submit and Cancel', () => {
    vi.useFakeTimers();
    const onQRScanned = vi.fn();
    render(<CameraCard resolved={resolved} onQRScanned={onQRScanned} live />);
    act(() => { vi.advanceTimersByTime(CAMERA_AUTOSTART_DELAY_MS); });
    expect(screen.queryByTestId('camera-card-paste-input')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Paste a link' }));
    const input = screen.getByLabelText('Paste QR link');
    expect(input).toBe(screen.getByTestId('camera-card-paste-input'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByTestId('camera-card-paste-input')).toBeNull();
    expect(screen.getByTestId('qr-scanner')).toBeInTheDocument();
  });
});
