/**
 * Heartwood operator channel client — REAL crypto (nostr-tools NIP-44 v2 +
 * BIP-340 via finalizeEvent) over a fake transport that stands in for both
 * the relays and the device. The fake device decrypts every request with a
 * random "master" keypair, asserts the envelope, and answers through the
 * subscribed callback exactly as the firmware does (kind 24134, p=operator,
 * authored by the master, NIP-44 under the same conversation key).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NostrEvent, NostrFilter } from 'signet-protocol';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  HeartwoodMgmtClient,
  MGMT_KIND,
  type MgmtTransport,
  getStatus,
  hasCapability,
  listClients,
  parseDeviceClientSlot,
  updateClientPolicy,
  resolveApproval,
  clampVerdictWindow,
  isRetryableMgmtError,
  isStaleChallengeError,
  requiresMutationChallenge,
  newMgmtRequestId,
  mgmtRequestPayload,
  CAP_RESOLVE_APPROVAL,
  CAP_CLIENT_POLICY_FLAGS,
} from './heartwood-mgmt';
import type { SlotPolicyUpdate } from './heartwood-mgmt-types';

// ─── Fake device + transport ────────────────────────────────────────────────

interface Seen {
  id: string;
  method: string;
  params: Record<string, unknown>;
  mutationChallenge?: string;
  outer: NostrEvent;
}

/** null = stay silent (device never replies); undefined = defer to the
 *  default handler (which answers `get_management_challenge` with the
 *  fake's live, rotating challenge). */
type Handler = (req: Seen) => { result?: unknown; error?: string } | null | undefined;

