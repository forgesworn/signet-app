import { describe, it, expect, vi } from 'vitest';
import {
  parseHeartwoodCapabilities,
  buildSlotBunkerUri,
  RoutedBunkerSigningBackend,
  BunkerBackendRouter,
  resolveNpBunkerBackend,
  resolveSlotBunkerBackend,
  resolveServerTransportBackend,
  createRouterWithRetry,
  routedSignerUnavailableMessage,
  MAX_ERROR_REPLIES,
  MAX_CONSECUTIVE_TIMEOUTS,
  classifyProbeError,
} from './bunker-router';
import type { RouterProbeState } from './bunker-router';
import type { BunkerSigningBackend } from './signing-backend';
import { BunkerRequestTimeoutError } from './signing-backend';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const BASE_URI = `bunker://${PK_A}?relay=wss%3A%2F%2Frelay.example.com&secret=shh`;
const SECRET = '1'.repeat(64);

/** Minimal fake standing in for a connected BunkerSigningBackend. */
function fakeInner(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    activePublicKeyHex: '',
    bunkerUri: '',
    reconnect: vi.fn(async function (this: { activePublicKeyHex: string }, _uri: string, _t?: number, expected?: string) {
      (this as { activePublicKeyHex: string }).activePublicKeyHex = expected ?? PK_B;
    }),
    signEvent: vi.fn(async (ev: { kind: number }) => ({ ...ev, id: 'x', sig: 'y', pubkey: PK_B })),
    nip44Encrypt: vi.fn(async () => 'ct'),
    nip44Decrypt: vi.fn(async () => 'pt'),
    nip04Encrypt: vi.fn(async () => 'ct4'),
    nip04Decrypt: vi.fn(async () => 'pt4'),
    request: vi.fn(async () => JSON.stringify({ version: 1, methods: ['sign_event', 'heartwood_capabilities'] })),
    destroy: vi.fn(),
    ...overrides,
  } as unknown as BunkerSigningBackend;
}

describe('parseHeartwoodCapabilities', () => {
  it('parses a valid capabilities payload', () => {
    const caps = parseHeartwoodCapabilities('{"version":1,"methods":["sign_event","heartwood_derive_persona"]}');
    expect(caps).toEqual({ version: 1, methods: ['sign_event', 'heartwood_derive_persona'] });
  });

  it('rejects malformed JSON', () => {
    expect(parseHeartwoodCapabilities('not json')).toBeNull();
  });

  it('rejects wrong shapes', () => {
    expect(parseHeartwoodCapabilities('{"version":"1","methods":[]}')).toBeNull();
    expect(parseHeartwoodCapabilities('{"version":1}')).toBeNull();
    expect(parseHeartwoodCapabilities('{"version":1,"methods":[42]}')).toBeNull();
    expect(parseHeartwoodCapabilities('null')).toBeNull();
    expect(parseHeartwoodCapabilities('[]')).toBeNull();
  });
});

describe('buildSlotBunkerUri', () => {
  it('swaps the pubkey, keeps relays, drops the secret', () => {
    const uri = buildSlotBunkerUri(BASE_URI, PK_B);
    expect(uri).toContain(`bunker://${PK_B}`);
    expect(uri).toContain('relay=wss%3A%2F%2Frelay.example.com');
    expect(uri).not.toContain('secret');
  });

  it('normalises the slot pubkey to lowercase', () => {
    const uri = buildSlotBunkerUri(BASE_URI, PK_B.toUpperCase());
    expect(uri).toContain(`bunker://${PK_B}`);
  });

  it('rejects invalid inputs', () => {
    expect(() => buildSlotBunkerUri(BASE_URI, 'nothex')).toThrow();
    expect(() => buildSlotBunkerUri('https://evil.example/?x=1', PK_B)).toThrow();
    expect(() => buildSlotBunkerUri('bunker://tooshort?relay=wss%3A%2F%2Fr', PK_B)).toThrow();
  });
});

