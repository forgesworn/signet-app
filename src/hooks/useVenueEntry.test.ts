// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the venue-entry module before importing the hook so no real crypto
// or signing is attempted during tests.
vi.mock('../lib/venue-entry', () => ({
  buildVenueEntryPayload: vi.fn(),
}));

import { buildVenueEntryPayload } from '../lib/venue-entry';
import type { SigningBackend } from '../lib/signing-backend';
import { useVenueEntry } from './useVenueEntry';

const mockBuild = vi.mocked(buildVenueEntryPayload);

const fakeEvent = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1700000000,
  kind: 21235,
  tags: [['t', 'signet-venue-entry']],
  content: '',
  sig: 'c'.repeat(128),
};

const expectedNpPubkeyHex = 'a'.repeat(64);

const mockBackend: SigningBackend = {
  type: 'local',
  activePublicKeyHex: expectedNpPubkeyHex,
  signEvent: vi.fn(),
  nip44Encrypt: vi.fn(),
  destroy: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockBuild.mockResolvedValue(fakeEvent as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useVenueEntry — initial generation', () => {
  it('generates a QR payload on mount', async () => {
    const { result } = renderHook(() => useVenueEntry(mockBackend, expectedNpPubkeyHex));

    await act(async () => { await Promise.resolve(); });

    expect(result.current.qrData).toBe(JSON.stringify(fakeEvent));
  });

  it('sets error to null on successful generation', async () => {
    const { result } = renderHook(() => useVenueEntry(mockBackend, expectedNpPubkeyHex));

    await act(async () => { await Promise.resolve(); });

    expect(result.current.error).toBeNull();
  });

  it('calls buildVenueEntryPayload with the provided backend', async () => {
    renderHook(() => useVenueEntry(mockBackend, expectedNpPubkeyHex));

    await act(async () => { await Promise.resolve(); });

    expect(mockBuild).toHaveBeenCalledWith(mockBackend, expectedNpPubkeyHex, undefined, undefined, undefined);
  });

  it('passes optional photoHash, blossomUrl, and photoKey through to buildVenueEntryPayload', async () => {
    renderHook(() => useVenueEntry(mockBackend, expectedNpPubkeyHex, 'deadbeef', 'https://blossom.example.com/img', 'aabb'.repeat(16)));

    await act(async () => { await Promise.resolve(); });

    expect(mockBuild).toHaveBeenCalledWith(
      mockBackend,
      expectedNpPubkeyHex,
      'deadbeef',
      'https://blossom.example.com/img',
      'aabb'.repeat(16),
    );
  });
});

describe('useVenueEntry — error handling', () => {
  it('does not set error after a single failure', async () => {
    mockBuild.mockRejectedValueOnce(new Error('signer offline'));

    const { result } = renderHook(() => useVenueEntry(mockBackend, expectedNpPubkeyHex));

    await act(async () => { await Promise.resolve(); });

    expect(result.current.error).toBeNull();
  });

  it('sets error message after two consecutive failures', async () => {
    mockBuild
      .mockRejectedValueOnce(new Error('signer offline'))
      .mockRejectedValueOnce(new Error('signer offline'));

    const { result } = renderHook(() => useVenueEntry(mockBackend, expectedNpPubkeyHex));

    // First failure (on mount)
    await act(async () => { await Promise.resolve(); });

    // Advance 30 s to trigger the second attempt
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(result.current.error).toBe('Signing failed: signer offline');
  });

  it('clears error after recovery from consecutive failures', async () => {
    mockBuild
      .mockRejectedValueOnce(new Error('signer offline'))
      .mockRejectedValueOnce(new Error('signer offline'))
      .mockResolvedValue(fakeEvent as never);

    const { result } = renderHook(() => useVenueEntry(mockBackend, expectedNpPubkeyHex));

    // First failure
    await act(async () => { await Promise.resolve(); });

    // Second failure — error is set
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(result.current.error).toBe('Signing failed: signer offline');

    // Third attempt succeeds — error should clear
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(result.current.error).toBeNull();
  });
});

describe('useVenueEntry — 30-second refresh', () => {
  it('calls buildVenueEntryPayload twice after one 30-second interval', async () => {
    const { result } = renderHook(() => useVenueEntry(mockBackend, expectedNpPubkeyHex));

    // Initial generation on mount
    await act(async () => { await Promise.resolve(); });

    // Advance 30 s for the first interval tick
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(mockBuild).toHaveBeenCalledTimes(2);
    // Confirm qrData is still set from the successful calls
    expect(result.current.qrData).toBe(JSON.stringify(fakeEvent));
  });
});

describe('useVenueEntry — countdown', () => {
  it('starts secondsRemaining at 30 after a successful generation', async () => {
    const { result } = renderHook(() => useVenueEntry(mockBackend, expectedNpPubkeyHex));

    await act(async () => { await Promise.resolve(); });

    expect(result.current.secondsRemaining).toBe(30);
  });

  it('decrements secondsRemaining after 3 seconds', async () => {
    const { result } = renderHook(() => useVenueEntry(mockBackend, expectedNpPubkeyHex));

    // Flush the initial generation promise
    await act(async () => { await Promise.resolve(); });

    // Advance the countdown ticker by 3 ticks
    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
    });

    // Allow for minor timing variance — should be 27 or very close
    expect(result.current.secondsRemaining).toBeLessThanOrEqual(27);
    expect(result.current.secondsRemaining).toBeGreaterThanOrEqual(25);
  });
});
