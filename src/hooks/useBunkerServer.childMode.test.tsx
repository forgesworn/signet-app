// @vitest-environment jsdom
/**
 * Child mode (a guardian's unlocked phone in a dependant's hands) never acts as
 * the guardian: a request on one of the guardian's OWN persona routes is
 * answered exactly as when owner serving is paused, even from a client the
 * guardian pre-approved. Dependant routes are unchanged.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { bytesToHex } from '@noble/hashes/utils.js';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { NostrConnect } from 'nostr-tools/kinds';
import type { NostrEvent } from 'signet-protocol';
import { useBunkerServer, type BunkerRoute } from './useBunkerServer';
import { LocalSigningBackend } from '../lib/signing-backend';
import * as db from '../lib/db';
import type { ChildModeState } from '../lib/child-mode-sign-in';

class MockRelaySocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockRelaySocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  subId: string | null = null;
  filter: Record<string, unknown> | null = null;
  autoAck = true;
  published: NostrEvent[] = [];
  constructor(readonly url: string) {
    MockRelaySocket.instances.push(this);
    setTimeout(() => { this.readyState = MockRelaySocket.OPEN; this.onopen?.(); }, 0);
  }
  send(data: string) {
    const parsed = JSON.parse(data);
    if (parsed[0] === 'REQ') { this.subId = parsed[1]; this.filter = parsed[2]; }
    else if (parsed[0] === 'EVENT') {
      this.published.push(parsed[1]);
      this.onmessage?.({ data: JSON.stringify(['OK', parsed[1].id, true, '']) });
    }
  }
  close() { this.readyState = MockRelaySocket.CLOSED; this.onclose?.({ code: 1000 }); }
  deliver(event: NostrEvent) { this.onmessage?.({ data: JSON.stringify(['EVENT', this.subId, event]) }); }
}

beforeAll(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('WebSocket', MockRelaySocket);
});
afterEach(() => { cleanup(); MockRelaySocket.instances = []; });
afterAll(() => { vi.unstubAllGlobals(); });

function request(clientSk: Uint8Array, target: string, id: string, template: object): NostrEvent {
  const content = encrypt(
    JSON.stringify({ id, method: 'sign_event', params: [JSON.stringify(template)] }),
    getConversationKey(clientSk, target),
  );
  return finalizeEvent({ kind: NostrConnect, created_at: Math.floor(Date.now() / 1000), tags: [['p', target]], content }, clientSk) as unknown as NostrEvent;
}
function cryptoRequest(clientSk: Uint8Array, target: string, id: string, method: string, params: string[]): NostrEvent {
  const content = encrypt(JSON.stringify({ id, method, params }), getConversationKey(clientSk, target));
  return finalizeEvent({ kind: NostrConnect, created_at: Math.floor(Date.now() / 1000), tags: [['p', target]], content }, clientSk) as unknown as NostrEvent;
}
function reply(clientSk: Uint8Array, event: NostrEvent): { id: string; result?: string; error?: string } {
  return JSON.parse(decrypt(event.content, getConversationKey(clientSk, event.pubkey)));
}

const ORIGIN = 'https://game.example';
const SIGN_IN = { kind: 21236, created_at: 1_800_000_000, tags: [['origin', ORIGIN]], content: '' };
let n = 0;

async function setup(opts: { dependant: boolean; childMode?: { current: ChildModeState }; omitSignal?: boolean; signal?: () => ChildModeState }) {
  const transport = new LocalSigningBackend(bytesToHex(generateSecretKey()));
  const personaSk = generateSecretKey();
  const persona = getPublicKey(personaSk);
  const signing = new LocalSigningBackend(bytesToHex(personaSk));
  const clientSk = generateSecretKey();
  const clientPubkey = getPublicKey(clientSk);
  const route: BunkerRoute = opts.dependant
    ? { pubkey: transport.activePublicKeyHex, backend: transport, signingBackend: signing, dependantId: persona, autonomyStage: 'request-approve', authorizedClientPubkey: clientPubkey }
    : { pubkey: transport.activePublicKeyHex, backend: transport, signingBackend: signing };
  if (opts.dependant) await db.saveGrant({ dependantId: persona, scope: 'sign-in', origin: ORIGIN, decision: 'allow', decidedAt: 1, lastUsedAt: 1 });
  else await db.saveConnectedClient({ clientPubkey, appName: 'Bark', connectedAt: 1, lastSeenAt: 1, allowAlways: true });
  const state = opts.childMode ?? { current: 'off' as ChildModeState };
  const relayUrl = `wss://child-mode-${++n}.example`;
  const hook = renderHook(() => useBunkerServer({
    enabled: true, relayUrl, routes: [route], isOwnerServingActive: () => true,
    ...(opts.omitSignal ? {} : { childModeNow: opts.signal ?? (() => state.current) }),
  }));
  await waitFor(() => expect(MockRelaySocket.instances[0]?.subId).toBeTruthy());
  const ws = MockRelaySocket.instances[0];
  const ask = async (id: string) => {
    const before = ws.published.length;
    await act(async () => { ws.deliver(request(clientSk, transport.activePublicKeyHex, id, SIGN_IN)); });
    await waitFor(() => expect(ws.published.length).toBe(before + 1));
    return reply(clientSk, ws.published[before]);
  };
  const askNip44 = async (id: string) => {
    const before = ws.published.length;
    const peer = getPublicKey(generateSecretKey());
    await act(async () => { ws.deliver(cryptoRequest(clientSk, transport.activePublicKeyHex, id, 'nip44_encrypt', [peer, 'hello'])); });
    await waitFor(() => expect(ws.published.length).toBe(before + 1));
    return reply(clientSk, ws.published[before]);
  };
  return { hook, ws, ask, askNip44, signing, state };
}

describe('useBunkerServer: owner routes in child mode', () => {
  it.each(['on', 'unknown'] as const)('a pre-approved owner sign_event is answered "serving paused" and never signed (%s)', async mode => {
    const h = await setup({ dependant: false, childMode: { current: mode } });
    const sign = vi.spyOn(h.signing, 'signEvent');
    const res = await h.ask('o1');
    expect(res).toEqual({ id: 'o1', error: 'serving paused' });
    expect(sign).not.toHaveBeenCalled();
    expect(h.hook.result.current.pendingApprovals).toHaveLength(0);
    h.hook.unmount();
  });

  it('the same request with child mode off still signs', async () => {
    const h = await setup({ dependant: false, childMode: { current: 'off' } });
    const res = await h.ask('o2');
    expect(JSON.parse(res.result!)).toMatchObject({ kind: 21236 });
    h.hook.unmount();
  });

  it('reads the signal at request time, not when the subscription was built', async () => {
    const state = { current: 'off' as ChildModeState };
    const h = await setup({ dependant: false, childMode: state });
    expect(JSON.parse((await h.ask('o3')).result!)).toMatchObject({ kind: 21236 });
    state.current = 'on';
    expect(await h.ask('o4')).toEqual({ id: 'o4', error: 'serving paused' });
    state.current = 'off';
    expect(JSON.parse((await h.ask('o5')).result!)).toMatchObject({ kind: 21236 });
    h.hook.unmount();
  });

  it('with no signal supplied, behaves as before', async () => {
    const h = await setup({ dependant: false, omitSignal: true });
    expect(JSON.parse((await h.ask('o6')).result!)).toMatchObject({ kind: 21236 });
    h.hook.unmount();
  });

  it('a dependant-route request in child mode is unchanged', async () => {
    const h = await setup({ dependant: true, childMode: { current: 'on' } });
    const res = await h.ask('d1');
    expect(JSON.parse(res.result!)).toMatchObject({ kind: 21236 });
    h.hook.unmount();
  });

  // The first read (the early gate) sees child mode off; every later read sees it on, as when
  // child mode starts while the request is in flight. Only the re-check right before the
  // operation can stop it.
  const startsMidRequest = () => { let reads = 0; return () => (++reads === 1 ? 'off' : 'on') as ChildModeState; };

  it('child mode starting after the first gate still stops the silent sign_event', async () => {
    const h = await setup({ dependant: false, signal: startsMidRequest() });
    const sign = vi.spyOn(h.signing, 'signEvent');
    expect(await h.ask('m1')).toEqual({ id: 'm1', error: 'serving paused' });
    expect(sign).not.toHaveBeenCalled();
    h.hook.unmount();
  });

  it('child mode starting after the first gate still stops the silent owner-route nip44', async () => {
    const h = await setup({ dependant: false, signal: startsMidRequest() });
    const enc = vi.spyOn(h.signing, 'nip44Encrypt');
    expect(await h.askNip44('m2')).toEqual({ id: 'm2', error: 'serving paused' });
    expect(enc).not.toHaveBeenCalled();
    h.hook.unmount();
  });

  it('the same nip44 request with child mode off the whole time is answered', async () => {
    const h = await setup({ dependant: false, childMode: { current: 'off' } });
    expect((await h.askNip44('m3')).result).toBeTruthy();
    h.hook.unmount();
  });
});
