import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handoffPolicy } from './heartwood-handoff';
import { BunkerRequestTimeoutError } from './signing-backend';
import {
  SITE_LINK_BUSY_COPY,
  SITE_LINK_CREATE,
  SITE_LINK_CREATE_TIMEOUT_MS,
  SITE_LINK_LOST_COPY,
  SITE_LINK_NO_ANSWER_COPY,
  SITE_LINK_REVOKE,
  SITE_LINK_STATUS,
  SITE_LINK_TOO_OLD_COPY,
  SITE_LINK_UNCERTAIN_REVOKE_COPY,
  SiteLinkLock,
  SiteLinkRefusedError,
  SiteLinkUncertainError,
  createSiteLinkOnDevice,
  deviceErrorText,
  isSiteLinkLabel,
  mintSiteLinkUnderLock,
  parseSiteLinkCreateReply,
  parseSiteLinkRevoke,
  parseSiteLinkStatus,
  revokeSiteLinkOnDevice,
  signInLinkDeviceErrorCopy,
  signInLinkHoldCopy,
  siteLinkCreateParams,
  siteLinkDeadline,
  siteLinkStatusOnDevice,
  siteLinkTargetParams,
  supportsSiteLinks,
  type SiteLinkCreateArgs,
} from './heartwood-site-link';

const PERSONA = 'b'.repeat(64);
const LABEL = 'mysignet:kithmoot.com:cafef00d';
const POLICY = handoffPolicy(PERSONA);
const T0 = 1_900_000_000_000;

function goodReplyJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    slot_index: 7, label: LABEL, secret: '9'.repeat(64), secret_fingerprint: 'ABCD', npub_hex: PERSONA,
    bunker_uri: `bunker://${PERSONA}?relay=wss%3A%2F%2Frelay.example&secret=${'9'.repeat(64)}`,
    allowed_methods: [...POLICY.allowedMethods].sort(), allowed_kinds: [], auto_approve: true,
    signing_approved: false, policy_version: 2, ...over,
  });
}

describe('supportsSiteLinks', () => {
  it('needs all three link methods', () => {
    expect(supportsSiteLinks([SITE_LINK_CREATE, SITE_LINK_STATUS, SITE_LINK_REVOKE])).toBe(true);
    expect(supportsSiteLinks([SITE_LINK_CREATE, SITE_LINK_STATUS])).toBe(false);
    expect(supportsSiteLinks(null)).toBe(false);
    expect(supportsSiteLinks(undefined)).toBe(false);
  });
});

describe('wire params', () => {
  it('create: one JSON string, lowercase identity, and only the three policy keys', () => {
    const raw = siteLinkCreateParams({ identity: PERSONA.toUpperCase(), label: LABEL, policy: POLICY });
    expect(typeof raw).toBe('string');
    expect(JSON.parse(raw)).toEqual({
      identity: PERSONA,
      label: LABEL,
      policy: { allowed_methods: ['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt'], allowed_kinds: [], auto_approve: true },
    });
    expect(raw).not.toMatch(/escalate|petition|audit|bound/);
    // Built the same way twice, byte for byte.
    expect(siteLinkCreateParams({ identity: PERSONA, label: LABEL, policy: POLICY })).toBe(raw);
  });
  it('create: refuses a label the device would refuse, and a bad identity', () => {
    expect(isSiteLinkLabel(LABEL)).toBe(true);
    expect(isSiteLinkLabel('x'.repeat(65))).toBe(false);
    expect(isSiteLinkLabel('mysignet:bücher.de:00000000')).toBe(false);
    expect(isSiteLinkLabel('')).toBe(false);
    expect(() => siteLinkCreateParams({ identity: PERSONA, label: 'é', policy: POLICY })).toThrow();
    expect(() => siteLinkCreateParams({ identity: 'xyz', label: LABEL, policy: POLICY })).toThrow();
  });
  it('status / revoke: by fingerprint, or by label (exactly one form)', () => {
    expect(JSON.parse(siteLinkTargetParams({ identity: PERSONA.toUpperCase(), slotIndex: 3, secretFingerprint: 'AB' })))
      .toEqual({ identity: PERSONA, slot_index: 3, expected_secret_fingerprint: 'ab' });
    expect(JSON.parse(siteLinkTargetParams({ identity: PERSONA, label: LABEL }))).toEqual({ identity: PERSONA, label: LABEL });
  });
});

