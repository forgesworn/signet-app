// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const decode = vi.fn();
const destroy = vi.fn();
const isNativeApp = vi.fn(() => false);
const requestCameraPermission = vi.fn();

vi.mock('../lib/qr-decoder-client', () => ({
  createQrDecoderClient: () => ({ decode, destroy }),
}));
vi.mock('../lib/native', () => ({
  isNativeApp: () => isNativeApp(),
  SignetNative: { requestCameraPermission: () => requestCameraPermission() },
}));

import { QRScanner, QR_SCAN_MIN_GAP_MS, QR_SCANNER_IDLE_MS } from './QRScanner';

function mockStream() {
  const stop = vi.fn();
  const track = { stop, applyConstraints: vi.fn().mockResolvedValue(undefined), getCapabilities: () => ({}) };
  return { stream: { getTracks: () => [track], getVideoTracks: () => [track] }, stop };
}

const nothing = { results: [], decoder: 'zxing' as const };
const flush = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

let getUserMedia: ReturnType<typeof vi.fn>;
let tracks: ReturnType<typeof mockStream>[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  decode.mockReset().mockResolvedValue(nothing);
  destroy.mockReset();
  isNativeApp.mockReset().mockReturnValue(false);
  requestCameraPermission.mockReset().mockResolvedValue(undefined);
  tracks = [];
  getUserMedia = vi.fn(async () => {
    const t = mockStream();
    tracks.push(t);
    return t.stream;
  });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, writable: true, value: { getUserMedia } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1280);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(720);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    drawImage: vi.fn(),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  }) as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('QRScanner scan loop', () => {
  it('submits one decode at a time and waits the minimum gap after each result', async () => {
    let resolveFirst!: (v: typeof nothing) => void;
    decode.mockReturnValueOnce(new Promise(r => { resolveFirst = r; }));
    render(<QRScanner onScan={vi.fn()} active />);
    await flush(0);
    expect(decode).toHaveBeenCalledTimes(1);

    await flush(1000); // still waiting on the first decode: nothing else is submitted
    expect(decode).toHaveBeenCalledTimes(1);

    await act(async () => { resolveFirst(nothing); });
    await flush(QR_SCAN_MIN_GAP_MS - 1);
    expect(decode).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('fires onScan once with the code nearest the middle of the crop, then stops the camera', async () => {
    const onScan = vi.fn();
    decode.mockResolvedValueOnce({
      decoder: 'zxing',
      results: [
        { text: 'edge', cx: 0, cy: 0 },
        { text: 'centre', cx: 640, cy: 360 },
      ],
    });
    render(<QRScanner onScan={onScan} active />);
    await flush(0);
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledWith('centre');
    expect(tracks[0].stop).toHaveBeenCalled();
    await flush(1000);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('exposes the decoder in use and the last decode time for device measurement', async () => {
    decode.mockResolvedValue({ results: [], decoder: 'jsqr' });
    const { container } = render(<QRScanner onScan={vi.fn()} active />);
    await flush(0);
    const root = container.querySelector('.qr-scanner')!;
    expect(root.getAttribute('data-decoder')).toBe('jsqr');
    expect(root.getAttribute('data-last-decode-ms')).toMatch(/^\d+$/);
  });

  it('asks the native shell for the camera permission before getUserMedia', async () => {
    isNativeApp.mockReturnValue(true);
    const order: string[] = [];
    requestCameraPermission.mockImplementation(async () => { order.push('permission'); });
    getUserMedia.mockImplementationOnce(async () => { order.push('getUserMedia'); return mockStream().stream; });
    render(<QRScanner onScan={vi.fn()} active />);
    await flush(0);
    expect(order).toEqual(['permission', 'getUserMedia']);
  });

  it('still opens the camera if the native permission request rejects', async () => {
    isNativeApp.mockReturnValue(true);
    requestCameraPermission.mockRejectedValue(new Error('denied'));
    render(<QRScanner onScan={vi.fn()} active />);
    await flush(0);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('shows an error when the camera cannot be opened', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('NotAllowedError'));
    render(<QRScanner onScan={vi.fn()} active />);
    await flush(0);
    expect(screen.getByText('Could not access camera. Check permissions.')).toBeInTheDocument();
  });

  it('fill takes the whole parent with no min/max caps', () => {
    const { container } = render(<QRScanner onScan={vi.fn()} active={false} fill />);
    const root = container.querySelector('.qr-scanner') as HTMLElement;
    expect(root.style.height).toBe('100%');
    expect(root.style.minHeight).toBe('0px');
    expect(root.style.maxHeight).toBe('');
  });
});

describe('QRScanner pause and scanning line', () => {
  it('pause stops decode submissions but keeps the preview running; resume restarts them', async () => {
    const { container } = render(<QRScanner onScan={vi.fn()} active />);
    await flush(0);
    expect(screen.getByTestId('qr-scan-line')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pause scanning' }));
    const submittedAtPause = decode.mock.calls.length;
    await flush(2000);
    expect(decode).toHaveBeenCalledTimes(submittedAtPause);
    expect(tracks[0].stop).not.toHaveBeenCalled();
    expect(container.querySelector('video')!.srcObject).not.toBeNull();
    expect(screen.queryByTestId('qr-scan-line')).toBeNull();
    expect(screen.getByText(/Paused/)).toHaveTextContent('line it up, then tap Scan');

    expect(screen.getByRole('button', { name: 'Resume scanning' })).toHaveTextContent('Scan');
    fireEvent.click(screen.getByRole('button', { name: 'Resume scanning' }));
    await flush(0);
    expect(decode.mock.calls.length).toBeGreaterThan(submittedAtPause);
    expect(screen.getByTestId('qr-scan-line')).toBeInTheDocument();
  });

  it('discards a decode that finishes after the user paused', async () => {
    const onScan = vi.fn();
    let resolve!: (v: unknown) => void;
    decode.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    render(<QRScanner onScan={onScan} active />);
    await flush(0);
    fireEvent.click(screen.getByRole('button', { name: 'Pause scanning' }));
    await act(async () => { resolve({ decoder: 'zxing', results: [{ text: 'late', cx: 1, cy: 1 }] }); });
    await flush(1000);
    expect(onScan).not.toHaveBeenCalled();
    expect(decode).toHaveBeenCalledTimes(1);
  });
});

describe('QRScanner idle switch-off', () => {
  it('turns the camera off after a quiet minute and back on when tapped', async () => {
    render(<QRScanner onScan={vi.fn()} active />);
    await flush(0);
    await flush(QR_SCANNER_IDLE_MS - 1000);
    expect(tracks[0].stop).not.toHaveBeenCalled();

    await flush(1000);
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(screen.getByTestId('qr-scanner-idle')).toHaveTextContent('Camera off to save battery');
    expect(screen.queryByTestId('qr-scan-line')).toBeNull();
    const submitted = decode.mock.calls.length;
    await flush(5000);
    expect(decode).toHaveBeenCalledTimes(submitted);

    fireEvent.click(screen.getByRole('button', { name: 'Turn the camera back on' }));
    await flush(0);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('qr-scanner-idle')).toBeNull();
    expect(decode.mock.calls.length).toBeGreaterThan(submitted);
  });

  it('starts the countdown again when the user touches a control', async () => {
    render(<QRScanner onScan={vi.fn()} active />);
    await flush(0);
    await flush(QR_SCANNER_IDLE_MS - 5000);
    fireEvent.click(screen.getByRole('button', { name: 'Pause scanning' }));
    await flush(10_000);
    expect(tracks[0].stop).not.toHaveBeenCalled();
    await flush(QR_SCANNER_IDLE_MS);
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('waking from idle clears a user pause', async () => {
    render(<QRScanner onScan={vi.fn()} active />);
    await flush(0);
    fireEvent.click(screen.getByRole('button', { name: 'Pause scanning' }));
    await flush(QR_SCANNER_IDLE_MS);
    fireEvent.click(screen.getByRole('button', { name: 'Turn the camera back on' }));
    await flush(0);
    expect(screen.getByRole('button', { name: 'Pause scanning' })).toBeInTheDocument();
    expect(screen.getByTestId('qr-scan-line')).toBeInTheDocument();
  });
});

describe('QRScanner page visibility', () => {
  function setVisibility(state: 'hidden' | 'visible') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  }
  afterEach(() => setVisibility('visible'));

  it('stops the camera when the page is hidden and restarts it when visible again', async () => {
    render(<QRScanner onScan={vi.fn()} active />);
    await flush(0);
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => { setVisibility('hidden'); });
    expect(tracks[0].stop).toHaveBeenCalled();

    await act(async () => { setVisibility('visible'); });
    await flush(0);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('does not restart after a successful scan', async () => {
    decode.mockResolvedValueOnce({ decoder: 'zxing', results: [{ text: 'done', cx: 1, cy: 1 }] });
    render(<QRScanner onScan={vi.fn()} active />);
    await flush(0);
    await act(async () => { setVisibility('hidden'); });
    await act(async () => { setVisibility('visible'); });
    await flush(0);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
