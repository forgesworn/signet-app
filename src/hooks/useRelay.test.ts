// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the relay-service module before importing the hook so no real
// WebSocket connections are attempted during tests.
//
// M8 (2026-07-02 audit): useRelay now subscribes via the module-level
// `addStateListener` fan-out multiplexer instead of calling
// `getRelayClient().onStateChanged(cb)` directly (which only supports one
// listener process-wide and would clobber other hooks' registrations).
// The mock below replicates that fan-out — `mockStateCallbacks` mirrors
// the real multiplexer's listener set.
const mockStateCallbacks: Array<(s: string) => void> = [];

vi.mock('../lib/relay-service', () => ({
  getRelayState: vi.fn(() => 'disconnected'),
  getRelayUrl: vi.fn(() => 'ws://localhost:7777'),
  setRelayUrl: vi.fn(),
  connectRelay: vi.fn(async () => {}),
  disconnectRelay: vi.fn(),
  publishEvent: vi.fn(async () => ({ ok: true, message: '' })),
  fetchEvents: vi.fn(async () => []),
  addStateListener: vi.fn((cb: (s: string) => void) => {
    mockStateCallbacks.push(cb);
    return () => {
      const ix = mockStateCallbacks.indexOf(cb);
      if (ix >= 0) mockStateCallbacks.splice(ix, 1);
    };
  }),
}));

import * as relayService from '../lib/relay-service';
import { useRelay } from './useRelay';

beforeEach(() => {
  vi.clearAllMocks();
  mockStateCallbacks.length = 0;
  (relayService.getRelayState as Mock).mockReturnValue('disconnected');
  (relayService.getRelayUrl as Mock).mockReturnValue('ws://localhost:7777');
});

describe('useRelay — initial state', () => {
  it('starts disconnected', () => {
    const { result } = renderHook(() => useRelay());
    expect(result.current.state).toBe('disconnected');
  });

  it('exposes the current relay URL', () => {
    const { result } = renderHook(() => useRelay());
    expect(result.current.url).toBe('ws://localhost:7777');
  });
});

describe('useRelay — connect / disconnect', () => {
  it('connect calls connectRelay and updates state', async () => {
    (relayService.getRelayState as Mock).mockReturnValue('connected');

    const { result } = renderHook(() => useRelay());

    await act(async () => { await result.current.connect(); });

    expect(relayService.connectRelay).toHaveBeenCalled();
    expect(result.current.state).toBe('connected');
  });

  it('disconnect calls disconnectRelay and sets state to disconnected', () => {
    const { result } = renderHook(() => useRelay());

    act(() => { result.current.disconnect(); });

    expect(relayService.disconnectRelay).toHaveBeenCalled();
    expect(result.current.state).toBe('disconnected');
  });
});

describe('useRelay — changeUrl', () => {
  it('calls setRelayUrl with the new URL', () => {
    const { result } = renderHook(() => useRelay());

    act(() => { result.current.changeUrl('wss://new-relay.example.com'); });

    expect(relayService.setRelayUrl).toHaveBeenCalledWith('wss://new-relay.example.com');
  });

  it('updates the local url state', () => {
    const { result } = renderHook(() => useRelay());

    act(() => { result.current.changeUrl('wss://new-relay.example.com'); });

    expect(result.current.url).toBe('wss://new-relay.example.com');
  });
});

describe('useRelay — state change subscription', () => {
  it('reflects state changes pushed by the relay client', async () => {
    const { result } = renderHook(() => useRelay());

    // Simulate the client broadcasting a state change
    act(() => {
      mockStateCallbacks.forEach(cb => cb('connecting'));
    });

    expect(result.current.state).toBe('connecting');
  });

  it('reflects connected state from relay client callback', async () => {
    const { result } = renderHook(() => useRelay());

    act(() => {
      mockStateCallbacks.forEach(cb => cb('connected'));
    });

    expect(result.current.state).toBe('connected');
  });
});