describe('reply parsing', () => {
  it('reads the create reply, lowercasing what the echo check compares', () => {
    const r = parseSiteLinkCreateReply(goodReplyJson());
    expect(r).toMatchObject({ slotIndex: 7, secretFingerprint: 'abcd', label: LABEL, npubHex: PERSONA, policyVersion: 2, autoApprove: true, allowedKinds: [] });
  });
  it('is null for a non-string result or bad JSON or a non-object', () => {
    expect(parseSiteLinkCreateReply({ slot_index: 1 })).toBeNull();
    expect(parseSiteLinkCreateReply('not json')).toBeNull();
    expect(parseSiteLinkCreateReply('[1,2]')).toBeNull();
    expect(parseSiteLinkCreateReply('null')).toBeNull();
  });
  it('wrong types read as nothing (the echo check then refuses it)', () => {
    const r = parseSiteLinkCreateReply(JSON.stringify({ slot_index: '7', secret_fingerprint: 1, label: 2, npub_hex: null, bunker_uri: [], policy_version: '2', allowed_methods: [1], allowed_kinds: ['a'], auto_approve: 'yes' }));
    expect(r).toEqual({ slotIndex: null, secretFingerprint: '', label: '', npubHex: '', bunkerUri: '', policyVersion: null, allowedMethods: null, allowedKinds: null, autoApprove: null });
    expect(parseSiteLinkCreateReply(JSON.stringify({ slot_index: 256 }))?.slotIndex).toBeNull();
  });
  it('status and revoke', () => {
    expect(parseSiteLinkStatus('{"exists":true,"bound":false}')).toEqual({ exists: true, bound: false });
    expect(parseSiteLinkStatus('{"exists":false}')).toEqual({ exists: false, bound: false });
    expect(parseSiteLinkStatus('{"bound":true}')).toBeNull();
    expect(parseSiteLinkStatus(42)).toBeNull();
    expect(parseSiteLinkRevoke('{"slot_index":1,"secret_fingerprint":"x","revoked":true}')).toEqual({ revoked: true, bound: false });
    expect(parseSiteLinkRevoke('{"revoked":false,"bound":true}')).toEqual({ revoked: false, bound: true });
    expect(parseSiteLinkRevoke('oops')).toBeNull();
  });
  it('a device error is the bare string; anything else is transport', () => {
    expect(deviceErrorText('user denied')).toBe('user denied');
    expect(deviceErrorText(new Error('user denied'))).toBeNull();
  });
});

describe('signInLinkDeviceErrorCopy', () => {
  it.each([
    ['user denied', 'You cancelled it on your Heartwood.'],
    ['timeout', "Your Heartwood wasn't held in time. Try again in a minute."],
    ['shown recently', 'Your Heartwood showed this a moment ago. Try again in a minute.'],
    ['another link request arrived', 'Another request reached your Heartwood at the same time, so it refused both. Try again in a minute.'],
    ["wider than this phone's access", "This phone's own connection to Alice can't sign everything without asking, so it can't give a site more. Widen it in Sapwood, or choose the other option."],
    ['not approved for identity', "This phone hasn't signed as Alice on your Heartwood yet. Sign something as it first, or choose the other option."],
    ['not an owner pairing', "This phone isn't paired with full access to your Heartwood."],
    ['no room', 'Your Heartwood has no room for another connection. Remove one in Sapwood.'],
    ['storage_full: nvs', 'Your Heartwood has no room for another connection. Remove one in Sapwood.'],
    ['signer is busy with another approval; retry shortly', 'Your Heartwood is busy with another request. Try again shortly.'],
    ['approval_changed: slot 3', "Your Heartwood's connections changed while it was asking. Try again."],
    ['identity not served', "Your Heartwood doesn't hold Alice, or it is locked."],
    ['real identity', 'Your Heartwood refused this: real identity.'],
    ['family slot', 'Your Heartwood refused this: family slot.'],
    ['malformed link request', 'Your Heartwood refused this: malformed link request.'],
    ['RNG health check failed', 'Your Heartwood refused this: RNG health check failed.'],
    ["site links are made over the board's relay connection", "Your Heartwood refused this: site links are made over the board's relay connection."],
  ])('%s', (msg, copy) => {
    expect(signInLinkDeviceErrorCopy(msg, 'Alice')).toBe(copy);
  });
  it('cuts unknown device text at 120 characters', () => {
    const out = signInLinkDeviceErrorCopy('z'.repeat(300), 'A');
    expect(out).toBe(`Your Heartwood refused this: ${'z'.repeat(120)}.`);
  });
  it('the hold line names the host', () => {
    expect(signInLinkHoldCopy('kithmoot.com')).toBe('Hold the button on your Heartwood for 2 seconds. It shows LINK kithmoot.com. A short press cancels.');
  });
});

