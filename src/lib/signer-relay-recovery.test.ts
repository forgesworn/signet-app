import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normaliseRelay, parseLink, rewriteBunkerRelays, composeNewRelays, collectCandidates,
  resolveOperatorReported, linkRoundTrips, probeRelays, recoverSignerLink, newRecoveryGuard,
  type RecoverIo, type OperatorChannel, type RecoveryGuard,
} from './signer-relay-recovery';

const MASTER = 'a'.repeat(64);
const SECRET = 'se+cr/et=%26x y';
const uriWith = (relays: string[], extra = `secret=${encodeURIComponent(SECRET)}`) =>
  `bunker://${MASTER}?${relays.map(r => `relay=${encodeURIComponent(r)}`).join('&')}${extra ? `&${extra}` : ''}`;

describe('normaliseRelay', () => {
  it('accepts wss and loopback ws, lowercases and drops one trailing slash', () => {
    expect(normaliseRelay('WSS://Relay.Example.COM/')).toBe('wss://relay.example.com');
    expect(normaliseRelay('wss://r.example/path/')).toBe('wss://r.example/path');
    expect(normaliseRelay('ws://localhost:7777')).toBe('ws://localhost:7777');
    expect(normaliseRelay('ws://127.0.0.1:1')).toBe('ws://127.0.0.1:1');
  });
  it('rejects ws:// off loopback, junk and credentials', () => {
    expect(normaliseRelay('ws://relay.example.com')).toBeNull();
    expect(normaliseRelay('https://relay.example.com')).toBeNull();
    expect(normaliseRelay('junk')).toBeNull();
    expect(normaliseRelay('')).toBeNull();
    expect(normaliseRelay('wss://user:pw@relay.example.com')).toBeNull();
    expect(normaliseRelay('ws://localhost.evil.com')).toBeNull();
  });
});

describe('collectCandidates', () => {
  const base = { operatorReported: [], operatorCredential: [], link: [], userRelays: [], defaults: [] };
  it('orders the sources (operator-reported, link, credential, user, defaults) and dedupes', () => {
    const out = collectCandidates({
      operatorReported: ['wss://a.example'],
      operatorCredential: ['wss://b.example', 'wss://a.example/'],
      link: ['wss://c.example'],
      userRelays: ['wss://d.example', 'wss://C.example'],
      defaults: ['wss://e.example'],
    });
    expect(out).toEqual(['wss://a.example', 'wss://c.example', 'wss://b.example', 'wss://d.example', 'wss://e.example']);
  });
  it('drops invalid entries', () => {
    expect(collectCandidates({ ...base, link: ['ws://evil.example', 'nope', 'wss://ok.example'] })).toEqual(['wss://ok.example']);
  });
  it('takes at most 3 from each source, so a long credential cannot crowd out the rest', () => {
    const many = (p: string) => Array.from({ length: 8 }, (_, i) => `wss://${p}${i}.example`);
    const out = collectCandidates({
      operatorReported: many('op'), operatorCredential: many('cred'),
      link: ['wss://link0.example'], userRelays: [], defaults: ['wss://ditto.example'],
    });
    expect(out.filter(r => r.includes('//op'))).toHaveLength(3);
    expect(out.filter(r => r.includes('//cred'))).toHaveLength(3);
    expect(out).toContain('wss://link0.example');
    expect(out).toContain('wss://ditto.example');
  });
  it('caps the total at 10', () => {
    const many = (p: string) => Array.from({ length: 3 }, (_, i) => `wss://${p}${i}.example`);
    const out = collectCandidates({
      operatorReported: many('a'), link: many('b'), operatorCredential: many('c'), userRelays: many('d'), defaults: many('e'),
    });
    expect(out).toHaveLength(10);
    expect(out[9]).toBe('wss://d0.example');
    expect(out).not.toContain('wss://e2.example');
  });
});

