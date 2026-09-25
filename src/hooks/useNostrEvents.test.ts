// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { NostrEvent } from 'signet-protocol';

// ---------------------------------------------------------------------------
// Mock relay-service before the hook is imported so no real WebSocket
// connections are attempted during tests.
// ---------------------------------------------------------------------------

// Captured state-listener callback — tests call this to simulate relay
// state transitions (e.g. connecting → connected).
//
// M8 (2026-07-02 audit): useNostrEvents now subscribes via the
// module-level `addStateListener` fan-out multiplexer instead of calling
// `getRelayClient().onStateChanged(cb)` directly (single-slot, clobbered
// by other hooks). `.fetch()` still goes through `getRelayClient()`.
//
// vi.hoisted ensures these are initialised before the vi.mock factory
// below runs (vi.mock itself is hoisted to the top of the module).
const { mockClient, mockAddStateListener, getCapturedStateCallback } = vi.hoisted(() => {
  let capturedStateCallback: (state: string) => void = () => {};
  return {
    mockClient: {
      fetch: vi.fn(async (): Promise<unknown[]> => []),
    },
    mockAddStateListener: vi.fn((cb: (state: string) => void) => {
      capturedStateCallback = cb;
      return () => { capturedStateCallback = () => {}; };
    }),
    getCapturedStateCallback: () => capturedStateCallback,
  };
});

vi.mock('../lib/relay-service', () => ({
  getRelayClient: vi.fn(() => mockClient),
  getRelayState: vi.fn(() => 'disconnected'),
  addStateListener: mockAddStateListener,
}));

// Pass-through the signature/author filter — the fixture events here use
// fake sigs that intentionally fail nostr-tools' verifyEvent. The hook's
// verification behaviour is exercised end-to-end elsewhere; these tests
// focus on plumbing (fetch wiring, refresh, error handling).
vi.mock('../lib/event-verify', () => ({
  verifiedAuthoredEvents: <T,>(events: T[]) => events,
  verifiedAuthoredEvent: <T,>(event: T | null | undefined) => event ?? null,
}));

import * as relayService from '../lib/relay-service';
import { useNostrEvents } from './useNostrEvents';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PUBKEY = 'a'.repeat(64);

function makeEvent(id: string): NostrEvent {
  return {
    id,
    pubkey: PUBKEY,
    created_at: 1_700_000_000,
    kind: 31000,
    tags: [],
    content: '',
    sig: 'f'.repeat(128),
  } as unknown as NostrEvent;
}

const CRED_EVENT = makeEvent('cred' + '0'.repeat(60));
const VOUCH_EVENT = makeEvent('vouch' + '0'.repeat(59));
const BRIDGE_EVENT = makeEvent('bridge' + '0'.repeat(58));

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // clearAllMocks resets call/results history but not the base
  // implementation set in vi.hoisted above, so mockAddStateListener keeps
  // capturing into the private capturedStateCallback closure.
  vi.clearAllMocks();

  // Default: relay is disconnected, fetch returns empty arrays
  (relayService.getRelayState as Mock).mockReturnValue('disconnected');
  mockClient.fetch.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useNostrEvents — undefined pubkey', () => {
  it('returns empty arrays and loading:false when pubkey is undefined', async () => {
    const { result } = renderHook(() => useNostrEvents(undefined));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.credentials).toEqual([]);
    expect(result.current.vouches).toEqual([]);
    expect(result.current.bridges).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('does not call fetch when pubkey is undefined', async () => {
    renderHook(() => useNostrEvents(undefined));

    await waitFor(() => {}); // allow effects to settle
    expect(mockClient.fetch).not.toHaveBeenCalled();
  });
});

describe('useNostrEvents — relay not connected', () => {
  it('does not fetch when relay state is not connected', async () => {
    (relayService.getRelayState as Mock).mockReturnValue('connecting');

    renderHook(() => useNostrEvents(PUBKEY));

    await waitFor(() => {}); // allow effects to settle
    expect(mockClient.fetch).not.toHaveBeenCalled();
  });

  it('returns loading:false without fetching when relay is disconnected', async () => {
    (relayService.getRelayState as Mock).mockReturnValue('disconnected');

    const { result } = renderHook(() => useNostrEvents(PUBKEY));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockClient.fetch).not.toHaveBeenCalled();
  });
});