describe('siteLinkDeadline', () => {
  it('is the 180 s budget or the request\'s 5-minute freshness, whichever is first', () => {
    expect(siteLinkDeadline(T0, undefined)).toBe(T0 + 180_000);
    expect(siteLinkDeadline(T0, T0 / 1000)).toBe(T0 + 180_000);
    expect(siteLinkDeadline(T0, T0 / 1000 - 200)).toBe(T0 + 100_000);
  });
});

// ─── The create state machine ───────────────────────────────────────────────

interface Deferred { resolve: (v: string) => void; reject: (e: unknown) => void }

function device() {
  const creates: { params: string; timeoutMs?: number; d: Deferred }[] = [];
  const statuses: string[] = [];
  let statusAnswer: () => Promise<string> = () => Promise.reject('unknown link: no live entry');
  const request = vi.fn((method: string, params: string[], timeoutMs?: number): Promise<string> => {
    if (method === SITE_LINK_CREATE) {
      return new Promise<string>((resolve, reject) => { creates.push({ params: params[0], timeoutMs, d: { resolve, reject } }); });
    }
    if (method === SITE_LINK_STATUS) {
      statuses.push(params[0]);
      return statusAnswer();
    }
    return Promise.reject(new Error(`unexpected ${method}`));
  });
  return {
    request, creates, statuses,
    setStatus: (f: () => Promise<string>) => { statusAnswer = f; },
  };
}

function args(dev: ReturnType<typeof device>, over: Partial<SiteLinkCreateArgs> = {}): SiteLinkCreateArgs {
  return { request: dev.request, identity: PERSONA, label: LABEL, policy: POLICY, deadlineMs: Date.now() + 180_000, name: 'Alice', ...over };
}

