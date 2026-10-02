// @vitest-environment jsdom
/**
 * The child's bunker (child-direct spec §8.2): gated owner-persona routes.
 * Transport = a local key; signing = the persona's Heartwood route; every
 * sign / NIP-44 request through the gate; the gate's request created_at is
 * handed to the signing backend.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { bytesToHex } from '@noble/hashes/utils.js';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { NostrConnect } from 'nostr-tools/kinds';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import { useBunkerServer, type BunkerRoute } from './useBunkerServer';
import { LocalSigningBackend, type StampedSigningCalls } from '../lib/signing-backend';
import type { ChildGateOutcome, ChildRouteGate } from '../lib/child-bunker';

class MockRelaySocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockRelaySocket[] = [];

  autoAck = true;
  readyState = MockRelaySocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  subId: string | null = null;
  filter: Record<string, unknown> | null = null;
  published: NostrEvent[] = [];

  constructor(readonly url: string) {
    MockRelaySocket.instances.push(this);
    setTimeout(() => {
      this.readyState = MockRelaySocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data: string) {
    this.sent.push(data);
    const parsed = JSON.parse(data);
    if (parsed[0] === 'REQ') {
      this.subId = parsed[1];
      this.filter = parsed[2];
    } else if (parsed[0] === 'EVENT') {
      this.published.push(parsed[1]);
      if (this.autoAck) this.ack(parsed[1].id);
    }
  }

  ack(id: string, accepted = true) {
    this.onmessage?.({ data: JSON.stringify(['OK', id, accepted, accepted ? '' : 'blocked: test rejection']) });
  }

  close() {
    this.readyState = MockRelaySocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }

  deliver(event: NostrEvent) {
    if (!this.subId) throw new Error('subscription not ready');
    this.onmessage?.({ data: JSON.stringify(['EVENT', this.subId, event]) });
  }
}

beforeAll(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('WebSocket', MockRelaySocket);
});

afterEach(() => {
  cleanup();
  MockRelaySocket.instances = [];
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function buildClientRequest(input: {
  clientSk: Uint8Array;
  targetPubkey: string;
  id: string;
  method: string;
  params: string[];
}): NostrEvent {
  const content = encrypt(
    JSON.stringify({ id: input.id, method: input.method, params: input.params }),
    getConversationKey(input.clientSk, input.targetPubkey),
  );
  return finalizeEvent({
    kind: NostrConnect,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', input.targetPubkey]],
    content,
  }, input.clientSk) as unknown as NostrEvent;
}

function decryptServerResponse(clientSk: Uint8Array, event: NostrEvent): { id: string; result?: string; error?: string } {
  return JSON.parse(decrypt(event.content, getConversationKey(clientSk, event.pubkey)));
}


const personaSk = generateSecretKey();
const PERSONA = getPublicKey(personaSk);
const transportSk = generateSecretKey();

function stampingPersonaBackend() {
  const local = new LocalSigningBackend(bytesToHex(personaSk));
  const stamps: number[] = [];
  const backend = Object.assign(local, {
    stamped(createdAt: number): StampedSigningCalls {
      stamps.push(createdAt);
      return local;
    },
  });
  return { backend, stamps };
}

function gatedRoute(gate: ChildRouteGate, signing = stampingPersonaBackend()) {
  const transport = new LocalSigningBackend(bytesToHex(transportSk));
  const route: BunkerRoute = { pubkey: transport.activePublicKeyHex, backend: transport, signingBackend: signing.backend, childGate: gate };
  return { route, signing, transport };
}

async function openServer(route: BunkerRoute, relayUrl: string) {
  const hook = renderHook(() => useBunkerServer({ enabled: true, relayUrl, routes: [route], isOwnerServingActive: () => false }));
  await waitFor(() => {
    expect(MockRelaySocket.instances).toHaveLength(1);
    expect(MockRelaySocket.instances[0].subId).toBeTruthy();
  });
  return { hook, ws: MockRelaySocket.instances[0] };
}

async function ask(ws: MockRelaySocket, clientSk: Uint8Array, target: string, id: string, method: string, params: string[]) {
  const before = ws.published.length;
  await act(async () => { ws.deliver(buildClientRequest({ clientSk, targetPubkey: target, id, method, params })); });
  await waitFor(() => expect(ws.published.length).toBe(before + 1));
  return decryptServerResponse(clientSk, ws.published[before]);
}

describe('useBunkerServer — the child\'s gated persona routes', () => {
  it('ACKs connect with the app label, answers the persona pubkey, and serves while owner serving is paused', async () => {
    const onConnect = vi.fn();
    const gate: ChildRouteGate = { authorise: vi.fn(), onConnect };
    const { route, transport } = gatedRoute(gate);
    const { ws, hook } = await openServer(route, 'wss://child-a.example');
    const clientSk = generateSecretKey();
    const meta = JSON.stringify({ name: 'Block Game', url: 'https://blocks.example' });
    expect(await ask(ws, clientSk, transport.activePublicKeyHex, 'c1', 'connect', [transport.activePublicKeyHex, '', meta])).toEqual({ id: 'c1', result: 'ack' });
    expect(onConnect).toHaveBeenCalledWith(getPublicKey(clientSk), expect.objectContaining({ label: 'Block Game' }));
    expect(await ask(ws, clientSk, transport.activePublicKeyHex, 'g1', 'get_public_key', [])).toEqual({ id: 'g1', result: PERSONA });
    expect(ws.published.every(e => e.pubkey === transport.activePublicKeyHex)).toBe(true);
    hook.unmount();
  });

  it('sign_event: the gate decides, the persona signs the gate\'s template, stamped with its created_at', async () => {
    const authorise = vi.fn(async (req: { template?: UnsignedEvent }): Promise<ChildGateOutcome> =>
      ({ ok: true, requestCreatedAt: 1_900_000_001, template: { ...req.template!, pubkey: PERSONA } }));
    const { route, transport, signing } = gatedRoute({ authorise });
    const { ws, hook } = await openServer(route, 'wss://child-b.example');
    const clientSk = generateSecretKey();
    const template = { kind: 1, created_at: 1_800_000_000, tags: [], content: 'gg' };
    const res = await ask(ws, clientSk, transport.activePublicKeyHex, 's1', 'sign_event', [JSON.stringify(template)]);
    const signed = JSON.parse(res.result!);
    expect(signed).toMatchObject({ pubkey: PERSONA, kind: 1, content: 'gg' });
    expect(authorise).toHaveBeenCalledWith(expect.objectContaining({ clientPubkey: getPublicKey(clientSk), method: 'sign_event' }));
    expect(signing.stamps).toEqual([1_900_000_001]);
    hook.unmount();
  });

  it('a refusal is answered with the gate\'s error and nothing is signed', async () => {
    const authorise = vi.fn(async (): Promise<ChildGateOutcome> => ({ ok: false, error: 'denied' }));
    const { route, transport, signing } = gatedRoute({ authorise });
    const signSpy = vi.spyOn(signing.backend, 'signEvent');
    const { ws, hook } = await openServer(route, 'wss://child-c.example');
    const clientSk = generateSecretKey();
    const res = await ask(ws, clientSk, transport.activePublicKeyHex, 's2', 'sign_event', [JSON.stringify({ kind: 1, created_at: 1, tags: [], content: '' })]);
    expect(res).toEqual({ id: 's2', error: 'denied' });
    expect(signSpy).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('a template naming another pubkey is refused before the gate', async () => {
    const authorise = vi.fn();
    const { route, transport } = gatedRoute({ authorise });
    const { ws, hook } = await openServer(route, 'wss://child-d.example');
    const clientSk = generateSecretKey();
    const res = await ask(ws, clientSk, transport.activePublicKeyHex, 's3', 'sign_event', [JSON.stringify({ kind: 1, created_at: 1, tags: [], content: '', pubkey: 'ee'.repeat(32) })]);
    expect(res.error).toBe('pubkey mismatch');
    expect(authorise).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('NIP-44 goes through the gate with the peer; NIP-04 is refused', async () => {
    const authorise = vi.fn(async (): Promise<ChildGateOutcome> => ({ ok: true, requestCreatedAt: 1_900_000_050 }));
    const { route, transport, signing } = gatedRoute({ authorise });
    const { ws, hook } = await openServer(route, 'wss://child-e.example');
    const clientSk = generateSecretKey();
    const peer = getPublicKey(generateSecretKey());
    const res = await ask(ws, clientSk, transport.activePublicKeyHex, 'e1', 'nip44_encrypt', [peer, 'hello']);
    expect(res.result).toBeTruthy();
    expect(authorise).toHaveBeenCalledWith({ clientPubkey: getPublicKey(clientSk), method: 'nip44_encrypt', peer });
    expect(signing.stamps).toEqual([1_900_000_050]);
    const res4 = await ask(ws, clientSk, transport.activePublicKeyHex, 'e2', 'nip04_encrypt', [peer, 'hello']);
    expect(res4.error).toBe('method not supported');
    expect(authorise).toHaveBeenCalledTimes(1);
    hook.unmount();
  });
});

