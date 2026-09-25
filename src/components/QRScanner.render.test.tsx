// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QRScanner,
  QR_SCANNER_PREFERRED_ZOOM,
  QR_SCANNER_ZOOM_BUTTON_STEP,
  QR_SCANNER_VIDEO_CONSTRAINTS,
} from './QRScanner';

function mockCameraStream(capabilities: Record<string, unknown> = {}) {
  const stop = vi.fn();
  const applyConstraints = vi.fn().mockResolvedValue(undefined);
  const track = {
    stop,
    applyConstraints,
    getCapabilities: vi.fn(() => capabilities),
  };
  const stream = {
    getTracks: vi.fn(() => [track]),
    getVideoTracks: vi.fn(() => [track]),
  };
  return { stream, track, stop, applyConstraints };
}

beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    writable: true,
    configurable: true,
    value: {
      getUserMedia: vi.fn(),
    },
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('QRScanner mobile zoom regression', () => {
  it('requests high-resolution rear-camera video and starts optical zoom when the camera supports it', async () => {
    const { stream, applyConstraints } = mockCameraStream({
      zoom: { min: 1, max: 4, step: 0.1 },
    });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream as unknown as MediaStream);

    render(<QRScanner onScan={vi.fn()} active />);

    await waitFor(() => {
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
        video: QR_SCANNER_VIDEO_CONSTRAINTS,
        audio: false,
      });
    });

    const slider = await screen.findByRole('slider', { name: 'Camera zoom' });
    expect(slider).toHaveValue(String(QR_SCANNER_PREFERRED_ZOOM));
    expect(screen.getByText(`${QR_SCANNER_PREFERRED_ZOOM.toFixed(1)}x`)).toBeInTheDocument();
    expect(applyConstraints).toHaveBeenCalledWith({
      advanced: [{ zoom: QR_SCANNER_PREFERRED_ZOOM }],
    });
  });

  it('shows the same zoom control and digitally scales the preview when iOS-style cameras expose no optical zoom', async () => {
    const { stream, applyConstraints } = mockCameraStream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream as unknown as MediaStream);

    const { container } = render(<QRScanner onScan={vi.fn()} active />);

    const slider = await screen.findByRole('slider', { name: 'Camera zoom' });
    expect(slider).toHaveValue(String(QR_SCANNER_PREFERRED_ZOOM));
    expect(applyConstraints).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(container.querySelector('video')).toHaveStyle({
        transform: `scale(${QR_SCANNER_PREFERRED_ZOOM})`,
      });
    });
  });

  it('provides large zoom buttons for mobile Safari instead of relying on the range input alone', async () => {
    const { stream } = mockCameraStream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream as unknown as MediaStream);

    render(<QRScanner onScan={vi.fn()} active />);

    await screen.findByRole('slider', { name: 'Camera zoom' });
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));

    expect(screen.getByText(`${(QR_SCANNER_PREFERRED_ZOOM + QR_SCANNER_ZOOM_BUTTON_STEP).toFixed(1)}x`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByText(`${QR_SCANNER_PREFERRED_ZOOM.toFixed(1)}x`)).toBeInTheDocument();
  });
});
