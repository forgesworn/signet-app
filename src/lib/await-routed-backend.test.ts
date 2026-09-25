import { describe, it, expect, vi, afterEach } from 'vitest';
import { awaitRoutedBackend, acquireRoutedBackend } from './await-routed-backend';
import { RoutedBunkerSigningBackend } from './bunker-router';

afterEach(() => { vi.useRealTimers(); });

describe('awaitRoutedBackend', () => {
  it('returns the route at once when it is already available', async () => {
    const lookup = vi.fn(() => 'route');
    await expect(awaitRoutedBackend({ lookup, timeoutMs: 1000 })).resolves.toBe('route');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('waits for a route that appears after a reconnect', async () => {
    vi.useFakeTimers();
    let route: string | null = null;
    const p = awaitRoutedBackend({ lookup: () => route, timeoutMs: 5000, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(1000);
    route = 'route';
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe('route');
  });

  it('gives up with null once the budget is spent — never hangs', async () => {
    vi.useFakeTimers();
    const p = awaitRoutedBackend({ lookup: () => null, timeoutMs: 2000, intervalMs: 250 });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBeNull();
  });

  it('stops early when waiting can no longer help', async () => {
    vi.useFakeTimers();
    let hopeless = false;
    const p = awaitRoutedBackend({ lookup: () => null, isHopeless: () => hopeless, timeoutMs: 60_000, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(300);
    hopeless = true;
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBeNull();
  });
});

describe('acquireRoutedBackend — the approval wait shared by sign-in and connect', () => {
  const base = {
    unavailableMessage: () => 'Your signer is not reachable right now. Check it is online, then try again.',
    withdrawnMessage: 'This connection request is no longer pending.',
  };

  it('returns the route once the signer reconnects', async () => {
    vi.useFakeTimers();
    let route: string | null = null;
    const p = acquireRoutedBackend({ ...base, lookup: () => route, stillPending: () => true, timeoutMs: 5000, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(500);
    route = 'routed';
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe('routed');
  });

  it('ends in the honest unavailable copy after the window — not a local-key error', async () => {
    vi.useFakeTimers();
    const p = acquireRoutedBackend({ ...base, lookup: () => null, stillPending: () => true, timeoutMs: 1000, intervalMs: 100 });
    const assertion = expect(p).rejects.toThrow(/not reachable/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('stops at once when the request is withdrawn, with the withdrawn copy', async () => {
    vi.useFakeTimers();
    let pending = true;
    const p = acquireRoutedBackend({ ...base, lookup: () => null, stillPending: () => pending, timeoutMs: 60_000, intervalMs: 100 });
    const assertion = expect(p).rejects.toThrow('no longer pending');
    await vi.advanceTimersByTimeAsync(200);
    pending = false;
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });
});

describe('the approval route wait issues no NIP-46 traffic', () => {
  it('polling for a route never opens a signer connection, and a cancel stops the poll at once', async () => {
    vi.useFakeTimers();
    const makeBackend = vi.fn();
    const route = new RoutedBunkerSigningBackend('a'.repeat(64), 'bunker://' + 'b'.repeat(64) + '?relay=wss://r.example', 'c'.repeat(64), makeBackend as never);
    const routerReady = false;
    let pending = true;
    const lookup = vi.fn(() => (routerReady ? route : null));
    const p = acquireRoutedBackend({
      lookup,
      stillPending: () => pending,
      unavailableMessage: () => 'unavailable',
      withdrawnMessage: 'withdrawn',
      timeoutMs: 20_000,
      intervalMs: 250,
    });
    const assertion = expect(p).rejects.toThrow('withdrawn');
    await vi.advanceTimersByTimeAsync(2000);      // ~8 polls while the router is down
    const pollsBeforeCancel = lookup.mock.calls.length;
    expect(pollsBeforeCancel).toBeGreaterThan(1);
    expect(pollsBeforeCancel).toBeLessThanOrEqual(10);   // bounded by the interval
    pending = false;                               // Cancel
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    const pollsAtCancel = lookup.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(lookup.mock.calls.length).toBe(pollsAtCancel);   // nothing after the cancel
    expect(makeBackend).not.toHaveBeenCalled();              // no signer connection, no requests
  });

  it('finding the route hands it back without connecting; only a real sign opens the connection', async () => {
    const makeBackend = vi.fn();
    const route = new RoutedBunkerSigningBackend('a'.repeat(64), 'bunker://' + 'b'.repeat(64) + '?relay=wss://r.example', 'c'.repeat(64), makeBackend as never);
    await expect(acquireRoutedBackend({
      lookup: () => route,
      stillPending: () => true,
      unavailableMessage: () => 'unavailable',
      withdrawnMessage: 'withdrawn',
    })).resolves.toBe(route);
    expect(makeBackend).not.toHaveBeenCalled();
  });
});
