// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePublishCredential } from './usePublishCredential';

// Minimal signed Nostr event fixture used across tests
const VALID_EVENT_JSON = JSON.stringify({
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1700000000,
  kind: 29999,
  tags: [],
  content: 'test',
  sig: 'c'.repeat(128),
});

const EVENT_ID = JSON.parse(VALID_EVENT_JSON).id as string;

// WebSocket instances created during a test are tracked here so tests can
// control them after construction.
let lastMockWs: MockWebSocket | null = null;

class MockWebSocket {
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  readonly _behaviour: 'ok' | 'error' | 'timeout';

  constructor(_url: string, behaviour: 'ok' | 'error' | 'timeout' = 'ok') {
    this._behaviour = behaviour;
    lastMockWs = this;
  }

  /** Call from tests to simulate the relay completing the open + OK handshake */
  triggerOk() {
    if (this.onopen) this.onopen(new Event('open'));
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', {
        data: JSON.stringify(['OK', EVENT_ID, true, '']),
      }));
    }
  }

  /** Call from tests to simulate a connection error */
  triggerError() {
    if (this.onerror) this.onerror(new Event('error'));
  }
}

beforeEach(() => {
  lastMockWs = null;
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('usePublishCredential — no relay configured', () => {
  it('starts with no error and not publishing', () => {
    const { result } = renderHook(() => usePublishCredential());
    expect(result.current.publishing).toBe(false);
    expect(result.current.published).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('returns false and sets error when relayUrl is undefined', async () => {
    const { result } = renderHook(() => usePublishCredential());

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.publish(VALID_EVENT_JSON);
    });

    expect(returnValue).toBe(false);
    expect(result.current.error).toMatch(/no relay configured/i);
    expect(lastMockWs).toBeNull();
  });

  it('returns false and sets error when relayUrl is empty string', async () => {
    const { result } = renderHook(() => usePublishCredential(''));

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.publish(VALID_EVENT_JSON);
    });

    expect(returnValue).toBe(false);
    expect(result.current.error).toMatch(/no relay configured/i);
  });
});

describe('usePublishCredential — URL validation', () => {
  it('rejects http:// relay URL', async () => {
    const { result } = renderHook(() => usePublishCredential('http://example.com'));

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.publish(VALID_EVENT_JSON);
    });

    expect(returnValue).toBe(false);
    expect(result.current.error).toMatch(/wss:\/\//i);
    expect(lastMockWs).toBeNull();
  });

  it('rejects ws:// for non-localhost', async () => {
    const { result } = renderHook(() => usePublishCredential('ws://relay.example.com'));

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.publish(VALID_EVENT_JSON);
    });

    expect(returnValue).toBe(false);
    expect(result.current.error).toMatch(/wss:\/\//i);
  });

  it('accepts wss:// URL and opens a WebSocket', async () => {
    const { result } = renderHook(() => usePublishCredential('wss://relay.example.com'));

    // Start the publish but don't await — we need to trigger the WS manually
    let publishPromise: Promise<boolean | undefined>;
    act(() => { publishPromise = result.current.publish(VALID_EVENT_JSON); });

    // Trigger the mock WS handshake inside act so React state updates flush
    await act(async () => {
      lastMockWs?.triggerOk();
      await publishPromise;
    });

    expect(lastMockWs).not.toBeNull();
  });

  it('accepts ws://localhost', async () => {
    const { result } = renderHook(() => usePublishCredential('ws://localhost:7777'));

    let publishPromise: Promise<boolean | undefined>;
    act(() => { publishPromise = result.current.publish(VALID_EVENT_JSON); });

    await act(async () => {
      lastMockWs?.triggerOk();
      await publishPromise;
    });

    expect(lastMockWs).not.toBeNull();
  });
});