describe('resolveOperatorReported', () => {
  const op = (over: Partial<OperatorChannel> = {}): OperatorChannel => ({
    deviceHex: MASTER,
    credentialRelays: [],
    getStatus: async () => ({}),
    getNetworkConfig: async () => ({ relays: ['wss://cfg.example'], trial: false }),
    ...over,
  });
  it('is empty with no operator or a different device', async () => {
    expect(await resolveOperatorReported(null, MASTER)).toEqual([]);
    expect(await resolveOperatorReported(op({ deviceHex: 'b'.repeat(64) }), MASTER)).toEqual([]);
  });
  it('compares the device case-insensitively', async () => {
    expect(await resolveOperatorReported(op({ deviceHex: MASTER.toUpperCase() }), MASTER)).toEqual(['wss://cfg.example']);
  });
  it('prefers relays_live over the configured list', async () => {
    const out = await resolveOperatorReported(op({ getStatus: async () => ({ relaysLive: ['wss://live.example'] }) }), MASTER);
    expect(out).toEqual(['wss://live.example']);
  });
  it('falls back to the configured list when status has no relays_live or errors', async () => {
    expect(await resolveOperatorReported(op(), MASTER)).toEqual(['wss://cfg.example']);
    expect(await resolveOperatorReported(op({ getStatus: async () => { throw new Error('x'); } }), MASTER)).toEqual(['wss://cfg.example']);
  });
  it('skips the configured list while a trial is live', async () => {
    expect(await resolveOperatorReported(op({ getNetworkConfig: async () => ({ relays: ['wss://cfg.example'], trial: true }) }), MASTER)).toEqual([]);
  });
  it('skips silently on a delegated-operator refusal', async () => {
    const out = await resolveOperatorReported(op({
      getStatus: async () => { throw new Error('forbidden'); },
      getNetworkConfig: async () => { throw new Error('not device operator'); },
    }), MASTER);
    expect(out).toEqual([]);
  });
  it('gives up after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const never = () => new Promise<never>(() => {});
      const p = resolveOperatorReported(op({ getStatus: never, getNetworkConfig: never }), MASTER, 8000);
      await vi.advanceTimersByTimeAsync(8_100); // one shared deadline, not two in a row
      expect(await p).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});

describe('parseLink / rewriteBunkerRelays', () => {
  it('parses master and relays', () => {
    expect(parseLink(uriWith(['wss://a.example/', 'wss://b.example']))).toEqual({ master: MASTER, relays: ['wss://a.example', 'wss://b.example'] });
    expect(parseLink('nostrconnect://x')).toBeNull();
    expect(parseLink('bunker://short?relay=wss://a.example')).toBeNull();
  });
  it('changes only the relay params; secret and pubkey stay byte-identical', () => {
    const uri = uriWith(['wss://old1.example', 'wss://old2.example']);
    const out = rewriteBunkerRelays(uri, ['wss://new.example']);
    expect(out).toBe(`bunker://${MASTER}?relay=${encodeURIComponent('wss://new.example')}&secret=${encodeURIComponent(SECRET)}`);
    expect(out.split('?')[0]).toBe(`bunker://${MASTER}`);
    expect(out).toContain(`secret=${encodeURIComponent(SECRET)}`);
    expect(new URLSearchParams(out.split('?')[1]).get('secret')).toBe(SECRET);
  });
  it('keeps unknown pairs verbatim and in order', () => {
    const uri = `bunker://${MASTER}?foo=1%2B&relay=wss%3A%2F%2Fold.example&secret=a%20b&bar=`;
    expect(rewriteBunkerRelays(uri, ['wss://n.example'])).toBe(`bunker://${MASTER}?relay=wss%3A%2F%2Fn.example&foo=1%2B&secret=a%20b&bar=`);
  });
});

describe('relay params and round trip', () => {
  it('percent-encodes ! ~ * \' ( ) so the reconnect parser accepts the link', () => {
    const relay = "wss://r.example/a(b)!~*'c";
    const out = rewriteBunkerRelays(uriWith(['wss://old.example']), [relay]);
    expect(out).not.toMatch(/[!~*'()]/);
    expect(linkRoundTrips(out, MASTER, [relay])).toBe(true);
  });
  it('refuses a link the reconnect parser would reject', () => {
    expect(linkRoundTrips(`bunker://${MASTER}?relay=wss%3A%2F%2Fa.example&secret=a*b`, MASTER, ['wss://a.example'])).toBe(false);
    expect(linkRoundTrips(uriWith(['wss://a.example']), MASTER, ['wss://other.example'])).toBe(false);
    expect(linkRoundTrips(uriWith(['wss://a.example']), 'b'.repeat(64), ['wss://a.example'])).toBe(false);
  });
});

describe('composeNewRelays', () => {
  it('puts answering relays first, then old ones, deduped', () => {
    expect(composeNewRelays(['wss://n.example', 'wss://o1.example'], ['wss://o1.example', 'wss://o2.example']))
      .toEqual(['wss://n.example', 'wss://o1.example', 'wss://o2.example']);
  });
  it('caps at 5', () => {
    const answering = Array.from({ length: 4 }, (_, i) => `wss://a${i}.example`);
    const old = ['wss://o1.example', 'wss://o2.example', 'wss://o3.example'];
    expect(composeNewRelays(answering, old)).toEqual([...answering, 'wss://o1.example']);
    expect(composeNewRelays(Array.from({ length: 7 }, (_, i) => `wss://a${i}.example`), [])).toHaveLength(5);
  });
});

describe('probeRelays', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('probes every relay in parallel and keeps input order', async () => {
    const started: string[] = [];
    const resolvers: Record<string, (v: string) => void> = {};
    const probeOne = (r: string) => { started.push(r); return new Promise<string>(res => { resolvers[r] = res; }); };
    const p = probeRelays(['wss://a.example', 'wss://b.example', 'wss://c.example'], MASTER, probeOne);
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(['wss://a.example', 'wss://b.example', 'wss://c.example']);
    resolvers['wss://c.example'](MASTER);
    resolvers['wss://a.example'](MASTER.toUpperCase());
    resolvers['wss://b.example']('b'.repeat(64));
    expect(await p).toEqual(['wss://a.example', 'wss://c.example']);
  });

  it('times out a silent relay at 8 s and aborts its client', async () => {
    const signals: AbortSignal[] = [];
    const probeOne = (r: string, s: AbortSignal) => {
      signals.push(s);
      return r === 'wss://fast.example' ? Promise.resolve(MASTER) : new Promise<string>(() => {});
    };
    const p = probeRelays(['wss://fast.example', 'wss://silent.example'], MASTER, probeOne);
    await vi.advanceTimersByTimeAsync(7_900);
    expect(signals[1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toEqual(['wss://fast.example']);
    expect(signals[1].aborted).toBe(true);
  });

  it('does not count a reply with the wrong pubkey', async () => {
    expect(await probeRelays(['wss://a.example'], MASTER, async () => 'c'.repeat(64))).toEqual([]);
  });

  it('does not count a probe that rejects', async () => {
    expect(await probeRelays(['wss://a.example'], MASTER, async () => { throw new Error('closed'); })).toEqual([]);
  });

  it('aborting closes every client', async () => {
    const signals: AbortSignal[] = [];
    const ctl = new AbortController();
    const p = probeRelays(['wss://a.example', 'wss://b.example'], MASTER, (_r, s) => { signals.push(s); return new Promise<string>((_res, rej) => s.addEventListener('abort', () => rej(new Error('aborted')))); }, ctl.signal);
    await vi.advanceTimersByTimeAsync(0);
    ctl.abort();
    expect(await p).toEqual([]);
    expect(signals.every(s => s.aborted)).toBe(true);
  });
});

describe('recoverSignerLink', () => {
  const OLD = ['wss://primal.example', 'wss://trotters.example'];
  const CLIENT_SECRET = 'c'.repeat(64);
  const RAW_OLD = 'RAW-CIPHERTEXT-OLD';
  let calls: string[];
  let swaps: Array<{ expected: string; next: string }>;
  let encrypted: string[];
  let guard: RecoveryGuard;
  let key: string | null;
  let gen: number;
  let status: 'connected' | 'connecting' | 'unavailable' | null;
  let ctl: AbortController;
  let probeArgs: Array<{ secret: string; master: string }>;

  function makeIo(over: Partial<RecoverIo> = {}, answering: string[] = ['wss://ditto.example']): RecoverIo {
    return {
      signingMode: 'bunker',
      getSignerStatus: () => status,
      startKey: 'KEY1',
      currentKey: () => key,
      unlockGeneration: () => gen,
      signal: ctl.signal,
      loadPreferences: async () => ({
        rawBunkerUri: RAW_OLD,
        prefs: { bunkerUri: uriWith(OLD), relayUrl: 'wss://primal.example', relays: [{ url: 'wss://user.example', enabled: true }, { url: 'wss://off.example', enabled: false }] },
      }),
      loadClientSecret: async () => CLIENT_SECRET,
      getOperator: async () => null,
      defaultRelays: () => ['wss://ditto.example', 'wss://damus.example'],
      probeOne: (secret, master) => async (relay) => {
        probeArgs.push({ secret, master });
        calls.push(`probe:${relay}`);
        if (answering.includes(relay)) return MASTER;
        throw new Error('silent');
      },
      encryptUri: async (uri, k) => { encrypted.push(uri); return `ENC(${k}):${uri}`; },
      swapBunkerUri: async (expected, next) => { calls.push('save'); swaps.push({ expected, next }); return true; },
      reloadPreferences: async () => { calls.push('reload'); },
      retry: async () => { calls.push('retry'); },
      ...over,
    };
  }
  const written = () => (swaps[0]?.next ?? '').replace(/^ENC\(KEY1\):/, '');

  beforeEach(() => {
    calls = []; swaps = []; encrypted = []; probeArgs = []; guard = newRecoveryGuard();
    key = 'KEY1'; gen = 1; status = 'unavailable'; ctl = new AbortController();
  });

  it('writes, reloads, then retries when a relay answers', async () => {
    const out = await recoverSignerLink(makeIo(), guard);
    expect(out).toBe('recovered');
    expect(calls.filter(c => !c.startsWith('probe'))).toEqual(['save', 'reload', 'retry']);
    expect(swaps).toHaveLength(1);
    expect(swaps[0].expected).toBe(RAW_OLD);
    expect(swaps[0].next.startsWith('ENC(KEY1):')).toBe(true);
    expect(parseLink(written())?.relays).toEqual(['wss://ditto.example', 'wss://primal.example', 'wss://trotters.example']);
    expect(written()).toContain(`secret=${encodeURIComponent(SECRET)}`);
  });

  it('asks every probe with the STORED client secret and the link\'s master', async () => {
    await recoverSignerLink(makeIo(), guard);
    expect(probeArgs.length).toBeGreaterThan(0);
    expect(probeArgs.every(a => a.secret === CLIENT_SECRET && a.master === MASTER)).toBe(true);
  });

  it('probes the link, user and default relays but not disabled ones', async () => {
    await recoverSignerLink(makeIo(), guard);
    const probed = calls.filter(c => c.startsWith('probe:')).map(c => c.slice(6));
    expect(probed).toEqual(expect.arrayContaining(['wss://primal.example', 'wss://trotters.example', 'wss://user.example', 'wss://ditto.example', 'wss://damus.example']));
    expect(probed).not.toContain('wss://off.example');
  });

  it('does not write when nothing answers', async () => {
    expect(await recoverSignerLink(makeIo({}, []), guard)).toBe('none-answered');
    expect(swaps).toHaveLength(0);
    expect(calls).not.toContain('retry');
  });

  it('does not write when the relay set is unchanged, but retries once', async () => {
    expect(await recoverSignerLink(makeIo({}, OLD), guard)).toBe('unchanged');
    expect(swaps).toHaveLength(0);
    expect(calls.filter(c => c === 'retry')).toHaveLength(1);
    expect(calls).not.toContain('reload');
  });

  it('does not retry an unchanged link once the status is no longer unavailable', async () => {
    const io = makeIo({ probeOne: () => async (r) => { status = 'connected'; if (OLD.includes(r)) return MASTER; throw new Error('x'); } });
    expect(await recoverSignerLink(io, guard)).toBe('aborted');
    expect(calls).not.toContain('retry');
  });

  it('does not write when the unlock key changed mid-way', async () => {
    const io = makeIo({
      probeOne: () => async (relay) => { key = null; if (relay === 'wss://ditto.example') return MASTER; throw new Error('x'); },
    });
    expect(await recoverSignerLink(io, guard)).toBe('aborted');
    expect(swaps).toHaveLength(0);
    expect(calls).not.toContain('retry');
  });

  it('does not write or retry when the status turns connected mid-run', async () => {
    const io = makeIo({ probeOne: () => async (r) => { status = 'connected'; if (r === 'wss://ditto.example') return MASTER; throw new Error('x'); } });
    expect(await recoverSignerLink(io, guard)).toBe('aborted');
    expect(swaps).toHaveLength(0);
    expect(calls).not.toContain('retry');
  });

  it('does not write or retry when the status flips just before the save (during the encrypt)', async () => {
    const io = makeIo({ encryptUri: async (uri) => { status = 'connecting'; return uri; } });
    expect(await recoverSignerLink(io, guard)).toBe('aborted');
    expect(swaps).toHaveLength(0);
    expect(calls).not.toContain('retry');
  });

  it('does not retry when the status turns connected right after the save', async () => {
    const io = makeIo({ swapBunkerUri: async () => { calls.push('save'); status = 'connected'; return true; } });
    expect(await recoverSignerLink(io, guard)).toBe('aborted');
    expect(calls).not.toContain('retry');
  });

  it('does not write when the unlock generation moved on (lock then unlock)', async () => {
    const io = makeIo({ probeOne: () => async (r) => { gen++; if (r === 'wss://ditto.example') return MASTER; throw new Error('x'); } });
    expect(await recoverSignerLink(io, guard)).toBe('aborted');
    expect(swaps).toHaveLength(0);
    expect(calls).not.toContain('retry');
  });

  it('does not retry when locked right after the save', async () => {
    const io = makeIo({ swapBunkerUri: async () => { calls.push('save'); key = null; return true; } });
    expect(await recoverSignerLink(io, guard)).toBe('aborted');
    expect(calls).not.toContain('retry');
  });

  it('does not reload or retry when the compare-and-swap refuses (re-paired, disconnected)', async () => {
    const io = makeIo({ swapBunkerUri: async () => { calls.push('save'); return false; } });
    expect(await recoverSignerLink(io, guard)).toBe('aborted');
    expect(calls).not.toContain('reload');
    expect(calls).not.toContain('retry');
  });

  it('does not write after an abort', async () => {
    const io = makeIo({ probeOne: () => async (r) => { ctl.abort(); return r === 'wss://ditto.example' ? MASTER : (() => { throw new Error('x'); })(); } });
    expect(await recoverSignerLink(io, guard)).toBe('aborted');
    expect(swaps).toHaveLength(0);
  });

  it('does not write a link the reconnect parser would reject', async () => {
    const io = makeIo({ loadPreferences: async () => ({ rawBunkerUri: RAW_OLD, prefs: { bunkerUri: `bunker://${MASTER}?relay=${encodeURIComponent(OLD[0])}&secret=a*b` } }) });
    expect(await recoverSignerLink(io, guard)).toBe('unusable');
    expect(swaps).toHaveLength(0);
  });

  it('starts the non-operator probes at once, while the operator read is still pending', async () => {
    let releaseOp: (o: OperatorChannel | null) => void = () => {};
    const io = makeIo({ getOperator: () => new Promise(r => { releaseOp = r; }) });
    const run = recoverSignerLink(io, guard);
    await vi.waitFor(() => expect(calls.filter(c => c.startsWith('probe:')).length).toBeGreaterThanOrEqual(4));
    expect(calls).not.toContain('save');
    releaseOp(null);
    expect(await run).toBe('recovered');
  });

  it('probes operator-reported relays that arrive later, not the ones already probed', async () => {
    const op: OperatorChannel = {
      deviceHex: MASTER, credentialRelays: [],
      getStatus: async () => ({ relaysLive: ['wss://live.example', 'wss://ditto.example'] }),
      getNetworkConfig: async () => ({ relays: [], trial: false }),
    };
    const out = await recoverSignerLink(makeIo({ getOperator: async () => op }, ['wss://live.example']), guard);
    expect(out).toBe('recovered');
    const probed = calls.filter(c => c.startsWith('probe:')).map(c => c.slice(6));
    expect(probed.filter(r => r === 'wss://ditto.example')).toHaveLength(1);
    expect(probed).toContain('wss://live.example');
    expect(parseLink(written())?.relays[0]).toBe('wss://live.example');
  });

  it('uses the operator credential relays only when the operator device is the link master', async () => {
    const op = (deviceHex: string): OperatorChannel => ({
      deviceHex, credentialRelays: ['wss://cred.example'],
      getStatus: async () => ({ relaysLive: ['wss://live.example'] }),
      getNetworkConfig: async () => ({ relays: ['wss://cfg.example'], trial: false }),
    });
    await recoverSignerLink(makeIo({ getOperator: async () => op('b'.repeat(64)) }, []), guard);
    let probed = calls.filter(c => c.startsWith('probe:')).map(c => c.slice(6));
    expect(probed).not.toContain('wss://cred.example');
    expect(probed).not.toContain('wss://live.example');
    expect(probed).not.toContain('wss://cfg.example');
    calls.length = 0; guard = newRecoveryGuard();
    await recoverSignerLink(makeIo({ getOperator: async () => op(MASTER) }, []), guard);
    probed = calls.filter(c => c.startsWith('probe:')).map(c => c.slice(6));
    expect(probed).toEqual(expect.arrayContaining(['wss://cred.example', 'wss://live.example']));
  });

  it('uses an operator-reported relay when the device matches', async () => {
    const op: OperatorChannel = {
      deviceHex: MASTER, credentialRelays: [],
      getStatus: async () => ({ relaysLive: ['wss://live.example'] }),
      getNetworkConfig: async () => ({ relays: [], trial: false }),
    };
    const out = await recoverSignerLink(makeIo({ getOperator: async () => op }, ['wss://live.example']), guard);
    expect(out).toBe('recovered');
    expect(parseLink(written())?.relays[0]).toBe('wss://live.example');
  });

  it.each(['paired-child', 'local', 'nip07', undefined])('never runs for signing mode %s', async (mode) => {
    expect(await recoverSignerLink(makeIo({ signingMode: mode }), guard)).toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('never runs unless the signer is unavailable and the app is unlocked', async () => {
    status = 'connecting';
    expect(await recoverSignerLink(makeIo(), guard)).toBe('skipped');
    status = 'connected';
    expect(await recoverSignerLink(makeIo(), guard)).toBe('skipped');
    status = 'unavailable';
    expect(await recoverSignerLink(makeIo({ startKey: null }), guard)).toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('skips a stored link that is not bunker://', async () => {
    const io = makeIo({ loadPreferences: async () => ({ rawBunkerUri: RAW_OLD, prefs: { bunkerUri: 'nostrconnect://x' } }) });
    expect(await recoverSignerLink(io, guard)).toBe('no-link');
    expect(calls).toEqual([]);
  });

  it('runs once per unlock and is re-armed by a manual retry', async () => {
    expect(await recoverSignerLink(makeIo({}, []), guard)).toBe('none-answered');
    const before = calls.length;
    expect(await recoverSignerLink(makeIo({}, []), guard)).toBe('skipped');
    expect(calls.length).toBe(before);
    guard.done = false; // what the banner's Retry does
    expect(await recoverSignerLink(makeIo({}, []), guard)).toBe('none-answered');
  });

  it('tells the caller when a real run starts and ends, not for a skip', async () => {
    const seen: boolean[] = [];
    await recoverSignerLink(makeIo({ signingMode: 'local', onRunning: v => seen.push(v) }), guard);
    expect(seen).toEqual([]);
    await recoverSignerLink(makeIo({ onRunning: v => seen.push(v) }, []), guard);
    expect(seen).toEqual([true, false]);
  });

  it('never runs two at once, including through its own retry', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const first = recoverSignerLink(makeIo({ retry: async () => { calls.push('retry'); await gate; } }), guard);
    await vi.waitFor(() => expect(calls).toContain('retry'));
    expect(guard.running).toBe(true);
    expect(await recoverSignerLink(makeIo(), guard)).toBe('skipped');
    release();
    expect(await first).toBe('recovered');
    expect(guard.running).toBe(false);
  });
});