describe('createSiteLinkOnDevice', () => {
  beforeEach(() => { vi.useFakeTimers({ now: T0 }); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends one create, shows the hold line while it waits, and returns the reply', async () => {
    const dev = device();
    const waiting: boolean[] = [];
    const p = createSiteLinkOnDevice(args(dev, { onWaiting: w => waiting.push(w) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(dev.creates).toHaveLength(1);
    expect(dev.creates[0].timeoutMs).toBe(SITE_LINK_CREATE_TIMEOUT_MS);
    expect(JSON.parse(dev.creates[0].params).label).toBe(LABEL);
    dev.creates[0].d.resolve(goodReplyJson());
    await expect(p).resolves.toMatchObject({ slotIndex: 7, secretFingerprint: 'abcd' });
    expect(waiting).toEqual([true, false]);
  });

  it('a reply that cannot be read comes back empty (the echo check refuses it, the caller revokes by label)', async () => {
    const dev = device();
    const p = createSiteLinkOnDevice(args(dev));
    await vi.advanceTimersByTimeAsync(0);
    dev.creates[0].d.resolve('garbage');
    await expect(p).resolves.toMatchObject({ slotIndex: null, secretFingerprint: '', bunkerUri: '' });
  });

  it('a device error string is a real answer: refused with its copy, and never resent', async () => {
    const dev = device();
    const p = createSiteLinkOnDevice(args(dev));
    const settled = p.catch(e => e);
    await vi.advanceTimersByTimeAsync(0);
    dev.creates[0].d.reject('user denied');
    const err = await settled;
    expect(err).toBeInstanceOf(SiteLinkRefusedError);
    expect(err.message).toBe('You cancelled it on your Heartwood.');
    await vi.advanceTimersByTimeAsync(200_000);
    expect(dev.creates).toHaveLength(1);
  });

  it('the device\'s own timeout is a real answer too (no link)', async () => {
    const dev = device();
    const settled = createSiteLinkOnDevice(args(dev)).catch(e => e);
    await vi.advanceTimersByTimeAsync(0);
    dev.creates[0].d.reject('timeout');
    expect(await settled).toBeInstanceOf(SiteLinkRefusedError);
  });

  it('approval_changed is asked again once, with the same params, and the hold line shown again', async () => {
    const dev = device();
    const waiting: boolean[] = [];
    const p = createSiteLinkOnDevice(args(dev, { onWaiting: w => waiting.push(w) }));
    await vi.advanceTimersByTimeAsync(0);
    dev.creates[0].d.reject('approval_changed: slot 2');
    await vi.advanceTimersByTimeAsync(0);
    expect(dev.creates).toHaveLength(2);
    expect(dev.creates[1].params).toBe(dev.creates[0].params);
    dev.creates[1].d.resolve(goodReplyJson());
    await expect(p).resolves.toMatchObject({ slotIndex: 7 });
    expect(waiting).toEqual([true, true, false]);
  });

  it('a second approval_changed fails with its copy', async () => {
    const dev = device();
    const settled = createSiteLinkOnDevice(args(dev)).catch(e => e);
    await vi.advanceTimersByTimeAsync(0);
    dev.creates[0].d.reject('approval_changed: a');
    await vi.advanceTimersByTimeAsync(0);
    dev.creates[1].d.reject('approval_changed: b');
    const err = await settled;
    expect(err).toBeInstanceOf(SiteLinkRefusedError);
    expect(err.message).toBe("Your Heartwood's connections changed while it was asking. Try again.");
    expect(dev.creates).toHaveLength(2);
  });

  it('approval_changed is not asked again with less than 60 s of the budget left', async () => {
    const dev = device();
    const settled = createSiteLinkOnDevice(args(dev, { deadlineMs: T0 + 100_000 })).catch(e => e);
    await vi.advanceTimersByTimeAsync(50_000);
    dev.creates[0].d.reject('approval_changed: a');
    const err = await settled;
    expect(err).toBeInstanceOf(SiteLinkRefusedError);
    expect(err.message).toMatch(/connections changed/);
    expect(dev.creates).toHaveLength(1);
  });

  it('never starts with less than 60 s left (the request is too old)', async () => {
    const dev = device();
    const err = await createSiteLinkOnDevice(args(dev, { deadlineMs: T0 + 59_000 })).catch(e => e);
    expect(err).toBeInstanceOf(SiteLinkRefusedError);
    expect(err.message).toBe(SITE_LINK_TOO_OLD_COPY);
    expect(dev.creates).toHaveLength(0);
  });

  it('a short budget shortens the listener, and the lock is kept while the card may still be up', async () => {
    const dev = device();
    const holds: number[] = [];
    const settled = createSiteLinkOnDevice(args(dev, { deadlineMs: T0 + 90_000, holdLock: ms => holds.push(ms) })).catch(e => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(dev.creates[0].timeoutMs).toBe(90_000);
    await vi.advanceTimersByTimeAsync(90_000);
    dev.creates[0].d.reject(new BunkerRequestTimeoutError(SITE_LINK_CREATE));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await settled).toBeInstanceOf(SiteLinkUncertainError);
    expect(holds).toEqual([T0 + SITE_LINK_CREATE_TIMEOUT_MS]);
  });

  it('polls status by label every 10 s from 10 s while waiting', async () => {
    const dev = device();
    void createSiteLinkOnDevice(args(dev)).catch(() => {});
    await vi.advanceTimersByTimeAsync(9_999);
    expect(dev.statuses).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(dev.statuses).toHaveLength(1);
    expect(JSON.parse(dev.statuses[0])).toEqual({ identity: PERSONA, label: LABEL });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dev.statuses).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dev.statuses).toHaveLength(3);
    dev.creates[0].d.resolve(goodReplyJson());
  });

  it('lost reply, status never finds it: uncertain after the listener times out (never "no link")', async () => {
    const dev = device();
    const holds: number[] = [];
    const settled = createSiteLinkOnDevice(args(dev, { holdLock: ms => holds.push(ms) })).catch(e => e);
    await vi.advanceTimersByTimeAsync(SITE_LINK_CREATE_TIMEOUT_MS);
    dev.creates[0].d.reject(new BunkerRequestTimeoutError(SITE_LINK_CREATE));
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await settled;
    expect(err).toBeInstanceOf(SiteLinkUncertainError);
    expect(err.message).toBe(SITE_LINK_LOST_COPY);
    expect(dev.creates).toHaveLength(1);
    expect(holds).toEqual([T0 + SITE_LINK_CREATE_TIMEOUT_MS]);
  });

  it('lost reply, status shows the hold (exists, unbound): 5 s later the same create is resent and its link used', async () => {
    const dev = device();
    const p = createSiteLinkOnDevice(args(dev));
    await vi.advanceTimersByTimeAsync(0);
    dev.setStatus(async () => '{"exists":true,"bound":false}');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dev.statuses).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(dev.creates).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(dev.creates).toHaveLength(2);
    expect(dev.creates[1].params).toBe(dev.creates[0].params);
    dev.creates[1].d.resolve(goodReplyJson());
    await expect(p).resolves.toMatchObject({ slotIndex: 7 });
  });

  it('no resend when the create\'s own reply arrives within the 5 s', async () => {
    const dev = device();
    const p = createSiteLinkOnDevice(args(dev));
    dev.setStatus(async () => '{"exists":true,"bound":false}');
    await vi.advanceTimersByTimeAsync(12_000);
    dev.creates[0].d.resolve(goodReplyJson());
    await expect(p).resolves.toMatchObject({ slotIndex: 7 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dev.creates).toHaveLength(1);
  });

  it('status says the link is already bound: uncertain at once', async () => {
    const dev = device();
    dev.setStatus(async () => '{"exists":true,"bound":true}');
    const settled = createSiteLinkOnDevice(args(dev)).catch(e => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await settled).toBeInstanceOf(SiteLinkUncertainError);
    expect(dev.creates).toHaveLength(1);
  });

  it('after the hold, a refused resend is NOT "no link": uncertain', async () => {
    const dev = device();
    dev.setStatus(async () => '{"exists":true,"bound":false}');
    const settled = createSiteLinkOnDevice(args(dev)).catch(e => e);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(dev.creates).toHaveLength(2);
    dev.creates[1].d.reject('shown recently');
    expect(await settled).toBeInstanceOf(SiteLinkUncertainError);
  });

  it('a transport error on the create checks status at once, and never resends because of it', async () => {
    const dev = device();
    const p = createSiteLinkOnDevice(args(dev)).catch(e => e);
    await vi.advanceTimersByTimeAsync(2_000);
    dev.creates[0].d.reject(new Error('relay closed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(dev.statuses).toHaveLength(1);
    expect(dev.creates).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SITE_LINK_CREATE_TIMEOUT_MS + 30_000);
    expect(await p).toBeInstanceOf(SiteLinkUncertainError);
    expect(dev.creates).toHaveLength(1);
  });

  it('a hold seen only at the final check is still recovered by the idempotent resend', async () => {
    const dev = device();
    const p = createSiteLinkOnDevice(args(dev));
    await vi.advanceTimersByTimeAsync(SITE_LINK_CREATE_TIMEOUT_MS - 1);
    dev.setStatus(async () => '{"exists":true,"bound":false}');
    dev.creates[0].d.reject(new BunkerRequestTimeoutError(SITE_LINK_CREATE));
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(dev.creates).toHaveLength(2);
    dev.creates[1].d.resolve(goodReplyJson());
    await expect(p).resolves.toMatchObject({ slotIndex: 7 });
  });

  it('nothing sent (the pairing is down): refused with the no-answer copy', async () => {
    const dev = device();
    dev.request.mockImplementationOnce(() => Promise.reject(new Error('Not connected to bunker')));
    const err = await createSiteLinkOnDevice(args(dev)).catch(e => e);
    expect(err).toBeInstanceOf(SiteLinkRefusedError);
    expect(err.message).toBe(SITE_LINK_NO_ANSWER_COPY);
  });

  // S3: a request that never reached a relay must not wait out the hold window.
  describe('nothing published fails at once (no wait, no lock, nothing left behind)', () => {
    const failsAtOnce = async (reject: () => unknown) => {
      const dev = device();
      dev.request.mockImplementationOnce(() => reject() as Promise<string>);
      const hold = vi.fn();
      const err = await createSiteLinkOnDevice(args(dev, { holdLock: hold })).catch(e => e);
      expect(err).toBeInstanceOf(SiteLinkRefusedError);
      expect(err.message).toBe(SITE_LINK_NO_ANSWER_COPY);
      expect(hold).not.toHaveBeenCalled();
      expect(dev.creates).toHaveLength(0);
    };
    it('the signer is closed but the backend is not nulled', () =>
      failsAtOnce(() => Promise.reject(new Error('this signer is not open anymore, create a new one'))));
    it('every relay publish failed (connection failures and relay refusals)', () =>
      failsAtOnce(() => Promise.reject(new AggregateError(['connection failure: Error: down', 'blocked: no'], 'All promises were rejected'))));
    it('the request throws synchronously', () =>
      failsAtOnce(() => { throw new Error('boom'); }));
    it('a publish that timed out may have been delivered: still waits', async () => {
      const dev = device();
      dev.request.mockImplementationOnce(() => Promise.reject(new AggregateError([new Error('publish timed out')], 'All promises were rejected')));
      let settled = false;
      const p = createSiteLinkOnDevice(args(dev)).then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(SITE_LINK_CREATE_TIMEOUT_MS);
      await p;
    });
  });
});

// ─── The device-link lock ───────────────────────────────────────────────────

describe('SiteLinkLock / mintSiteLinkUnderLock', () => {
  beforeEach(() => { vi.useFakeTimers({ now: T0 }); });
  afterEach(() => { vi.useRealTimers(); });

  it('a second create waits for the first to finish', async () => {
    const lock = new SiteLinkLock();
    const dev = device();
    const a = mintSiteLinkUnderLock({ lock, ownerBusy: () => false, args: args(dev) });
    const b = mintSiteLinkUnderLock({ lock, ownerBusy: () => false, args: args(dev, { label: 'mysignet:other.com:00000002' }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(dev.creates).toHaveLength(1);
    dev.creates[0].d.resolve(goodReplyJson());
    await a;
    await vi.advanceTimersByTimeAsync(0);
    expect(dev.creates).toHaveLength(2);
    dev.creates[1].d.resolve(goodReplyJson());
    await b;
  });

  it('a revoke or reconcile waits for an outstanding create', async () => {
    const lock = new SiteLinkLock();
    const dev = device();
    const order: string[] = [];
    const create = mintSiteLinkUnderLock({ lock, ownerBusy: () => false, args: args(dev) });
    const revoke = lock.run(async () => { order.push('revoke'); });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(order).toEqual([]);
    expect(lock.createInFlight).toBe(true);
    order.push('reply');
    dev.creates[0].d.resolve(goodReplyJson());
    await Promise.all([create, revoke]);
    expect(order).toEqual(['reply', 'revoke']);
    expect(lock.createInFlight).toBe(false);
  });

  it('a create that stopped listening early keeps the lock until its card can no longer be up', async () => {
    const lock = new SiteLinkLock();
    const dev = device();
    const seen: boolean[] = [];
    lock.subscribe(v => seen.push(v));
    const first = mintSiteLinkUnderLock({ lock, ownerBusy: () => false, args: args(dev, { deadlineMs: T0 + 70_000 }) }).catch(e => e);
    await vi.advanceTimersByTimeAsync(70_000);
    dev.creates[0].d.reject(new BunkerRequestTimeoutError(SITE_LINK_CREATE));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await first).toBeInstanceOf(SiteLinkUncertainError);
    let ran = false;
    void lock.run(async () => { ran = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(ran).toBe(false);
    expect(lock.createInFlight).toBe(true);
    await vi.advanceTimersByTimeAsync(SITE_LINK_CREATE_TIMEOUT_MS);
    expect(ran).toBe(true);
    expect(seen).toEqual([true, false]);
  });

  it('a create is refused, with the busy copy and nothing sent, while a full-access hold is waiting', async () => {
    const lock = new SiteLinkLock();
    const dev = device();
    const err = await mintSiteLinkUnderLock({ lock, ownerBusy: () => true, args: args(dev) }).catch(e => e);
    expect(err).toBeInstanceOf(SiteLinkRefusedError);
    expect(err.message).toBe(SITE_LINK_BUSY_COPY);
    expect(dev.creates).toHaveLength(0);
    expect(lock.createInFlight).toBe(false);
  });
});

// ─── Revoke and status over the phone's own pairing ─────────────────────────

describe('revokeSiteLinkOnDevice', () => {
  const confirmed = { persona: PERSONA, label: LABEL, slotIndex: 4, secretFingerprint: 'fp4' };
  const pending = { persona: PERSONA, label: LABEL, secretFingerprint: '' };
  const req = (answer: () => Promise<string>) => vi.fn((_m: string, _p: string[], _t?: number) => answer());

  it('a confirmed link is revoked by fingerprint', async () => {
    const r = req(async () => '{"slot_index":4,"secret_fingerprint":"fp4","revoked":true}');
    await revokeSiteLinkOnDevice(r, confirmed);
    expect(r).toHaveBeenCalledWith(SITE_LINK_REVOKE, [JSON.stringify({ identity: PERSONA, slot_index: 4, expected_secret_fingerprint: 'fp4' })], expect.any(Number));
  });
  it.each(['unknown link: no slot 4', 'stale_client_slot: fingerprint mismatch'])('%s means already gone', async msg => {
    await expect(revokeSiteLinkOnDevice(req(() => Promise.reject(msg)), confirmed)).resolves.toBeUndefined();
  });
  it('any other refusal, or no answer, keeps the record', async () => {
    await expect(revokeSiteLinkOnDevice(req(() => Promise.reject('not a site link: owner pairing')), confirmed)).rejects.toThrow(/refused/);
    await expect(revokeSiteLinkOnDevice(req(() => Promise.reject(new Error('relay down'))), confirmed)).rejects.toThrow(SITE_LINK_NO_ANSWER_COPY);
    await expect(revokeSiteLinkOnDevice(req(async () => 'nonsense'), confirmed)).rejects.toThrow();
  });
  it('an unconfirmed link is named by label, and is gone only on revoked:true', async () => {
    const r = req(async () => '{"slot_index":4,"secret_fingerprint":"fp4","revoked":true}');
    await revokeSiteLinkOnDevice(r, pending);
    expect(r).toHaveBeenCalledWith(SITE_LINK_REVOKE, [JSON.stringify({ identity: PERSONA, label: LABEL })], expect.any(Number));
  });
  it('an unconfirmed link: unknown link, or bound, is NOT gone (uncertain: remove it in Sapwood)', async () => {
    const e1 = await revokeSiteLinkOnDevice(req(() => Promise.reject('unknown link: no live entry')), pending).catch(e => e);
    expect(e1).toBeInstanceOf(SiteLinkUncertainError);
    expect(e1.message).toBe(SITE_LINK_UNCERTAIN_REVOKE_COPY);
    const e2 = await revokeSiteLinkOnDevice(req(async () => '{"revoked":false,"bound":true}'), pending).catch(e => e);
    expect(e2).toBeInstanceOf(SiteLinkUncertainError);
  });
});

describe('siteLinkStatusOnDevice', () => {
  it('asks by fingerprint and reads exists/bound', async () => {
    const r = vi.fn(async (_m: string, _p: string[], _t?: number) => '{"exists":true,"bound":true}');
    await expect(siteLinkStatusOnDevice(r, { persona: PERSONA, label: LABEL, slotIndex: 1, secretFingerprint: 'f' })).resolves.toEqual({ exists: true, bound: true });
    expect(r.mock.calls[0][0]).toBe(SITE_LINK_STATUS);
  });
  it('throws for an unconfirmed link or an unreadable answer', async () => {
    const r = vi.fn(async () => 'x');
    await expect(siteLinkStatusOnDevice(r, { persona: PERSONA, label: LABEL, secretFingerprint: '' })).rejects.toThrow();
    await expect(siteLinkStatusOnDevice(r, { persona: PERSONA, label: LABEL, slotIndex: 1, secretFingerprint: 'f' })).rejects.toThrow();
  });
});
