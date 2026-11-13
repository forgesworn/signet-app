// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const MASTER = 'a'.repeat(64);
const SECRET = 'c'.repeat(64);
const RAW = 'RAW-CIPHERTEXT';
const OLD_URI = `bunker://${MASTER}?relay=${encodeURIComponent('wss://primal.example')}&secret=s3cret`;

const m = vi.hoisted(() => ({
  probeCalls: [] as Array<{ relay: string; signal: AbortSignal; secret: string; master: string }>,
  probeImpl: null as null | ((relay: string, signal: AbortSignal) => Promise<string>),
  swap: vi.fn(),
  prefs: vi.fn(),
  loadSecret: vi.fn(),
}));

vi.mock('../lib/signer-relay-probe', () => ({
  createBunkerProbe: (secret: string, master: string) => (relay: string, signal: AbortSignal) => {
    m.probeCalls.push({ relay, signal, secret, master });
    return m.probeImpl!(relay, signal);
  },
}));
vi.mock('../lib/db', () => ({
  getPreferencesWithRawBunkerUri: (...a: unknown[]) => m.prefs(...a),
  loadBunkerSecret: (...a: unknown[]) => m.loadSecret(...a),
  swapBunkerUriIfUnchanged: (...a: unknown[]) => m.swap(...a),
}));
vi.mock('../lib/crypto-store', () => ({ encryptSecret: async (uri: string, key: string) => `ENC(${key}):${uri}` }));
vi.mock('../lib/relay-service', () => ({ defaultRelays: () => [{ url: 'wss://ditto.example' }] }));
vi.mock('../lib/heartwood-mgmt', () => ({
  getStatus: vi.fn(async () => ({})),
  getNetworkConfig: vi.fn(async () => ({ relays: [], trial: false })),
}));

import { useSignerLinkRecovery, type SignerStatus, type RecoveryOperatorState } from './useSignerLinkRecovery';

interface Props {
  status: SignerStatus;
  key: string | null;
  mode?: string;
  operator?: RecoveryOperatorState;
}
const NO_OPERATOR: RecoveryOperatorState = { loading: false, credential: null, client: null };

let retry: Mock<() => Promise<void>>;
let reload: Mock<(key?: string) => Promise<void>>;

function mount(initial: Props) {
  return renderHook((p: Props) => useSignerLinkRecovery({
    signerStatus: p.status,
    signingMode: p.mode ?? 'bunker',
    encryptionKey: p.key,
    operator: p.operator ?? NO_OPERATOR,
    reloadPreferences: reload,
    retryConnect: retry,
  }), { initialProps: initial });
}

const answerOn = (...relays: string[]) => {
  m.probeImpl = async (relay) => {
    if (relays.includes(relay)) return MASTER;
    throw new Error('silent');
  };
};
/** A probe that stays pending until its signal aborts. */
const hang = () => {
  m.probeImpl = (_r, signal) => new Promise<string>((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
};
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });

beforeEach(() => {
  m.probeCalls = [];
  m.swap.mockReset().mockResolvedValue(true);
  m.prefs.mockReset().mockResolvedValue({ prefs: { bunkerUri: OLD_URI }, rawBunkerUri: RAW });
  m.loadSecret.mockReset().mockResolvedValue(SECRET);
  retry = vi.fn<() => Promise<void>>(async () => {});
  reload = vi.fn<(key?: string) => Promise<void>>(async () => {});
  answerOn('wss://ditto.example');
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('useSignerLinkRecovery', () => {
  it('on a failed unlock reconnect, writes the new link as a compare-and-swap, reloads, then retries', async () => {
    mount({ status: 'unavailable', key: 'K1' });
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(m.prefs).toHaveBeenCalledWith('K1');
    expect(m.swap).toHaveBeenCalledTimes(1);
    const [expected, next] = m.swap.mock.calls[0];
    expect(expected).toBe(RAW);
    expect(next.startsWith('ENC(K1):bunker://')).toBe(true);
    expect(next).toContain('wss%3A%2F%2Fditto.example');
    expect(next).toContain('secret=s3cret');
    expect(reload).toHaveBeenCalledWith('K1');
    // every probe got the stored client secret and the link's master
    expect(m.probeCalls.length).toBeGreaterThan(0);
    expect(m.probeCalls.every(c => c.secret === SECRET && c.master === MASTER)).toBe(true);
  });

  it('runs once per unlock, however often it re-renders', async () => {
    const h = mount({ status: 'unavailable', key: 'K1' });
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    const probes = m.probeCalls.length;
    h.rerender({ status: 'unavailable', key: 'K1' });
    h.rerender({ status: 'unavailable', key: 'K1', operator: { ...NO_OPERATOR } });
    await flush();
    expect(m.probeCalls.length).toBe(probes);
    expect(m.swap).toHaveBeenCalledTimes(1);
  });

  it('runs again on the next unlock, once its own reconnect fails', async () => {
    const h = mount({ status: 'unavailable', key: 'K1' });
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    h.rerender({ status: null, key: null }); // lock: App clears the status
    h.rerender({ status: null, key: 'K2' }); // unlock
    h.rerender({ status: 'connecting', key: 'K2' });
    await flush();
    expect(m.swap).toHaveBeenCalledTimes(1);
    h.rerender({ status: 'unavailable', key: 'K2' }); // this unlock's reconnect failed
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(2));
    expect(m.prefs).toHaveBeenLastCalledWith('K2');
  });

  it('ignores a stale unavailable carried across a lock and unlock', async () => {
    const h = mount({ status: 'unavailable', key: 'K1' });
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    const probes = m.probeCalls.length;
    h.rerender({ status: 'unavailable', key: null }); // locked, stale value kept
    h.rerender({ status: 'unavailable', key: 'K2' }); // unlocked, still the stale value
    await flush();
    expect(m.probeCalls.length).toBe(probes);
    expect(m.prefs).toHaveBeenCalledTimes(1);
    // A value that changes during this unlock is a real failure.
    h.rerender({ status: 'connecting', key: 'K2' });
    h.rerender({ status: 'unavailable', key: 'K2' });
    await vi.waitFor(() => expect(m.prefs).toHaveBeenCalledTimes(2));
  });

  it('never runs for a non-bunker signing mode or while locked', async () => {
    mount({ status: 'unavailable', key: 'K1', mode: 'paired-child' });
    mount({ status: 'unavailable', key: 'K1', mode: 'local' });
    mount({ status: 'unavailable', key: null });
    await flush();
    expect(m.prefs).not.toHaveBeenCalled();
  });

  it('a lock aborts the run: probes closed, no write, no retry, and the guard resets', async () => {
    hang();
    const h = mount({ status: 'unavailable', key: 'K1' });
    await vi.waitFor(() => expect(m.probeCalls.length).toBeGreaterThan(0));
    expect(m.probeCalls.every(c => !c.signal.aborted)).toBe(true);
    h.rerender({ status: null, key: null });
    await flush();
    expect(m.probeCalls.every(c => c.signal.aborted)).toBe(true);
    expect(m.swap).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(h.result.current.searching).toBe(false);
    // the once-per-unlock flag was reset: the next unlock's failure recovers
    answerOn('wss://ditto.example');
    h.rerender({ status: null, key: 'K2' });
    h.rerender({ status: 'connecting', key: 'K2' });
    h.rerender({ status: 'unavailable', key: 'K2' });
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
  });

  it('does not write or retry when the status turns connected mid-run', async () => {
    let release: (v: string) => void = () => {};
    m.probeImpl = async (relay) => {
      if (relay !== 'wss://ditto.example') throw new Error('silent');
      return new Promise<string>(res => { release = res; });
    };
    const h = mount({ status: 'unavailable', key: 'K1' });
    await vi.waitFor(() => expect(m.probeCalls.some(c => c.relay === 'wss://ditto.example')).toBe(true));
    h.rerender({ status: 'connected', key: 'K1' });
    release(MASTER);
    await flush();
    expect(m.swap).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  describe('the banner Retry', () => {
    it('is ignored while a run is going', async () => {
      hang();
      const h = mount({ status: 'unavailable', key: 'K1' });
      await vi.waitFor(() => expect(h.result.current.searching).toBe(true));
      act(() => h.result.current.onManualRetry());
      await flush();
      expect(retry).not.toHaveBeenCalled();
    });

    it('re-arms the recovery after a run ends, and reconnects', async () => {
      answerOn(); // nothing answers
      const h = mount({ status: 'unavailable', key: 'K1' });
      await vi.waitFor(() => { expect(m.prefs).toHaveBeenCalledTimes(1); expect(h.result.current.searching).toBe(false); });
      await flush();
      expect(retry).not.toHaveBeenCalled();
      act(() => h.result.current.onManualRetry());
      expect(retry).toHaveBeenCalledTimes(1);
      // The manual retry ended 'unavailable' again: one more recovery may run.
      h.rerender({ status: 'connecting', key: 'K1' });
      h.rerender({ status: 'unavailable', key: 'K1' });
      await vi.waitFor(() => expect(m.prefs).toHaveBeenCalledTimes(2));
    });

    it('does not re-arm without a Retry', async () => {
      answerOn();
      const h = mount({ status: 'unavailable', key: 'K1' });
      await vi.waitFor(() => expect(m.prefs).toHaveBeenCalledTimes(1));
      await flush();
      h.rerender({ status: 'connecting', key: 'K1' });
      h.rerender({ status: 'unavailable', key: 'K1' });
      await flush();
      expect(m.prefs).toHaveBeenCalledTimes(1);
    });
  });

  describe('the operator wait', () => {
    const waitingOperator: RecoveryOperatorState = {
      loading: false,
      credential: { deviceHex: MASTER, relays: [] },
      client: null, // credential stored, client not up yet
    };

    async function startWaiting(h?: ReturnType<typeof mount>) {
      vi.useFakeTimers();
      answerOn(); // the non-operator probes fail at once, leaving only the wait timer
      const hook = h ?? mount({ status: 'unavailable', key: 'K1', operator: waitingOperator });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(m.prefs).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBeGreaterThan(0); // the poll timer
      return hook;
    }

    it('stops on lock (its timer is cleared, nothing is written)', async () => {
      const h = await startWaiting();
      h.rerender({ status: null, key: null, operator: waitingOperator });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(m.swap).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
    });

    it('stops on unmount (its timer is cleared, nothing is written)', async () => {
      const h = await startWaiting();
      h.unmount();
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(m.swap).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
    });

    it('gives up after 10 s without a client and carries on with the other candidates', async () => {
      vi.useFakeTimers();
      answerOn('wss://ditto.example');
      mount({ status: 'unavailable', key: 'K1', operator: waitingOperator });
      await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
      expect(retry).not.toHaveBeenCalled(); // still waiting: the run ends only when the operator branch has
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(m.swap).toHaveBeenCalledTimes(1);
      expect(retry).toHaveBeenCalledTimes(1);
    });

    it('does not wait at all when there is no credential', async () => {
      vi.useFakeTimers();
      answerOn('wss://ditto.example');
      mount({ status: 'unavailable', key: 'K1' });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(retry).toHaveBeenCalledTimes(1);
    });
  });

  it('reports searching while a run is going, then not', async () => {
    const releases: Array<(v: string) => void> = [];
    m.probeImpl = async () => new Promise<string>(res => { releases.push(res); });
    const h = mount({ status: 'unavailable', key: 'K1' });
    await vi.waitFor(() => expect(h.result.current.searching).toBe(true));
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
    releases.forEach(r => r('b'.repeat(64))); // wrong pubkey: does not count
    await vi.waitFor(() => expect(h.result.current.searching).toBe(false));
  });
});