function makeFakeDevice(opts?: { handler?: Handler }) {
  const deviceSk = generateSecretKey();
  const deviceHex = getPublicKey(deviceSk);
  const operatorSk = generateSecretKey();
  const operatorHex = getPublicKey(operatorSk);
  const ck = nip44.utils.getConversationKey(deviceSk, operatorHex);

  const seen: Seen[] = [];
  const subs: Array<{ filters: NostrFilter[]; relays: string[]; onEvent: (ev: NostrEvent) => void }> = [];
  let challenge = 'a'.repeat(64);
  const publishedEvents: NostrEvent[] = [];
  let unsubscribed = 0;

  const defaultHandler: Handler = (req) => {
    if (req.method === 'get_management_challenge') return { result: { version: 1, challenge } };
    if (req.method === 'get_status') {
      return { result: { master_npub_hex: deviceHex, capabilities: ['client_policy_v2', CAP_CLIENT_POLICY_FLAGS, CAP_RESOLVE_APPROVAL], version: '0.17.0', slots: 3, relays_live: [] } };
    }
    return { result: { echoed: req.params, mutation_challenge: req.mutationChallenge ?? null } };
  };

  /** Emit a reply exactly like the firmware's sign_and_publish for MGMT_KIND. */
  const reply = (id: string, body: { result?: unknown; error?: string }, from: Uint8Array = deviceSk) => {
    const plaintext = JSON.stringify(body.error !== undefined ? { id, error: body.error } : { id, result: body.result });
    const fromCk = from === deviceSk ? ck : nip44.utils.getConversationKey(from, operatorHex);
    const ev = finalizeEvent({
      kind: MGMT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', operatorHex]],
      content: nip44.encrypt(plaintext, fromCk),
    }, from) as unknown as NostrEvent;
    for (const s of subs) s.onEvent(ev);
  };

  const transport: MgmtTransport = {
    async publish(event, relays) {
      publishedEvents.push(event);
      expect(relays).toEqual(['wss://relay.example']);
      // Envelope assertions — what the firmware checks before it ever
      // decrypts: kind, operator author, p-tag to the master.
      expect(event.kind).toBe(MGMT_KIND);
      expect(event.pubkey).toBe(operatorHex);
      expect(event.tags).toEqual([['p', deviceHex]]);
      expect(verifyEvent(event as never)).toBe(true);
      const inner = JSON.parse(nip44.decrypt(event.content, ck)) as Record<string, unknown>;
      expect(typeof inner.id).toBe('string');
      expect(inner.id).toMatch(/^[0-9a-f]{32}$/);
      const req: Seen = {
        id: inner.id as string,
        method: inner.method as string,
        params: inner.params as Record<string, unknown>,
        mutationChallenge: inner.mutation_challenge as string | undefined,
        outer: event,
      };
      // mutation_challenge sits TOP-LEVEL, never in params, only on mutations.
      expect('mutation_challenge' in (req.params ?? {})).toBe(false);
      if (requiresMutationChallenge(req.method)) {
        expect(req.mutationChallenge).toMatch(/^[0-9a-f]{64}$/);
      } else {
        expect(req.mutationChallenge).toBeUndefined();
      }
      seen.push(req);
      // Firmware: mutation with the current challenge rotates it; a stale
      // one is refused before dispatch.
      let out: ReturnType<Handler> = undefined;
      if (requiresMutationChallenge(req.method) && req.mutationChallenge !== challenge) {
        out = { error: 'stale_management_challenge: another manager changed the device; refresh state and retry' };
      } else {
        if (requiresMutationChallenge(req.method)) challenge = bytesToHex(generateSecretKey());
        out = opts?.handler ? opts.handler(req) : undefined;
        if (out === undefined) out = defaultHandler(req);
      }
      if (out) reply(req.id, out);
      return { ok: true, message: '1/1 relays accepted' };
    },
    subscribe(filters, relays, onEvent) {
      const rec = { filters, relays, onEvent };
      subs.push(rec);
      return () => {
        unsubscribed += 1;
        const i = subs.indexOf(rec);
        if (i >= 0) subs.splice(i, 1);
      };
    },
  };

  const client = () => new HeartwoodMgmtClient(
    { skHex: bytesToHex(operatorSk), deviceHex, relays: ['wss://relay.example'] },
    transport,
  );

  return {
    deviceSk, deviceHex, operatorSk, operatorHex, ck, seen, subs, publishedEvents, transport, client, reply,
    get challenge() { return challenge; },
    set challenge(v: string) { challenge = v; },
    get unsubscribed() { return unsubscribed; },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('pure helpers', () => {
  it('classifies read-only vs mutation methods (unknown fails closed)', () => {
    for (const m of ['get_management_challenge', 'get_network_config', 'list_clients', 'list_identities', 'get_status']) {
      expect(requiresMutationChallenge(m)).toBe(false);
    }
    expect(requiresMutationChallenge('update_client')).toBe(true);
    expect(requiresMutationChallenge('resolve_approval')).toBe(true);
    expect(requiresMutationChallenge('some_future_method')).toBe(true);
  });

  it('request ids are 32 hex and unique', () => {
    const a = newMgmtRequestId();
    const b = newMgmtRequestId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('payload puts mutation_challenge top-level and omits it when absent', () => {
    expect(mgmtRequestPayload('id1', 'get_status', {})).toEqual({ id: 'id1', method: 'get_status', params: {} });
    expect(mgmtRequestPayload('id2', 'update_client', { a: 1 }, 'ff')).toEqual({
      id: 'id2', method: 'update_client', params: { a: 1 }, mutation_challenge: 'ff',
    });
  });

  it('error classifiers', () => {
    expect(isStaleChallengeError('stale_management_challenge: another manager changed the device')).toBe(true);
    expect(isStaleChallengeError('stale_client_slot: slot credential changed')).toBe(false);
    expect(isRetryableMgmtError('stale_management_challenge: x')).toBe(true);
    expect(isRetryableMgmtError('device low on memory; state unchanged, retry shortly')).toBe(true);
    expect(isRetryableMgmtError('signer is busy with another approval; retry shortly')).toBe(true);
    expect(isRetryableMgmtError('stale_client_slot: slot credential changed')).toBe(false);
    expect(isRetryableMgmtError('no such slot: 3')).toBe(false);
  });

  it('clampVerdictWindow mirrors the firmware clamp', () => {
    expect(clampVerdictWindow(undefined)).toBe(600);
    expect(clampVerdictWindow(0)).toBe(600);
    expect(clampVerdictWindow(-5)).toBe(600);
    expect(clampVerdictWindow(NaN)).toBe(600);
    expect(clampVerdictWindow(120)).toBe(120);
    expect(clampVerdictWindow(120.9)).toBe(120);
    expect(clampVerdictWindow(99_999)).toBe(3600);
  });
});

// ─── Constructor ─────────────────────────────────────────────────────────────

describe('HeartwoodMgmtClient constructor', () => {
  it('rejects malformed credentials', () => {
    const d = makeFakeDevice();
    const sk = bytesToHex(d.operatorSk);
    expect(() => new HeartwoodMgmtClient({ skHex: sk, deviceHex: 'zz', relays: ['wss://r'] }, d.transport)).toThrow(/device pubkey/);
    expect(() => new HeartwoodMgmtClient({ skHex: 'nope', deviceHex: d.deviceHex, relays: ['wss://r'] }, d.transport)).toThrow(/operator secret/);
    expect(() => new HeartwoodMgmtClient({ skHex: sk, deviceHex: d.deviceHex, relays: [] }, d.transport)).toThrow(/relay/);
  });

  it('derives the operator pubkey and lowercases the device hex', () => {
    const d = makeFakeDevice();
    const c = new HeartwoodMgmtClient(
      { skHex: bytesToHex(d.operatorSk).toUpperCase(), deviceHex: d.deviceHex.toUpperCase(), relays: ['wss://r'] },
      d.transport,
    );
    expect(c.operatorPub).toBe(d.operatorHex);
    expect(c.deviceHex).toBe(d.deviceHex);
  });
});

// ─── Round trips ─────────────────────────────────────────────────────────────

describe('HeartwoodMgmtClient request/reply', () => {
  it('start() opens the reply subscription with the documented filter', () => {
    const d = makeFakeDevice();
    const c = d.client();
    const before = Math.floor(Date.now() / 1000);
    c.start();
    expect(d.subs).toHaveLength(1);
    const f = d.subs[0].filters;
    expect(f).toHaveLength(1);
    expect(f[0].kinds).toEqual([MGMT_KIND]);
    expect(f[0]['#p']).toEqual([d.operatorHex]);
    expect(f[0].since).toBeGreaterThanOrEqual(before - 61);
    expect(f[0].since).toBeLessThanOrEqual(before - 59);
    expect(d.subs[0].relays).toEqual(['wss://relay.example']);
    c.start(); // idempotent
    expect(d.subs).toHaveLength(1);
    c.stop();
  });

  it('request before start() rejects', async () => {
    const d = makeFakeDevice();
    const c = d.client();
    await expect(c.request('get_status')).rejects.toThrow('not started');
  });

  it('read-only round-trip: no challenge, result decrypted and returned', async () => {
    const d = makeFakeDevice();
    const c = d.client();
    c.start();
    const r = await c.request('get_status');
    expect(r.master_npub_hex).toBe(d.deviceHex);
    expect(d.seen.map(s => s.method)).toEqual(['get_status']);
    expect(d.seen[0].mutationChallenge).toBeUndefined();
    c.stop();
  });

  it('mutation does challenge-then-mutate with the challenge echoed top-level', async () => {
    const d = makeFakeDevice();
    d.challenge = 'b'.repeat(64);
    const c = d.client();
    c.start();
    const r = await c.request<{ echoed: Record<string, unknown>; mutation_challenge: string }>('update_client', { slot_index: 1 });
    expect(d.seen.map(s => s.method)).toEqual(['get_management_challenge', 'update_client']);
    expect(d.seen[1].mutationChallenge).toBe('b'.repeat(64));
    expect(d.seen[1].params).toEqual({ slot_index: 1 });
    expect(r.echoed).toEqual({ slot_index: 1 });
    expect(r.mutation_challenge).toBe('b'.repeat(64));
    c.stop();
  });

  it('challenge is uppercased by the device → client lowercases before echoing', async () => {
    const d = makeFakeDevice({
      handler: (req) => {
        if (req.method === 'get_management_challenge') return { result: { version: 1, challenge: d.challenge.toUpperCase() } };
        return { result: { ok: true } };
      },
    });
    d.challenge = 'abc0'.repeat(16);
    const c = d.client();
    c.start();
    await c.request('update_client', {});
    expect(d.seen[1].mutationChallenge).toBe('abc0'.repeat(16));
    c.stop();
  });

  it('a malformed challenge aborts the mutation before it is sent', async () => {
    const d = makeFakeDevice({
      handler: (req) => {
        if (req.method === 'get_management_challenge') return { result: { version: 2, challenge: 'ff' } };
        return { result: {} };
      },
    });
    const c = d.client();
    c.start();
    await expect(c.request('update_client', {})).rejects.toThrow(/valid management challenge/);
    expect(d.seen.map(s => s.method)).toEqual(['get_management_challenge']);
    c.stop();
  });

  it('old firmware without get_management_challenge maps to a clear error', async () => {
    const d = makeFakeDevice({
      handler: (req) => {
        if (req.method === 'get_management_challenge') return { error: 'unknown method: get_management_challenge' };
        return { result: {} };
      },
    });
    const c = d.client();
    c.start();
    await expect(c.request('update_client', {})).rejects.toThrow(/too old/);
    c.stop();
  });

  it('stale_management_challenge surfaces as an Error and is NOT retried', async () => {
    const d = makeFakeDevice();
    d.challenge = 'c'.repeat(64);
    const c = d.client();
    c.start();
    // Another manager mutates between our challenge fetch and our mutation:
    // the fake device's handler for the challenge fetch reports the OLD
    // challenge, then we rotate it before the mutation lands.
    const orig = d.transport.publish.bind(d.transport);
    let fetched = false;
    d.transport.publish = async (ev, relays) => {
      const r = await orig(ev, relays);
      if (!fetched) { fetched = true; d.challenge = 'd'.repeat(64); }
      return r;
    };
    let err: Error | undefined;
    try { await c.request('update_client', { slot_index: 0 }); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(Error);
    expect(isStaleChallengeError(err!.message)).toBe(true);
    // Exactly one challenge fetch + one mutation attempt — no automatic retry.
    expect(d.seen.map(s => s.method)).toEqual(['get_management_challenge', 'update_client']);
    c.stop();
  });

  it('device error replies reject with the verbatim message', async () => {
    const d = makeFakeDevice({ handler: () => ({ error: 'no such slot: 7' }) });
    const c = d.client();
    c.start();
    await expect(c.request('list_clients')).rejects.toThrow('no such slot: 7');
    c.stop();
  });

  it('times out when the device is silent', async () => {
    vi.useFakeTimers();
    const d = makeFakeDevice({ handler: () => null });
    const c = d.client();
    c.start();
    const p = c.request('get_status', {}, { timeoutMs: 1000 });
    const settled = expect(p).rejects.toThrow(/timeout waiting for device \(get_status\)/);
    await vi.advanceTimersByTimeAsync(1001);
    await settled;
    c.stop();
  });

  it('default timeout is 35s', async () => {
    vi.useFakeTimers();
    const d = makeFakeDevice({ handler: () => null });
    const c = d.client();
    c.start();
    let rejected = false;
    const p = c.request('get_status').catch(() => { rejected = true; });
    await vi.advanceTimersByTimeAsync(34_000);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    await p;
    expect(rejected).toBe(true);
    c.stop();
  });

  it('publish failure rejects fast (no wait for the timeout)', async () => {
    const d = makeFakeDevice();
    d.transport.publish = async () => ({ ok: false, message: '0/1 relays accepted' });
    const c = d.client();
    c.start();
    await expect(c.request('get_status')).rejects.toThrow(/failed to publish/);
    c.stop();
  });

  it('a late publish failure does not clobber an already-delivered reply', async () => {
    const d = makeFakeDevice();
    const orig = d.transport.publish.bind(d.transport);
    d.transport.publish = async (ev, relays) => {
      await orig(ev, relays); // reply is delivered inline here
      return { ok: false, message: 'relay closed after' };
    };
    const c = d.client();
    c.start();
    const r = await c.request('get_status');
    expect(r.master_npub_hex).toBe(d.deviceHex);
    c.stop();
  });

  it('replies for unknown ids are ignored', async () => {
    const d = makeFakeDevice({ handler: () => null });
    const c = d.client();
    c.start();
    let settled = false;
    const p = c.request('get_status', {}, { timeoutMs: 200 }).then(() => { settled = true; }, () => { settled = true; });
    d.reply('0'.repeat(32), { result: { bogus: true } });
    await Promise.resolve();
    expect(settled).toBe(false);
    await p; // times out
    expect(settled).toBe(true);
    c.stop();
  });

  it('a reply authored by a non-device pubkey is ignored even with a matching id', async () => {
    const d = makeFakeDevice({ handler: () => null });
    const c = d.client();
    c.start();
    let settled = false;
    const p = c.request('get_status', {}, { timeoutMs: 200 }).then(() => { settled = true; }, () => { settled = true; });
    const attacker = generateSecretKey();
    d.reply(d.seen[0].id, { result: { pwned: true } }, attacker);
    await Promise.resolve();
    expect(settled).toBe(false);
    await p;
    expect(settled).toBe(true);
    c.stop();
  });

  it('a reply from the device that fails to decrypt is ignored', async () => {
    const d = makeFakeDevice({ handler: () => null });
    const c = d.client();
    c.start();
    let settled = false;
    const p = c.request('get_status', {}, { timeoutMs: 200 }).then(() => { settled = true; }, () => { settled = true; });
    // Authored by the device, but under a different conversation key.
    const wrongCk = nip44.utils.getConversationKey(generateSecretKey(), d.operatorHex);
    const ev = finalizeEvent({
      kind: MGMT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', d.operatorHex]],
      content: nip44.encrypt(JSON.stringify({ id: d.seen[0].id, result: {} }), wrongCk),
    }, d.deviceSk) as unknown as NostrEvent;
    for (const s of d.subs) s.onEvent(ev);
    await Promise.resolve();
    expect(settled).toBe(false);
    await p;
    c.stop();
  });

  it('every publish uses a fresh inner id AND a fresh outer event id', async () => {
    const d = makeFakeDevice();
    const c = d.client();
    c.start();
    await c.request('get_status');
    await c.request('get_status');
    await c.request('update_client', {});
    await c.request('update_client', {});
    const inner = d.seen.map(s => s.id);
    expect(new Set(inner).size).toBe(inner.length);
    const outer = d.publishedEvents.map(e => e.id);
    expect(new Set(outer).size).toBe(outer.length);
    c.stop();
  });

  it('mutations are serialised — a second mutation waits for the first pair', async () => {
    // The device stays silent on the first mutation; we answer it manually
    // later so the second mutation's challenge fetch cannot interleave.
    const d = makeFakeDevice({
      handler: (req) => {
        if (req.method === 'update_client') return req.params.n === 1 ? null : { result: { ok: true } };
        return undefined;
      },
    });
    const c = d.client();
    c.start();
    const p1 = c.request('update_client', { n: 1 });
    const p2 = c.request('update_client', { n: 2 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(d.seen.map(s => s.method)).toEqual(['get_management_challenge', 'update_client']);
    d.reply(d.seen[1].id, { result: { ok: true } });
    await p1;
    await p2;
    expect(d.seen.map(s => `${s.method}:${String(s.params.n ?? '')}`)).toEqual([
      'get_management_challenge:', 'update_client:1', 'get_management_challenge:', 'update_client:2',
    ]);
    c.stop();
  });

  it('a read is not blocked by an in-flight mutation', async () => {
    const d = makeFakeDevice({
      handler: (req) => (req.method === 'update_client' ? null : undefined),
    });
    const c = d.client();
    c.start();
    const pm = c.request('update_client', {}, { timeoutMs: 500 }).catch(() => 'timed out');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const r = await c.request('get_status');
    expect(r.master_npub_hex).toBe(d.deviceHex);
    expect(await pm).toBe('timed out');
    c.stop();
  });

  it('a failed mutation does not wedge the queue', async () => {
    let n = 0;
    const d = makeFakeDevice({
      handler: (req) => {
        if (req.method === 'update_client') { n += 1; return n === 1 ? { error: 'no such slot: 9' } : { result: { ok: true } }; }
        return undefined;
      },
    });
    const c = d.client();
    c.start();
    await expect(c.request('update_client', {})).rejects.toThrow('no such slot: 9');
    await expect(c.request('update_client', {})).resolves.toEqual({ ok: true });
    c.stop();
  });

  it('stop() rejects pending, unsubscribes, and refuses further work', async () => {
    const d = makeFakeDevice({ handler: () => null });
    const c = d.client();
    c.start();
    const p1 = c.request('get_status');
    const p2 = c.request('list_clients');
    c.stop();
    await expect(p1).rejects.toThrow('transport closed');
    await expect(p2).rejects.toThrow('transport closed');
    expect(d.unsubscribed).toBe(1);
    expect(d.subs).toHaveLength(0);
    expect(c.isOpen).toBe(false);
    await expect(c.request('get_status')).rejects.toThrow('transport closed');
    expect(() => c.start()).toThrow('transport closed');
    c.stop(); // idempotent
    expect(d.unsubscribed).toBe(1);
  });

  it('stop() zeroizes the operator sk and conversation key', () => {
    const d = makeFakeDevice();
    const c = d.client();
    c.start();
    const priv = c as unknown as { sk: Uint8Array; ck: Uint8Array };
    expect(priv.sk.some(b => b !== 0)).toBe(true);
    expect(priv.ck.some(b => b !== 0)).toBe(true);
    c.stop();
    expect(priv.sk.every(b => b === 0)).toBe(true);
    expect(priv.ck.every(b => b === 0)).toBe(true);
  });

  it('a late reply after stop() is ignored', async () => {
    const d = makeFakeDevice({ handler: () => null });
    const c = d.client();
    c.start();
    const p = c.request('get_status').catch(e => (e as Error).message);
    const id = d.seen[0].id;
    const sub = d.subs[0];
    c.stop();
    expect(await p).toBe('transport closed');
    // Deliver straight to the captured callback (the transport has already
    // dropped it) — must not throw.
    expect(() => sub.onEvent(finalizeEvent({
      kind: MGMT_KIND, created_at: 1, tags: [['p', d.operatorHex]],
      content: nip44.encrypt(JSON.stringify({ id, result: {} }), d.ck),
    }, d.deviceSk) as unknown as NostrEvent)).not.toThrow();
  });
});

// ─── Typed helpers over the client ───────────────────────────────────────────

describe('getStatus / hasCapability', () => {
  it('parses a full status', async () => {
    const d = makeFakeDevice();
    const c = d.client();
    c.start();
    const s = await getStatus(c);
    expect(s.truncated).toBe(false);
    expect(s.masterNpubHex).toBe(d.deviceHex);
    expect(s.capabilities).toEqual(['client_policy_v2', CAP_CLIENT_POLICY_FLAGS, CAP_RESOLVE_APPROVAL]);
    expect(s.version).toBe('0.17.0');
    expect(s.slots).toBe(3);
    expect(hasCapability(s, CAP_RESOLVE_APPROVAL)).toBe(true);
    expect(hasCapability(s, 'pairing_identity_v1')).toBe(false);
    c.stop();
  });

  it('truncated status ⇒ capabilities null ⇒ hasCapability unknown', async () => {
    const d = makeFakeDevice({
      handler: () => ({ result: { master_npub_hex: 'AB'.repeat(32), truncated: true, version: '0.17.0' } }),
    });
    const c = d.client();
    c.start();
    const s = await getStatus(c);
    expect(s.truncated).toBe(true);
    expect(s.capabilities).toBeNull();
    expect(s.masterNpubHex).toBe('ab'.repeat(32));
    expect(hasCapability(s, CAP_RESOLVE_APPROVAL)).toBeNull();
    c.stop();
  });

  it('old firmware with no capabilities field ⇒ [] (unsupported, not unknown)', async () => {
    const d = makeFakeDevice({ handler: () => ({ result: { master_npub_hex: 'cd'.repeat(32) } }) });
    const c = d.client();
    c.start();
    const s = await getStatus(c);
    expect(s.capabilities).toEqual([]);
    expect(hasCapability(s, CAP_RESOLVE_APPROVAL)).toBe(false);
    c.stop();
  });

  it('non-string capability entries are dropped', async () => {
    const d = makeFakeDevice({ handler: () => ({ result: { master_npub_hex: 'cd'.repeat(32), capabilities: ['a', 1, null, 'b'] } }) });
    const c = d.client();
    c.start();
    expect((await getStatus(c)).capabilities).toEqual(['a', 'b']);
    c.stop();
  });
});

const goodRow = () => ({
  slot_index: 2,
  label: 'kid phone',
  secret_fingerprint: 'fp-abc',
  auto_approve: true,
  signing_approved: true,
  strict_permissions: true,
  current_pubkey: 'e'.repeat(64),
  authorized_pubkeys: ['e'.repeat(64)],
  allowed_kinds: [1, 24133],
  allowed_methods: ['sign_event', 'get_public_key'],
  escalate: true,
  petition_on_deny: false,
  audit_child_wrap: true,
  bound_identity: 'F'.repeat(64),
});

describe('listClients / parseDeviceClientSlot', () => {
  it('maps snake_case rows to camelCase and drops malformed rows', async () => {
    const rows: unknown[] = [
      goodRow(),
      { ...goodRow(), slot_index: 'x' },                 // bad index
      { ...goodRow(), secret_fingerprint: '' },          // missing fingerprint
      { ...goodRow(), auto_approve: 'yes' },             // non-bool
      { ...goodRow(), allowed_kinds: [1, 'two'] },       // bad kinds
      { ...goodRow(), allowed_methods: 'sign_event' },   // not an array
      { ...goodRow(), escalate: 'true' },                // present non-bool flag
      { ...goodRow(), bound_identity: 'not-hex' },       // bad identity
      'not an object',
      null,
      { ...goodRow(), slot_index: 5, label: undefined, escalate: undefined, petition_on_deny: undefined, audit_child_wrap: undefined, bound_identity: undefined, current_pubkey: null },
    ];
    const d = makeFakeDevice({ handler: () => ({ result: { clients: rows } }) });
    const c = d.client();
    c.start();
    const out = await listClients(c);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      slotIndex: 2,
      label: 'kid phone',
      secretFingerprint: 'fp-abc',
      autoApprove: true,
      signingApproved: true,
      strictPermissions: true,
      currentPubkey: 'e'.repeat(64),
      authorizedPubkeys: ['e'.repeat(64)],
      allowedKinds: [1, 24133],
      allowedMethods: ['sign_event', 'get_public_key'],
      escalate: true,
      petitionOnDeny: false,
      auditChildWrap: true,
      boundIdentity: 'f'.repeat(64),
    });
    // Older-firmware row: absent flags default false, absent identity null.
    expect(out[1]).toMatchObject({
      slotIndex: 5, label: '', escalate: false, petitionOnDeny: false, auditChildWrap: false, boundIdentity: null, currentPubkey: null,
    });
    c.stop();
  });

  it('non-array clients ⇒ []', async () => {
    const d = makeFakeDevice({ handler: () => ({ result: { clients: 'nope' } }) });
    const c = d.client();
    c.start();
    expect(await listClients(c)).toEqual([]);
    c.stop();
    expect(parseDeviceClientSlot(undefined)).toBeUndefined();
  });
});

const policy: SlotPolicyUpdate = {
  allowedMethods: ['sign_event', 'nip44_encrypt'],
  allowedKinds: [1, 7],
  autoApprove: false,
  escalate: true,
  petitionOnDeny: true,
  auditChildWrap: false,
};

describe('updateClientPolicy', () => {
  it('sends every field explicitly with the fingerprint echoed', async () => {
    const d = makeFakeDevice({
      handler: (req) => (req.method === 'update_client'
        ? { result: { slot_index: req.params.slot_index, secret_fingerprint: req.params.expected_secret_fingerprint, updated: true } }
        : undefined),
    });
    const c = d.client();
    c.start();
    await updateClientPolicy(c, { slotIndex: 3, secretFingerprint: 'fp-3' }, { ...policy, boundIdentity: 'A'.repeat(64) });
    const sent = d.seen.find(s => s.method === 'update_client')!;
    expect(sent.params).toEqual({
      slot_index: 3,
      expected_secret_fingerprint: 'fp-3',
      allowed_methods: ['sign_event', 'nip44_encrypt'],
      allowed_kinds: [1, 7],
      auto_approve: false,
      escalate: true,
      petition_on_deny: true,
      audit_child_wrap: false,
      bound_identity: 'a'.repeat(64),
    });
    expect(sent.mutationChallenge).toMatch(/^[0-9a-f]{64}$/);
    // Flags at params top-level here — NOT under params.policy.
    expect('policy' in sent.params).toBe(false);
    c.stop();
  });

  it('omits bound_identity when not provided (device keeps its value)', async () => {
    const d = makeFakeDevice({
      handler: (req) => (req.method === 'update_client'
        ? { result: { slot_index: 0, secret_fingerprint: 'fp', updated: true } }
        : undefined),
    });
    const c = d.client();
    c.start();
    await updateClientPolicy(c, { slotIndex: 0, secretFingerprint: 'fp' }, policy);
    const sent = d.seen.find(s => s.method === 'update_client')!;
    expect('bound_identity' in sent.params).toBe(false);
    expect(Object.keys(sent.params).sort()).toEqual([
      'allowed_kinds', 'allowed_methods', 'audit_child_wrap', 'auto_approve', 'escalate',
      'expected_secret_fingerprint', 'petition_on_deny', 'slot_index',
    ]);
    c.stop();
  });

  it('surfaces stale_client_slot verbatim and rejects an unconfirmed update', async () => {
    const d1 = makeFakeDevice({
      handler: (req) => (req.method === 'update_client'
        ? { error: 'stale_client_slot: slot credential changed; refresh clients and try again' }
        : undefined),
    });
    const c1 = d1.client();
    c1.start();
    await expect(updateClientPolicy(c1, { slotIndex: 0, secretFingerprint: 'old' }, policy)).rejects.toThrow(/stale_client_slot/);
    c1.stop();

    const d2 = makeFakeDevice({
      handler: (req) => (req.method === 'update_client'
        ? { result: { slot_index: 0, updated: false } }
        : undefined),
    });
    const c2 = d2.client();
    c2.start();
    await expect(updateClientPolicy(c2, { slotIndex: 0, secretFingerprint: 'fp' }, policy)).rejects.toThrow(/did not confirm/);
    c2.stop();
  });

  it('validates the slot ref client-side', async () => {
    const d = makeFakeDevice();
    const c = d.client();
    c.start();
    await expect(updateClientPolicy(c, { slotIndex: -1, secretFingerprint: 'fp' }, policy)).rejects.toThrow(/slotIndex/);
    await expect(updateClientPolicy(c, { slotIndex: 1, secretFingerprint: '' }, policy)).rejects.toThrow(/secretFingerprint/);
    expect(d.seen).toHaveLength(0);
    c.stop();
  });
});

describe('resolveApproval', () => {
  const verdictDevice = (reply: { park: unknown; applied: unknown }) => makeFakeDevice({
    handler: (req) => (req.method === 'resolve_approval' ? { result: reply } : undefined),
  });

  it('approve-once: park + action + default window, no policy', async () => {
    const d = verdictDevice({ park: 'live', applied: 'completed' });
    d.challenge = 'e'.repeat(64);
    const c = d.client();
    c.start();
    const r = await resolveApproval(c, { park: 'park-123', action: 'approve-once' });
    expect(r).toEqual({ park: 'live', applied: 'completed' });
    const sent = d.seen.find(s => s.method === 'resolve_approval')!;
    expect(sent.params).toEqual({ park: 'park-123', action: 'approve-once', window: 600 });
    expect(sent.mutationChallenge).toBe('e'.repeat(64));
    c.stop();
  });

  it('window is clamped client-side to [default, 3600]', async () => {
    const d = verdictDevice({ park: 'expired', applied: 'window' });
    d.challenge = 'e'.repeat(64);
    const c = d.client();
    c.start();
    await resolveApproval(c, { park: 'p', action: 'approve-once', windowSeconds: 99_999 });
    await resolveApproval(c, { park: 'p', action: 'approve-once', windowSeconds: 0 });
    await resolveApproval(c, { park: 'p', action: 'approve-once', windowSeconds: 900 });
    const windows = d.seen.filter(s => s.method === 'resolve_approval').map(s => s.params.window);
    expect(windows).toEqual([3600, 600, 900]);
    c.stop();
  });

  it('approve-remember: policy nested under params.policy with the flags', async () => {
    const d = verdictDevice({ park: 'live', applied: 'policy' });
    d.challenge = 'e'.repeat(64);
    const c = d.client();
    c.start();
    const r = await resolveApproval(c, {
      park: 'park-9', action: 'approve-remember', policy: { ...policy, boundIdentity: 'B'.repeat(64) },
    });
    expect(r).toEqual({ park: 'live', applied: 'policy' });
    const sent = d.seen.find(s => s.method === 'resolve_approval')!;
    expect(sent.params).toEqual({
      park: 'park-9',
      action: 'approve-remember',
      window: 600,
      policy: {
        allowed_methods: ['sign_event', 'nip44_encrypt'],
        allowed_kinds: [1, 7],
        auto_approve: false,
        escalate: true,
        petition_on_deny: true,
        audit_child_wrap: false,
        bound_identity: 'b'.repeat(64),
      },
    });
    c.stop();
  });

  it('approve-remember without a policy is refused client-side', async () => {
    const d = verdictDevice({ park: 'live', applied: 'policy' });
    const c = d.client();
    c.start();
    await expect(resolveApproval(c, { park: 'p', action: 'approve-remember' })).rejects.toThrow(/requires a policy/);
    expect(d.seen).toHaveLength(0);
    c.stop();
  });

  it('deny: no window semantics needed but sent (device ignores); result honest', async () => {
    const d = verdictDevice({ park: 'expired', applied: 'none' });
    d.challenge = 'e'.repeat(64);
    const c = d.client();
    c.start();
    const r = await resolveApproval(c, { park: 'gone', action: 'deny' });
    expect(r).toEqual({ park: 'expired', applied: 'none' });
    c.stop();
  });

  it('malformed device replies are rejected; bad inputs refused', async () => {
    const d = verdictDevice({ park: 'maybe', applied: 'completed' });
    d.challenge = 'e'.repeat(64);
    const c = d.client();
    c.start();
    await expect(resolveApproval(c, { park: 'p', action: 'deny' })).rejects.toThrow(/malformed resolve_approval reply/);
    await expect(resolveApproval(c, { park: '', action: 'deny' })).rejects.toThrow(/park id/);
    await expect(resolveApproval(c, { park: 'p', action: 'nuke' as never })).rejects.toThrow(/action must be/);
    c.stop();
  });
});