describe('usePublishCredential — invalid event JSON', () => {
  it('rejects malformed JSON', async () => {
    const { result } = renderHook(() => usePublishCredential('wss://relay.example.com'));

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.publish('not json at all {{');
    });

    expect(returnValue).toBe(false);
    expect(result.current.error).toMatch(/invalid event json/i);
  });

  it('rejects non-object JSON', async () => {
    const { result } = renderHook(() => usePublishCredential('wss://relay.example.com'));

    let returnValue: boolean | undefined;
    await act(async () => {
      returnValue = await result.current.publish('"just a string"');
    });

    expect(returnValue).toBe(false);
    expect(result.current.error).toMatch(/invalid event json/i);
  });
});

describe('usePublishCredential — successful publish', () => {
  it('sets published to true on success', async () => {
    const { result } = renderHook(() => usePublishCredential('wss://relay.example.com'));

    let publishPromise: Promise<boolean | undefined>;
    act(() => { publishPromise = result.current.publish(VALID_EVENT_JSON); });

    await act(async () => {
      lastMockWs?.triggerOk();
      await publishPromise;
    });

    expect(result.current.published).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('returns true on success', async () => {
    const { result } = renderHook(() => usePublishCredential('wss://relay.example.com'));

    let returnValue: boolean | undefined;
    let publishPromise: Promise<boolean | undefined>;
    act(() => { publishPromise = result.current.publish(VALID_EVENT_JSON); });

    await act(async () => {
      lastMockWs?.triggerOk();
      returnValue = await publishPromise;
    });

    expect(returnValue).toBe(true);
  });

  it('sends the event to the relay over WebSocket', async () => {
    const { result } = renderHook(() => usePublishCredential('wss://relay.example.com'));

    let publishPromise: Promise<boolean | undefined>;
    act(() => { publishPromise = result.current.publish(VALID_EVENT_JSON); });

    await act(async () => {
      lastMockWs?.triggerOk();
      await publishPromise;
    });

    expect(lastMockWs!.send).toHaveBeenCalledOnce();
    const sentPayload: unknown = JSON.parse(lastMockWs!.send.mock.calls[0][0] as string);
    expect(Array.isArray(sentPayload)).toBe(true);
    expect((sentPayload as unknown[])[0]).toBe('EVENT');
  });

  it('closes the WebSocket after publishing', async () => {
    const { result } = renderHook(() => usePublishCredential('wss://relay.example.com'));

    let publishPromise: Promise<boolean | undefined>;
    act(() => { publishPromise = result.current.publish(VALID_EVENT_JSON); });

    await act(async () => {
      lastMockWs?.triggerOk();
      await publishPromise;
    });

    expect(lastMockWs!.close).toHaveBeenCalled();
  });
});

describe('usePublishCredential — connection error', () => {
  it('sets error and returns false when relay errors', async () => {
    const { result } = renderHook(() => usePublishCredential('wss://relay.example.com'));

    let returnValue: boolean | undefined;
    let publishPromise: Promise<boolean | undefined>;
    act(() => { publishPromise = result.current.publish(VALID_EVENT_JSON); });

    await act(async () => {
      lastMockWs?.triggerError();
      returnValue = await publishPromise;
    });

    expect(returnValue).toBe(false);
    expect(result.current.error).toMatch(/failed to connect/i);
    expect(result.current.published).toBe(false);
  });

  it('closes the WebSocket even when the relay errors (no leaked socket)', async () => {
    const { result } = renderHook(() => usePublishCredential('wss://relay.example.com'));

    let publishPromise: Promise<boolean | undefined>;
    act(() => { publishPromise = result.current.publish(VALID_EVENT_JSON); });

    await act(async () => {
      lastMockWs?.triggerError();
      await publishPromise;
    });

    expect(lastMockWs!.close).toHaveBeenCalled();
  });
});

describe('usePublishCredential — publishing flag', () => {
  it('publishing is false before and after a publish call', async () => {
    const { result } = renderHook(() => usePublishCredential('wss://relay.example.com'));

    expect(result.current.publishing).toBe(false);

    let publishPromise: Promise<boolean | undefined>;
    act(() => { publishPromise = result.current.publish(VALID_EVENT_JSON); });

    await act(async () => {
      lastMockWs?.triggerOk();
      await publishPromise;
    });

    expect(result.current.publishing).toBe(false);
  });
});
