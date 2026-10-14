import { afterEach, expect, it, vi } from 'vitest';
import { fetchNewestFromRelays } from './sync-relays';

/** A connection that opens, but never completes its Nostr read. */
class SilentSocket {
  static OPEN = 1;
  static instances: SilentSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor() { SilentSocket.instances.push(this); queueMicrotask(() => this.onopen?.()); }
  send(frame: string) { this.sent.push(frame); }
  close() { this.readyState = 3; this.onclose?.(); }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); SilentSocket.instances = []; });
it('a connected relay without EOSE cannot masquerade as an empty successful sync read', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', SilentSocket);
  const work = fetchNewestFromRelays({ kinds: [30078], authors: ['a'.repeat(64)] }, ['wss://silent.example'], undefined, { timeoutMs: 50 });
  await vi.advanceTimersByTimeAsync(50);
  expect(await work).toEqual({ event: null, reachableRelays: 0 });
  expect(SilentSocket.instances[0].readyState).toBe(3);
  await vi.advanceTimersByTimeAsync(100);
});

it('restores live subscriptions on one SDK reconnect without opening a competing socket', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', SilentSocket);
  vi.resetModules();
  const relay = await import('./relay-service');
  relay.setRelays([{ url: 'wss://reconnect.example', enabled: true, read: true, write: true }]);
  const connected = relay.connectRelay();
  await vi.advanceTimersByTimeAsync(0);
  await connected;
  relay.getRelayClient().subscribe([{ kinds: [0] }], () => {});
  const original = SilentSocket.instances[0].sent.find(frame => JSON.parse(frame)[0] === 'REQ');
  SilentSocket.instances[0].close(); // network drop, not an intentional Disconnect
  await vi.advanceTimersByTimeAsync(3100);
  expect(SilentSocket.instances).toHaveLength(2);
  expect(SilentSocket.instances[1].sent).toContain(original);
  expect(relay.getRelayState()).toBe('connected');
  relay.disconnectRelay();
});