describe('RoutedBunkerSigningBackend', () => {
  it('exposes the slot pubkey before connecting and connects lazily on first use', async () => {
    const inner = fakeInner();
    const backend = new RoutedBunkerSigningBackend(SECRET, buildSlotBunkerUri(BASE_URI, PK_B), PK_B, () => inner);
    expect(backend.activePublicKeyHex).toBe(PK_B);
    expect(inner.reconnect).not.toHaveBeenCalled();
    await backend.nip44Encrypt(PK_A, 'hello');
    expect(inner.reconnect).toHaveBeenCalledTimes(1);
    const call = (inner.reconnect as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain(`bunker://${PK_B}`);
    expect(call[2]).toBe(PK_B); // expectedPubkey pin
    expect(call[3]).toBe(false); // no connect handshake re-send
  });

  it('connects only once across concurrent calls', async () => {
    const inner = fakeInner();
    const backend = new RoutedBunkerSigningBackend(SECRET, buildSlotBunkerUri(BASE_URI, PK_B), PK_B, () => inner);
    await Promise.all([backend.nip44Encrypt(PK_A, 'a'), backend.nip44Decrypt(PK_A, 'b')]);
    expect(inner.reconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects signEvent templates addressed to a different pubkey without connecting', async () => {
    const inner = fakeInner();
    const backend = new RoutedBunkerSigningBackend(SECRET, buildSlotBunkerUri(BASE_URI, PK_B), PK_B, () => inner);
    await expect(
      backend.signEvent({ kind: 1, created_at: 1, tags: [], content: '', pubkey: PK_A }),
    ).rejects.toThrow('Cannot sign event for a different pubkey.');
    expect(inner.reconnect).not.toHaveBeenCalled();
  });

  it('retries the connection after a failed connect', async () => {
    const inner = fakeInner({
      reconnect: vi.fn()
        .mockRejectedValueOnce(new Error('relay down'))
        .mockResolvedValueOnce(undefined),
    });
    const backend = new RoutedBunkerSigningBackend(SECRET, buildSlotBunkerUri(BASE_URI, PK_B), PK_B, () => inner);
    await expect(backend.nip44Encrypt(PK_A, 'x')).rejects.toThrow('relay down');
    await backend.nip44Encrypt(PK_A, 'x');
    expect(inner.reconnect).toHaveBeenCalledTimes(2);
  });

  it('destroy() tears down the inner backend and refuses further use', async () => {
    const inner = fakeInner();
    const backend = new RoutedBunkerSigningBackend(SECRET, buildSlotBunkerUri(BASE_URI, PK_B), PK_B, () => inner);
    await backend.nip44Encrypt(PK_A, 'x');
    backend.destroy();
    expect(inner.destroy).toHaveBeenCalled();
    await expect(backend.nip44Encrypt(PK_A, 'x')).rejects.toThrow();
  });
});

describe('BunkerBackendRouter', () => {
  function connectedPrimary(overrides: Partial<Record<string, unknown>> = {}) {
    return fakeInner({ activePublicKeyHex: PK_A, bunkerUri: BASE_URI, ...overrides });
  }

  it('create() probes capabilities and returns a router for a Heartwood signer', async () => {
    const primary = connectedPrimary();
    const router = await BunkerBackendRouter.create(primary, SECRET);
    expect(router).not.toBeNull();
    expect(router!.capabilities.methods).toContain('sign_event');
    expect((primary.request as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('heartwood_capabilities');
  });

  it('create() returns null when the signer is not a Heartwood (probe throws)', async () => {
    const primary = connectedPrimary({ request: vi.fn(async () => { throw new Error('unknown method'); }) });
    expect(await BunkerBackendRouter.create(primary, SECRET)).toBeNull();
  });

  it('create() returns null when the payload is malformed', async () => {
    const primary = connectedPrimary({ request: vi.fn(async () => 'garbage') });
    expect(await BunkerBackendRouter.create(primary, SECRET)).toBeNull();
  });

  it('backendFor() returns the primary for its own pubkey', async () => {
    const primary = connectedPrimary();
    const router = (await BunkerBackendRouter.create(primary, SECRET))!;
    expect(router.backendFor(PK_A)).toBe(primary);
    expect(router.backendFor(PK_A.toUpperCase())).toBe(primary);
  });

  it('backendFor() returns one cached route per slot pubkey', async () => {
    const router = (await BunkerBackendRouter.create(connectedPrimary(), SECRET))!;
    const a = router.backendFor(PK_B);
    const b = router.backendFor(PK_B);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(a!.activePublicKeyHex).toBe(PK_B);
  });

  it('backendFor() fails soft on empty/invalid pubkeys', async () => {
    const router = (await BunkerBackendRouter.create(connectedPrimary(), SECRET))!;
    expect(router.backendFor('')).toBeNull();
    expect(router.backendFor(undefined)).toBeNull();
    expect(router.backendFor('nothex')).toBeNull();
  });

  it('destroy() destroys routes but not the primary, and disables backendFor', async () => {
    const primary = connectedPrimary();
    const makeBackend = vi.fn(() => fakeInner());
    const router = (await BunkerBackendRouter.create(primary, SECRET, makeBackend as never))!;
    const route = router.backendFor(PK_B)!;
    await route.nip44Encrypt(PK_A, 'x'); // force the lazy connect so there is something to destroy
    router.destroy();
    expect(primary.destroy).not.toHaveBeenCalled();
    expect(router.backendFor(PK_B)).toBeNull();
    await expect(route.nip44Encrypt(PK_A, 'x')).rejects.toThrow();
  });

  it('backendFor() self-heals: after a caller destroys the route it handed out, the next call for the same pubkey gets a fresh usable instance', async () => {
    const primary = connectedPrimary();
    const makeBackend = vi.fn(() => fakeInner());
    const router = (await BunkerBackendRouter.create(primary, SECRET, makeBackend as never))!;

    const first = router.backendFor(PK_B) as RoutedBunkerSigningBackend;
    await first.nip44Encrypt(PK_A, 'x'); // force lazy connect
    // Simulate App.tsx's backend-creation effect teardown destroying the
    // route it was handed (on lock / dependant switch) while the router
    // itself is still alive.
    first.destroy();
    expect(first.isDestroyed).toBe(true);

    const second = router.backendFor(PK_B) as RoutedBunkerSigningBackend;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second.isDestroyed).toBe(false);
    expect(second.activePublicKeyHex).toBe(PK_B);

    // Router itself must not be affected — still usable.
    await expect(second.nip44Encrypt(PK_A, 'y')).resolves.toBe('ct');
  });

  it('backendFor() self-heal: the recreated route lazily reconnects again on next use', async () => {
    const primary = connectedPrimary();
    const makeBackend = vi.fn(() => fakeInner());
    const router = (await BunkerBackendRouter.create(primary, SECRET, makeBackend as never))!;

    const first = router.backendFor(PK_B) as RoutedBunkerSigningBackend;
    await first.nip44Encrypt(PK_A, 'x');
    first.destroy();

    const second = router.backendFor(PK_B) as RoutedBunkerSigningBackend;
    // Fresh route hasn't connected yet.
    expect(makeBackend).toHaveBeenCalledTimes(1); // only the first route's inner so far
    await second.nip44Encrypt(PK_A, 'z');
    expect(makeBackend).toHaveBeenCalledTimes(2); // second route made its own inner and reconnected
  });
});

describe('resolveNpBunkerBackend', () => {
  function connectedPrimary(pk: string) {
    return fakeInner({ activePublicKeyHex: pk, bunkerUri: BASE_URI });
  }

  it('returns null when no bunker is connected', () => {
    expect(resolveNpBunkerBackend(null, null, PK_A)).toBeNull();
  });

  it('returns null before the primary has connected (no pubkey yet) — nothing may queue requests at an unknown identity', () => {
    const primary = fakeInner({ activePublicKeyHex: '' });
    expect(resolveNpBunkerBackend(primary, null, PK_A)).toBeNull();
    expect(resolveNpBunkerBackend(primary, null, undefined)).toBeNull();
  });

  it('returns the primary when it is bound to the NP itself (legacy NP-only bunker / paired-child)', () => {
    const primary = connectedPrimary(PK_A);
    expect(resolveNpBunkerBackend(primary, null, PK_A)).toBe(primary);
    expect(resolveNpBunkerBackend(primary, null, PK_A.toUpperCase())).toBe(primary);
  });

  it('returns null when the NP pubkey is unknown — never the (possibly master-bound) primary', () => {
    const primary = connectedPrimary(PK_A);
    expect(resolveNpBunkerBackend(primary, null, undefined)).toBeNull();
    expect(resolveNpBunkerBackend(primary, null, '')).toBeNull();
  });

  it('NEVER hands out a master-bound primary for a different NP when there is no router', () => {
    // Family bunker: primary bound to master (PK_A), NP is derived (PK_B),
    // router probe pending or failed. Signing NP as master is that bug.
    const primary = connectedPrimary(PK_A);
    expect(resolveNpBunkerBackend(primary, null, PK_B)).toBeNull();
  });

  it('routes to the NP slot via the router when the primary is master-bound', async () => {
    const primary = connectedPrimary(PK_A);
    const router = (await BunkerBackendRouter.create(primary, SECRET))!;
    const np = resolveNpBunkerBackend(primary, router, PK_B);
    expect(np).not.toBeNull();
    expect(np).not.toBe(primary);
    expect(np!.activePublicKeyHex).toBe(PK_B);
    expect(np).toBe(router.backendFor(PK_B)); // the cached route, not a fresh one
  });

  it('collapses to the primary via the router when NP == master', async () => {
    const primary = connectedPrimary(PK_A);
    const router = (await BunkerBackendRouter.create(primary, SECRET))!;
    expect(resolveNpBunkerBackend(primary, router, PK_A)).toBe(primary);
  });

  it('returns null (not the master) when the router is destroyed', async () => {
    const primary = connectedPrimary(PK_A);
    const router = (await BunkerBackendRouter.create(primary, SECRET))!;
    router.destroy();
    expect(resolveNpBunkerBackend(primary, router, PK_B)).toBeNull();
  });
});

describe('resolveSlotBunkerBackend', () => {
  const connectedPrimary = (pk: string) => fakeInner({ activePublicKeyHex: pk, bunkerUri: BASE_URI });

  it('returns the primary when the pairing is bound to the requested slot', () => {
    const primary = connectedPrimary(PK_B);
    expect(resolveSlotBunkerBackend(primary, null, PK_B)).toBe(primary);
  });

  it('routes through the router when the pairing is bound to a different slot', async () => {
    const primary = connectedPrimary(PK_A);
    const router = (await BunkerBackendRouter.create(primary, SECRET))!;
    const routed = resolveSlotBunkerBackend(primary, router, PK_B);
    expect(routed).not.toBeNull();
    expect(routed).not.toBe(primary);
    expect(routed!.activePublicKeyHex).toBe(PK_B);
  });

  it('returns null rather than the master when there is no route', () => {
    const primary = connectedPrimary(PK_A);
    expect(resolveSlotBunkerBackend(primary, null, PK_B)).toBeNull();
  });

  it('returns null while the primary has not connected', () => {
    expect(resolveSlotBunkerBackend(fakeInner({ activePublicKeyHex: '' }), null, PK_B)).toBeNull();
  });

  it('returns null — NOT the master — for a slot with no pubkey', () => {
    // Reachable: an nsec-imported / NIP-07 identity and a paired-child stub all
    // carry `persona.publicKey === ''`. Collapsing that onto a master-bound
    // primary would hand out the never-shown tree root.
    const primary = connectedPrimary(PK_A);
    expect(resolveSlotBunkerBackend(primary, null, '')).toBeNull();
    expect(resolveSlotBunkerBackend(primary, null, undefined)).toBeNull();
    expect(resolveSlotBunkerBackend(primary, null, '   ')).toBeNull();
  });

  it('returns null for a slot with no pubkey even when a router is available', async () => {
    const primary = connectedPrimary(PK_A);
    const router = (await BunkerBackendRouter.create(primary, SECRET))!;
    expect(resolveSlotBunkerBackend(primary, router, '')).toBeNull();
  });
});

describe('resolveServerTransportBackend', () => {
  const slot = (pubkey: string) => fakeInner({ activePublicKeyHex: pubkey });
  const local = { naturalPerson: slot(PK_A), persona: slot(PK_B) };

  it('serves the persona backend for a persona-primary identity', () => {
    const result = resolveServerTransportBackend({
      primaryKeypair: 'persona',
      npBunkerBackend: null, personaBunkerBackend: null, nip07Backend: null,
      localNaturalPerson: local.naturalPerson, localPersona: local.persona,
    });
    expect(result).toBe(local.persona);
  });

  it('serves the natural-person backend for a natural-person-primary identity', () => {
    const result = resolveServerTransportBackend({
      primaryKeypair: 'natural-person',
      npBunkerBackend: null, personaBunkerBackend: null, nip07Backend: null,
      localNaturalPerson: local.naturalPerson, localPersona: local.persona,
    });
    expect(result).toBe(local.naturalPerson);
  });

  it('prefers the routed device backend for the primary slot over the local key', () => {
    const routedPersona = slot(PK_B);
    const result = resolveServerTransportBackend({
      primaryKeypair: 'persona',
      npBunkerBackend: null, personaBunkerBackend: routedPersona, nip07Backend: null,
      localNaturalPerson: local.naturalPerson, localPersona: local.persona,
    });
    expect(result).toBe(routedPersona);
  });

  it('prefers the routed device backend on the NP branch too', () => {
    const routedNp = slot(PK_A);
    const result = resolveServerTransportBackend({
      primaryKeypair: 'natural-person',
      npBunkerBackend: routedNp, personaBunkerBackend: null, nip07Backend: null,
      localNaturalPerson: local.naturalPerson, localPersona: local.persona,
    });
    expect(result).toBe(routedNp);
  });

  it('uses a NIP-07 extension only when it holds the primary slot key', () => {
    const ext = slot(PK_B);
    expect(resolveServerTransportBackend({
      primaryKeypair: 'persona',
      npBunkerBackend: null, personaBunkerBackend: null, nip07Backend: ext,
      localNaturalPerson: null, localPersona: null,
    })).toBe(ext);

    expect(resolveServerTransportBackend({
      primaryKeypair: 'natural-person',
      npBunkerBackend: null, personaBunkerBackend: null, nip07Backend: ext,
      localNaturalPerson: local.naturalPerson, localPersona: null,
    })).toBe(local.naturalPerson);
  });

  it('never falls back across slots — a persona primary is never served by the NP key', () => {
    const result = resolveServerTransportBackend({
      primaryKeypair: 'persona',
      npBunkerBackend: slot(PK_A), personaBunkerBackend: null, nip07Backend: null,
      localNaturalPerson: local.naturalPerson, localPersona: null,
    });
    expect(result).toBeNull();
  });

  it('returns null when nothing can serve the primary slot', () => {
    expect(resolveServerTransportBackend({
      primaryKeypair: 'persona',
      npBunkerBackend: null, personaBunkerBackend: null, nip07Backend: null,
      localNaturalPerson: null, localPersona: null,
    })).toBeNull();
  });
});

describe('createRouterWithRetry', () => {
  /** A request the signer never answers: rejects the way BunkerSigningBackend's own timeout does. */
  const lost = (_m?: string, _p?: string[], t = 5) =>
    new Promise<string>((_, rej) => setTimeout(() => rej(new BunkerRequestTimeoutError('heartwood_capabilities')), t));
  const CAPS = JSON.stringify({ version: 1, methods: ['sign_event', 'heartwood_capabilities'] });
  function primaryWith(request: ReturnType<typeof vi.fn>) {
    return fakeInner({ activePublicKeyHex: PK_A, bunkerUri: BASE_URI, request });
  }
  function harness(request: ReturnType<typeof vi.fn>, extra: { isCurrent?: () => boolean } = {}) {
    const primary = primaryWith(request);
    const states: RouterProbeState[] = [];
    const sleeps: number[] = [];
    const run = createRouterWithRetry({
      primary, clientSecretHex: SECRET,
      isCurrent: extra.isCurrent ?? (() => true),
      onState: (s) => states.push(s),
      backoffMs: [10, 20, 40],
      sleep: async (ms) => { sleeps.push(ms); },
      timeoutMs: 5,
    });
    return { primary, states, sleeps, run };
  }

  it('returns a router on the first answer and reports probing → ready', async () => {
    const h = harness(vi.fn(async () => CAPS));
    expect(await h.run).not.toBeNull();
    expect(h.states).toEqual(['probing', 'ready']);
    expect(h.sleeps).toEqual([]);
  });

  it('retries a probe that never answers (timeout), with backoff, until the signer answers', async () => {
    let n = 0;
    const request = vi.fn((m: string, pr: string[], t?: number) => (++n <= 4 ? lost(m, pr, t) : Promise.resolve(CAPS)));
    const h = harness(request);
    const router = await h.run;
    expect(router).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(5);
    // Backoff grows, then holds at the last step.
    expect(h.sleeps).toEqual([10, 20, 40, 40]);
    expect(h.states).toEqual(['probing', 'retrying', 'retrying', 'retrying', 'retrying', 'ready']);
  });

  it('retries "not connected" failures (primary mid-reconnect) rather than giving up', async () => {
    let n = 0;
    const request = vi.fn(async () => { if (++n === 1) throw new Error('Not connected to bunker'); return CAPS; });
    const h = harness(request);
    expect(await h.run).not.toBeNull();
    expect(h.states).toEqual(['probing', 'retrying', 'ready']);
  });

  it('treats repeated error replies as "not a Heartwood" and stops', async () => {
    // nostr-tools BunkerSigner rejects with the reply's `error` string, not an Error.
    const request = vi.fn(() => Promise.reject('unknown method'));
    const h = harness(request);
    expect(await h.run).toBeNull();
    expect(request).toHaveBeenCalledTimes(MAX_ERROR_REPLIES);
    expect(h.states[h.states.length - 1]).toBe('unsupported');
  });

  it('a single transient error reply does not end routing', async () => {
    let n = 0;
    const request = vi.fn(() => (++n === 1 ? Promise.reject('busy') : Promise.resolve(CAPS)));
    const h = harness(request);
    expect(await h.run).not.toBeNull();
  });

  it('a well-formed answer without sign_event is unsupported at once (no retry)', async () => {
    const request = vi.fn(async () => JSON.stringify({ version: 1, methods: ['ping'] }));
    const h = harness(request);
    expect(await h.run).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(h.states).toEqual(['probing', 'unsupported']);
  });

  it('stops retrying once the primary is destroyed (pubkey cleared)', async () => {
    const request = vi.fn(function (this: { activePublicKeyHex: string }) {
      this.activePublicKeyHex = ''; // App destroyed the primary while the probe was out
      return lost();
    });
    const h = harness(request);
    expect(await h.run).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it('transport failures (relay publish AggregateError, "not open") never count as "not a Heartwood"', async () => {
    let n = 0;
    const request = vi.fn(() => {
      n++;
      if (n <= 6) {
        return Promise.reject(n % 2
          ? new AggregateError([new Error('publish timed out')], 'All promises were rejected')
          : new Error('this signer is not open anymore, create a new one'));
      }
      return Promise.resolve(CAPS);
    });
    const h = harness(request);
    expect(await h.run).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(7);
    expect(h.states).not.toContain('unsupported');
  });

  it('a signer that never answers settles to unsupported after the timeout cap (no endless probing)', async () => {
    const request = vi.fn((m: string, pr: string[], t?: number) => lost(m, pr, t));
    const h = harness(request);
    expect(await h.run).toBeNull();
    expect(request).toHaveBeenCalledTimes(MAX_CONSECUTIVE_TIMEOUTS);
    expect(h.states[h.states.length - 1]).toBe('unsupported');
  });

  it('the timeout cap counts CONSECUTIVE timeouts only', async () => {
    let n = 0;
    const request = vi.fn((m: string, pr: string[], t?: number) => {
      n++;
      if (n === MAX_CONSECUTIVE_TIMEOUTS) return Promise.reject(new Error('relay down'));
      if (n < 2 * MAX_CONSECUTIVE_TIMEOUTS) return lost(m, pr, t);
      return Promise.resolve(CAPS);
    });
    const h = harness(request);
    expect(await h.run).not.toBeNull();
  });

  it('generation guard: a superseded probe destroys the router it built and reports nothing further', async () => {
    let current = true;
    const request = vi.fn(async () => { current = false; return CAPS; });
    const h = harness(request, { isCurrent: () => current });
    expect(await h.run).toBeNull();
    expect(h.states).toEqual(['probing']);
  });

  it('generation guard: a superseded probe stops retrying', async () => {
    let current = true;
    const request = vi.fn(() => lost());
    const primary = primaryWith(request);
    const run = createRouterWithRetry({
      primary, clientSecretHex: SECRET, isCurrent: () => current,
      backoffMs: [10], sleep: async () => { current = false; }, timeoutMs: 5,
    });
    expect(await run).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('routedSignerUnavailableMessage', () => {
  const base = { unlocked: true, signingMode: 'bunker', signerStatus: 'connected' as const, routerProbeState: null };
  it('locked: asks for unlock, never "connect a signer"', () => {
    const m = routedSignerUnavailableMessage({ ...base, unlocked: false });
    expect(m).toMatch(/Unlock/);
    expect(m).not.toMatch(/Connect a signer/);
  });
  it('connected but probe retrying: says so', () => {
    expect(routedSignerUnavailableMessage({ ...base, routerProbeState: 'retrying' })).toMatch(/Retrying/);
  });
  it('signer unreachable', () => {
    expect(routedSignerUnavailableMessage({ ...base, signerStatus: 'unavailable' })).toMatch(/not reachable/);
  });
  it('non-Heartwood signer', () => {
    expect(routedSignerUnavailableMessage({ ...base, routerProbeState: 'unsupported' })).toMatch(/Heartwood/);
  });
  it('no signer at all keeps the original copy', () => {
    expect(routedSignerUnavailableMessage({ ...base, signingMode: undefined, signerStatus: null })).toMatch(/no local signing key/);
  });  describe('paired-child: names the family signer, never asks the child to connect one', () => {
    const kid = { ...base, signingMode: 'paired-child' };
    const all = [
      routedSignerUnavailableMessage({ ...kid, signerStatus: 'connecting' }),
      routedSignerUnavailableMessage({ ...kid, signerStatus: 'unavailable' }),
      routedSignerUnavailableMessage({ ...kid, routerProbeState: 'retrying' }),
      routedSignerUnavailableMessage({ ...kid, routerProbeState: 'unsupported' }),
      routedSignerUnavailableMessage({ ...kid, routerProbeState: 'ready' }),
    ];
    it('every state has family-signer copy', () => {
      for (const m of all) {
        expect(m).toMatch(/family signer|guardian's device/);
        expect(m).not.toMatch(/Connect a signer|Heartwood/);
      }
    });
    it('unreachable says where the keys live', () => {
      expect(all[1]).toMatch(/guardian's device/);
    });
    it('unsupported points to the guardian', () => {
      expect(all[3]).toMatch(/guardian/);
    });
    it('locked still asks for the unlock', () => {
      expect(routedSignerUnavailableMessage({ ...kid, unlocked: false })).toMatch(/Unlock/);
    });
  });
});

describe('classifyProbeError', () => {
  it('only a string (the signer\'s own error reply) is an error-reply', () => {
    expect(classifyProbeError('unknown method')).toEqual({ kind: 'error-reply' });
    expect(classifyProbeError(new Error('unknown method'))).toEqual({ kind: 'transient', reason: 'transport' });
    expect(classifyProbeError(new AggregateError([], 'x'))).toEqual({ kind: 'transient', reason: 'transport' });
    expect(classifyProbeError(new BunkerRequestTimeoutError('m'))).toEqual({ kind: 'transient', reason: 'timeout' });
  });
});