describe('useNostrEvents — loading state', () => {
  it('is loading:false before and after fetch completes', async () => {
    (relayService.getRelayState as Mock).mockReturnValue('connected');

    // Use a promise we control so we can observe loading mid-flight
    let resolveFetch!: (events: NostrEvent[]) => void;
    const fetchPromise = new Promise<NostrEvent[]>(resolve => { resolveFetch = resolve; });
    mockClient.fetch.mockReturnValue(fetchPromise);

    const { result } = renderHook(() => useNostrEvents(PUBKEY));

    // loading should be true while fetch is in-flight
    await waitFor(() => expect(result.current.loading).toBe(true));

    // Resolve all three fetch calls and wait for loading to clear
    await act(async () => {
      resolveFetch([]);
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});

describe('useNostrEvents — successful fetch', () => {
  it('populates credentials, vouches, and bridges from relay responses', async () => {
    (relayService.getRelayState as Mock).mockReturnValue('connected');

    // Each call to fetch returns a different set of events: credentials first,
    // then vouches, then bridges — matching the order in the hook.
    mockClient.fetch
      .mockResolvedValueOnce([CRED_EVENT])
      .mockResolvedValueOnce([VOUCH_EVENT])
      .mockResolvedValueOnce([BRIDGE_EVENT]);

    const { result } = renderHook(() => useNostrEvents(PUBKEY));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.credentials).toEqual([CRED_EVENT]);
    expect(result.current.vouches).toEqual([VOUCH_EVENT]);
    expect(result.current.bridges).toEqual([BRIDGE_EVENT]);
    expect(result.current.error).toBeNull();
  });

  it('calls fetch exactly three times (credentials, vouches, bridges)', async () => {
    (relayService.getRelayState as Mock).mockReturnValue('connected');

    const { result } = renderHook(() => useNostrEvents(PUBKEY));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockClient.fetch).toHaveBeenCalledTimes(3);
  });
});

describe('useNostrEvents — error handling', () => {
  it('sets error when relay client throws', async () => {
    (relayService.getRelayState as Mock).mockReturnValue('connected');
    mockClient.fetch.mockRejectedValue(new Error('relay exploded'));

    const { result } = renderHook(() => useNostrEvents(PUBKEY));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('relay exploded');
    expect(result.current.credentials).toEqual([]);
  });

  it('sets a generic error message when the thrown value is not an Error instance', async () => {
    (relayService.getRelayState as Mock).mockReturnValue('connected');
    mockClient.fetch.mockRejectedValue('something went wrong');

    const { result } = renderHook(() => useNostrEvents(PUBKEY));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('Failed to fetch events');
  });
});

describe('useNostrEvents — onStateChanged re-fetch', () => {
  it('re-fetches when onStateChanged fires with connected', async () => {
    // Start disconnected so the initial effect does not fetch
    (relayService.getRelayState as Mock).mockReturnValue('disconnected');

    const { result } = renderHook(() => useNostrEvents(PUBKEY));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockClient.fetch).not.toHaveBeenCalled();

    // Now the relay comes online — switch getRelayState and fire the callback
    (relayService.getRelayState as Mock).mockReturnValue('connected');

    mockClient.fetch
      .mockResolvedValueOnce([CRED_EVENT])
      .mockResolvedValueOnce([VOUCH_EVENT])
      .mockResolvedValueOnce([BRIDGE_EVENT]);

    await act(async () => {
      getCapturedStateCallback()('connected');
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockClient.fetch).toHaveBeenCalledTimes(3);
    expect(result.current.credentials).toEqual([CRED_EVENT]);
    expect(result.current.vouches).toEqual([VOUCH_EVENT]);
    expect(result.current.bridges).toEqual([BRIDGE_EVENT]);
  });

  it('does not re-fetch when onStateChanged fires with a non-connected state', async () => {
    (relayService.getRelayState as Mock).mockReturnValue('disconnected');

    renderHook(() => useNostrEvents(PUBKEY));

    await waitFor(() => {}); // settle initial effects

    await act(async () => {
      getCapturedStateCallback()('connecting');
    });

    expect(mockClient.fetch).not.toHaveBeenCalled();
  });

  it('registers a state listener when pubkey is provided', async () => {
    (relayService.getRelayState as Mock).mockReturnValue('disconnected');

    renderHook(() => useNostrEvents(PUBKEY));

    await waitFor(() => {}); // settle effects
    expect(mockAddStateListener).toHaveBeenCalled();
  });

  it('does not register a state listener when pubkey is undefined', async () => {
    renderHook(() => useNostrEvents(undefined));

    await waitFor(() => {}); // settle effects
    expect(mockAddStateListener).not.toHaveBeenCalled();
  });
});

describe('useNostrEvents — refresh()', () => {
  it('triggers a new fetch when refresh() is called', async () => {
    (relayService.getRelayState as Mock).mockReturnValue('connected');

    const { result } = renderHook(() => useNostrEvents(PUBKEY));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockClient.fetch).toHaveBeenCalledTimes(3); // initial fetch

    // Arrange different data for the second fetch round
    mockClient.fetch
      .mockResolvedValueOnce([CRED_EVENT])
      .mockResolvedValueOnce([VOUCH_EVENT])
      .mockResolvedValueOnce([BRIDGE_EVENT]);

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Six total calls: 3 initial + 3 from refresh
    expect(mockClient.fetch).toHaveBeenCalledTimes(6);
    expect(result.current.credentials).toEqual([CRED_EVENT]);
  });

  it('refresh() does nothing when pubkey is undefined', async () => {
    const { result } = renderHook(() => useNostrEvents(undefined));

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      result.current.refresh();
    });

    expect(mockClient.fetch).not.toHaveBeenCalled();
  });
});
