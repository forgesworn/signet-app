// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { bytesToHex } from '@noble/hashes/utils.js';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';
import { encrypt as nip04Encrypt, decrypt as nip04Decrypt } from 'nostr-tools/nip04';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { NostrConnect } from 'nostr-tools/kinds';
import type { NostrEvent } from 'signet-protocol';
import { switchRelaysAnswer, useBunkerServer } from './useBunkerServer';
import { LocalSigningBackend } from '../lib/signing-backend';
import { buildConnectedClientFromNostrConnect } from '../lib/nip46';
import { deleteConnectedClient, getConnectedClient, saveConnectedClient } from '../lib/db';
import * as db from '../lib/db';
import { CHILD_PURPOSE } from '../lib/kinterest-authority';
import type { TrustedAppPairing } from '../types';
import { markAnswered } from '../lib/bunker-answered-store';
import * as native from '../lib/native';

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

function renderOwnerServer(
  relayUrl = 'wss://canary-relay.example',
  overrides: Partial<Parameters<typeof useBunkerServer>[0]> = {},
) {
  const ownerSk = generateSecretKey();
  const ownerBackend = new LocalSigningBackend(bytesToHex(ownerSk));
  const hook = renderHook(() => useBunkerServer({
    enabled: true,
    relayUrl,
    routes: [{ pubkey: ownerBackend.activePublicKeyHex, backend: ownerBackend }],
    isOwnerServingActive: () => true,
    ...overrides,
  }));
  return { ...hook, ownerBackend, relayUrl };
}

async function waitForOpenRelay(routePubkey: string, relayUrl: string): Promise<MockRelaySocket> {
  await waitFor(() => {
    expect(MockRelaySocket.instances).toHaveLength(1);
    expect(MockRelaySocket.instances[0].readyState).toBe(MockRelaySocket.OPEN);
    expect(MockRelaySocket.instances[0].subId).toBeTruthy();
  });
  const ws = MockRelaySocket.instances[0];
  expect(ws.url).toBe(relayUrl);
  expect(ws.filter).toMatchObject({
    kinds: [NostrConnect],
    '#p': [routePubkey],
  });
  return ws;
}

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

describe('native approvals completed in another view', () => {
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
  it('retires a queued answered request while leaving a different request awaiting consent', async () => {
    vi.spyOn(native, 'isNativeApp').mockReturnValue(true);
    const h = renderOwnerServer();
    const ws = await waitForOpenRelay(h.ownerBackend.activePublicKeyHex, h.relayUrl);
    const clientSk = generateSecretKey();
    const request = (id: string) => buildClientRequest({
      clientSk, targetPubkey: h.ownerBackend.activePublicKeyHex, id, method: 'sign_event',
      params: [JSON.stringify({ kind: 3063, tags: [], content: id, created_at: Math.floor(Date.now() / 1000) })],
    });
    const answered = request('answered-in-other-view');
    await act(async () => { ws.deliver(answered); ws.deliver(request('still-needs-consent')); });
    await waitFor(() => expect(h.result.current.pendingApprovals).toHaveLength(2));
    const remaining = h.result.current.pendingApprovals.find(p => p.method === 'sign_event' && p.template.content === 'still-needs-consent')!;
    await act(async () => { markAnswered(answered.id); });
    await waitFor(() => expect(h.result.current.pendingApprovals.map(p => p.handle)).toEqual([remaining.handle]));
    expect(ws.published).toHaveLength(0);
  });

  it('retires the second live view after the first view delivers its signed response', async () => {
    vi.spyOn(native, 'isNativeApp').mockReturnValue(true);
    const first = renderOwnerServer();
    const firstSocket = await waitForOpenRelay(first.ownerBackend.activePublicKeyHex, first.relayUrl);
    const second = renderHook(() => useBunkerServer({
      enabled: true, relayUrl: first.relayUrl,
      routes: [{ pubkey: first.ownerBackend.activePublicKeyHex, backend: first.ownerBackend }],
      isOwnerServingActive: () => true,
    }));
    await waitFor(() => expect(MockRelaySocket.instances.at(-1)?.subId).toBeTruthy());
    const secondSocket = MockRelaySocket.instances.at(-1)!;
    const clientSk = generateSecretKey();
    const request = buildClientRequest({
      clientSk, targetPubkey: first.ownerBackend.activePublicKeyHex, id: 'shared-approval', method: 'sign_event',
      params: [JSON.stringify({ kind: 3063, tags: [], content: 'one catalogue record', created_at: Math.floor(Date.now() / 1000) })],
    });
    await act(async () => { firstSocket.deliver(request); secondSocket.deliver(request); });
    await waitFor(() => {
      expect(first.result.current.pendingApprovals).toHaveLength(1);
      expect(second.result.current.pendingApprovals).toHaveLength(1);
    });
    const staleHandle = second.result.current.pendingApproval!.handle;
    const signing = vi.spyOn(first.ownerBackend, 'signEvent');
    await act(async () => { await first.result.current.approveOnce(first.result.current.pendingApproval!.handle); });
    await waitFor(() => expect(second.result.current.pendingApprovals).toHaveLength(0));
    await act(async () => { await second.result.current.approveOnce(staleHandle); });
    expect(signing).toHaveBeenCalledTimes(2); // one user event and its response envelope
    expect(firstSocket.published).toHaveLength(1);
    expect(secondSocket.published).toHaveLength(0);
    expect(decryptServerResponse(clientSk, firstSocket.published[0]).id).toBe('shared-approval');
  });

  it.each(['storage', 'focus', 'tap'])('retires a completed request on %s even if the original notification was missed', async mode => {
    vi.spyOn(native, 'isNativeApp').mockReturnValue(true);
    const h = renderOwnerServer();
    const ws = await waitForOpenRelay(h.ownerBackend.activePublicKeyHex, h.relayUrl);
    const request = buildClientRequest({
      clientSk: generateSecretKey(), targetPubkey: h.ownerBackend.activePublicKeyHex, id: 'already-completed', method: 'sign_event',
      params: [JSON.stringify({ kind: 3063, tags: [], content: '', created_at: Math.floor(Date.now() / 1000) })],
    });
    await act(async () => { ws.deliver(request); });
    await waitFor(() => expect(h.result.current.pendingApprovals).toHaveLength(1));
    const handle = h.result.current.pendingApproval!.handle;
    const signing = vi.spyOn(h.ownerBackend, 'signEvent');
    // A different WebView has written the receipt, without a local event here.
    localStorage.setItem('signet:bunker-answered:v1', JSON.stringify([[request.id, Date.now()]]));
    await act(async () => {
      if (mode === 'storage') window.dispatchEvent(new StorageEvent('storage', { key: 'signet:bunker-answered:v1' }));
      else if (mode === 'focus') window.dispatchEvent(new Event('focus'));
      else await h.result.current.approveOnce(handle);
    });
    await waitFor(() => expect(h.result.current.pendingApprovals).toHaveLength(0));
    expect(signing).not.toHaveBeenCalled();
    expect(ws.published).toHaveLength(0);
  });

  it.each(['sign_event', 'nip44_decrypt'])('does not enqueue a completed %s while its permission lookup is in flight', async method => {
    vi.spyOn(native, 'isNativeApp').mockReturnValue(true);
    const pending = vi.fn();
    const h = renderOwnerServer('wss://late-approval.example', { onApprovalPending: pending });
    const ws = await waitForOpenRelay(h.ownerBackend.activePublicKeyHex, h.relayUrl);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lookup = vi.spyOn(db, 'getConnectedClient').mockImplementation(async () => { await gate; return undefined; });
    const request = buildClientRequest({
      clientSk: generateSecretKey(), targetPubkey: h.ownerBackend.activePublicKeyHex, id: 'completed-during-lookup', method,
      params: method === 'sign_event'
        ? [JSON.stringify({ kind: 3063, tags: [], content: '', created_at: Math.floor(Date.now() / 1000) })]
        : [getPublicKey(generateSecretKey()), 'cipher'],
    });
    await act(async () => { ws.deliver(request); });
    await waitFor(() => expect(lookup).toHaveBeenCalled());
    await act(async () => {
      markAnswered(request.id); release();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(h.result.current.pendingApprovals).toHaveLength(0);
    expect(pending).not.toHaveBeenCalled();
    expect(ws.published).toHaveLength(0);
  });

  it('binds retirement to the envelope even when a client reuses an RPC id', async () => {
    vi.spyOn(native, 'isNativeApp').mockReturnValue(true);
    const h = renderOwnerServer();
    const ws = await waitForOpenRelay(h.ownerBackend.activePublicKeyHex, h.relayUrl);
    const clientSk = generateSecretKey();
    const request = (content: string) => buildClientRequest({
      clientSk, targetPubkey: h.ownerBackend.activePublicKeyHex, id: 'reused-id', method: 'sign_event',
      params: [JSON.stringify({ kind: 3063, tags: [], content, created_at: Math.floor(Date.now() / 1000) })],
    });
    await act(async () => { ws.deliver(request('first')); ws.deliver(request('second')); });
    await waitFor(() => expect(h.result.current.pendingApprovals).toHaveLength(2));
    const first = h.result.current.pendingApprovals.find(p => p.method === 'sign_event' && p.template.content === 'first')!;
    await act(async () => { await h.result.current.approveOnce(first.handle); });
    expect(h.result.current.pendingApprovals).toHaveLength(1);
    expect(h.result.current.pendingApprovals[0]).toMatchObject({ template: { content: 'second' } });
    expect(ws.published).toHaveLength(1);
  });

  it('leaves web approvals independent of native answered receipts', async () => {
    vi.spyOn(native, 'isNativeApp').mockReturnValue(false);
    const h = renderOwnerServer();
    const ws = await waitForOpenRelay(h.ownerBackend.activePublicKeyHex, h.relayUrl);
    const request = buildClientRequest({
      clientSk: generateSecretKey(), targetPubkey: h.ownerBackend.activePublicKeyHex, id: 'web-approval', method: 'sign_event',
      params: [JSON.stringify({ kind: 3063, tags: [], content: '', created_at: Math.floor(Date.now() / 1000) })],
    });
    await act(async () => { ws.deliver(request); });
    await waitFor(() => expect(h.result.current.pendingApprovals).toHaveLength(1));
    await act(async () => { markAnswered(request.id); window.dispatchEvent(new Event('focus')); });
    expect(h.result.current.pendingApprovals).toHaveLength(1);
    expect(ws.published).toHaveLength(0);
  });
});

describe('an app handed to a Heartwood, before the stored list has loaded', () => {
  function deferred() {
    let resolve!: (v: boolean) => void;
    const promise = new Promise<boolean>(r => { resolve = r; });
    return { promise, resolve };
  }
  const getPubkey = (clientSk: Uint8Array, target: string, id: string) =>
    buildClientRequest({ clientSk, targetPubkey: target, id, method: 'get_public_key', params: [] });

  it('waits for the list and stays silent for a handed-off app', async () => {
    const loading = deferred();
    const h = renderOwnerServer(undefined, { isHandedOffClient: () => loading.promise });
    const ws = await waitForOpenRelay(h.ownerBackend.activePublicKeyHex, h.relayUrl);
    const clientSk = generateSecretKey();
    await act(async () => { ws.deliver(getPubkey(clientSk, h.ownerBackend.activePublicKeyHex, 'early')); });
    await new Promise(r => setTimeout(r, 20));
    expect(ws.published).toHaveLength(0);
    await act(async () => { loading.resolve(true); });
    await new Promise(r => setTimeout(r, 20));
    expect(ws.published).toHaveLength(0);
  });

  it('answers once the list says the app is not handed off', async () => {
    const loading = deferred();
    const h = renderOwnerServer(undefined, { isHandedOffClient: () => loading.promise });
    const ws = await waitForOpenRelay(h.ownerBackend.activePublicKeyHex, h.relayUrl);
    const clientSk = generateSecretKey();
    await act(async () => { ws.deliver(getPubkey(clientSk, h.ownerBackend.activePublicKeyHex, 'early')); });
    await new Promise(r => setTimeout(r, 20));
    expect(ws.published).toHaveLength(0);
    await act(async () => { loading.resolve(false); });
    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(decryptServerResponse(clientSk, ws.published[0]).id).toBe('early');
  });
});

describe('useBunkerServer NostrConnect integration', () => {
  it('listens on the requested relay and answers the immediate get_public_key follow-up', async () => {
    const { ownerBackend, relayUrl, unmount } = renderOwnerServer();
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
    const clientSk = generateSecretKey();

    await act(async () => {
      ws.deliver(buildClientRequest({
        clientSk,
        targetPubkey: ownerBackend.activePublicKeyHex,
        id: 'get-pubkey',
        method: 'get_public_key',
        params: [],
      }));
    });

    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(decryptServerResponse(clientSk, ws.published[0])).toEqual({
      id: 'get-pubkey',
      result: ownerBackend.activePublicKeyHex,
    });
    unmount();
  });

  it('does not ACK auth-flow connect when allow-always persistence fails', async () => {
    const pendingAuthPairingsRef = {
      current: new Map<string, {
        origin: string;
        appName: string;
        signingPubkey: string;
        expiresAt: number;
      }>(),
    };
    const persistAuthPairing = vi.fn(async () => {
      throw new Error('idb failed');
    });
    const { ownerBackend, relayUrl, unmount } = renderOwnerServer('wss://canary-authpair-fail.example', {
      pendingAuthPairingsRef,
      onAuthFlowPairingComplete: persistAuthPairing,
    });
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
    const clientSk = generateSecretKey();
    const secret = 'auth-flow-secret';
    pendingAuthPairingsRef.current.set(secret, {
      origin: 'https://play.axenstax.com',
      appName: 'AxeNStax',
      signingPubkey: ownerBackend.activePublicKeyHex,
      expiresAt: Date.now() + 60_000,
    });

    await act(async () => {
      ws.deliver(buildClientRequest({
        clientSk,
        targetPubkey: ownerBackend.activePublicKeyHex,
        id: 'connect',
        method: 'connect',
        params: [ownerBackend.activePublicKeyHex, secret],
      }));
    });

    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(decryptServerResponse(clientSk, ws.published[0])).toEqual({
      id: 'connect',
      error: 'pairing failed — try again',
    });
    expect(persistAuthPairing).toHaveBeenCalledOnce();
    expect(pendingAuthPairingsRef.current.has(secret)).toBe(true);
    unmount();
  });

  it('answers NIP-46 management methods and removes owner clients on logout', async () => {
    const { ownerBackend, relayUrl, unmount } = renderOwnerServer('wss://canary-management.example');
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
    const clientSk = generateSecretKey();
    const clientPubkey = getPublicKey(clientSk);

    await saveConnectedClient(buildConnectedClientFromNostrConnect({
      clientPubkey,
      relayUrl,
      relayUrls: [relayUrl],
      secret: 'management-secret',
      appName: 'Canary',
      appUrl: 'https://canary.trotters.cc',
    }, 1_770_000_000));

    await act(async () => {
      ws.deliver(buildClientRequest({
        clientSk,
        targetPubkey: ownerBackend.activePublicKeyHex,
        id: 'ping',
        method: 'ping',
        params: [],
      }));
    });
    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(decryptServerResponse(clientSk, ws.published[0])).toEqual({
      id: 'ping',
      result: 'pong',
    });

    await act(async () => {
      ws.deliver(buildClientRequest({
        clientSk,
        targetPubkey: ownerBackend.activePublicKeyHex,
        id: 'switch-relays',
        method: 'switch_relays',
        params: [],
      }));
    });
    await waitFor(() => expect(ws.published).toHaveLength(2));
    expect(decryptServerResponse(clientSk, ws.published[1])).toEqual({
      id: 'switch-relays',
      result: JSON.stringify(null),
    });

    await act(async () => {
      ws.deliver(buildClientRequest({
        clientSk,
        targetPubkey: ownerBackend.activePublicKeyHex,
        id: 'logout',
        method: 'logout',
        params: [],
      }));
    });
    await waitFor(() => expect(ws.published).toHaveLength(3));
    expect(decryptServerResponse(clientSk, ws.published[2])).toEqual({
      id: 'logout',
      result: 'ack',
    });
    await waitFor(async () => {
      expect(await getConnectedClient(clientPubkey)).toBeUndefined();
    });

    unmount();
  });

  it.each([
    {
      label: 'leads with the persistent relay and keeps the temporary pairing relay',
      persistentRelayUrl: 'wss://nos.lol',
      expected: ['wss://nos.lol', 'wss://canary-switch.example'],
    },
    {
      label: 'answers null when the request already arrived on the persistent relay',
      persistentRelayUrl: 'wss://canary-switch.example/',
      expected: null,
    },
    {
      label: 'answers null when no valid persistent relay is known',
      persistentRelayUrl: 'ws://relay.example',
      expected: null,
    },
  ])('switch_relays $label', async ({ persistentRelayUrl, expected }) => {
    const { ownerBackend, relayUrl, unmount } = renderOwnerServer('wss://canary-switch.example', { persistentRelayUrl });
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
    const clientSk = generateSecretKey();

    await act(async () => {
      ws.deliver(buildClientRequest({
        clientSk,
        targetPubkey: ownerBackend.activePublicKeyHex,
        id: 'switch-relays',
        method: 'switch_relays',
        params: [],
      }));
    });
    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(decryptServerResponse(clientSk, ws.published[0])).toEqual({
      id: 'switch-relays',
      result: JSON.stringify(expected),
    });
    unmount();
  });

  it('serves NIP-44 only after the explicit NostrConnect approval is persisted', async () => {
    const { ownerBackend, relayUrl, unmount } = renderOwnerServer('wss://canary-nip44.example');
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
    const clientSk = generateSecretKey();
    const clientPubkey = getPublicKey(clientSk);
    const peerSk = generateSecretKey();
    const peerPubkey = getPublicKey(peerSk);

    await saveConnectedClient(buildConnectedClientFromNostrConnect({
      clientPubkey,
      relayUrl,
      relayUrls: [relayUrl],
      secret: 'secret-echoed-before-server-traffic',
      appName: 'Canary',
      appUrl: 'https://canary.trotters.cc',
    }, 1_770_000_000));

    await act(async () => {
      ws.deliver(buildClientRequest({
        clientSk,
        targetPubkey: ownerBackend.activePublicKeyHex,
        id: 'nip44',
        method: 'nip44_encrypt',
        params: [peerPubkey, 'strict path plaintext'],
      }));
    });

    await waitFor(() => expect(ws.published).toHaveLength(1));
    const response = decryptServerResponse(clientSk, ws.published[0]);
    expect(response.id).toBe('nip44');
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(expect.any(String));
    expect(decrypt(response.result!, getConversationKey(peerSk, ownerBackend.activePublicKeyHex))).toBe('strict path plaintext');

    await deleteConnectedClient(clientPubkey);
    unmount();
  });

  it('serves NIP-04 encrypt and decrypt after the explicit NostrConnect approval is persisted', async () => {
    const { ownerBackend, relayUrl, unmount } = renderOwnerServer('wss://canary-nip04.example');
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
    const clientSk = generateSecretKey();
    const clientPubkey = getPublicKey(clientSk);
    const peerSk = generateSecretKey();
    const peerPubkey = getPublicKey(peerSk);

    await saveConnectedClient(buildConnectedClientFromNostrConnect({
      clientPubkey,
      relayUrl,
      relayUrls: [relayUrl],
      secret: 'secret-echoed-before-nip04',
      appName: 'Canary',
      appUrl: 'https://canary.trotters.cc',
    }, 1_770_000_000));

    await act(async () => {
      ws.deliver(buildClientRequest({
        clientSk,
        targetPubkey: ownerBackend.activePublicKeyHex,
        id: 'nip04-encrypt',
        method: 'nip04_encrypt',
        params: [peerPubkey, 'legacy plaintext'],
      }));
    });

    await waitFor(() => expect(ws.published).toHaveLength(1));
    const encryptResponse = decryptServerResponse(clientSk, ws.published[0]);
    expect(encryptResponse.id).toBe('nip04-encrypt');
    expect(encryptResponse.error).toBeUndefined();
    expect(encryptResponse.result).toEqual(expect.any(String));
    expect(nip04Decrypt(peerSk, ownerBackend.activePublicKeyHex, encryptResponse.result!)).toBe('legacy plaintext');

    const incomingCiphertext = nip04Encrypt(peerSk, ownerBackend.activePublicKeyHex, 'incoming legacy plaintext');
    await act(async () => {
      ws.deliver(buildClientRequest({
        clientSk,
        targetPubkey: ownerBackend.activePublicKeyHex,
        id: 'nip04-decrypt',
        method: 'nip04_decrypt',
        params: [peerPubkey, incomingCiphertext],
      }));
    });

    await waitFor(() => expect(ws.published).toHaveLength(2));
    expect(decryptServerResponse(clientSk, ws.published[1])).toEqual({
      id: 'nip04-decrypt',
      result: 'incoming legacy plaintext',
    });

    await deleteConnectedClient(clientPubkey);
    unmount();
  });

  it('queues owner NIP-44 from a client with no saved approval instead of refusing it (#189)', async () => {
    const { ownerBackend, relayUrl, result, unmount } = renderOwnerServer('wss://canary-queued.example');
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
    const clientSk = generateSecretKey();
    const peerPubkey = getPublicKey(generateSecretKey());

    await act(async () => {
      ws.deliver(buildClientRequest({
        clientSk,
        targetPubkey: ownerBackend.activePublicKeyHex,
        id: 'nip44-queued',
        method: 'nip44_encrypt',
        params: [peerPubkey, 'held plaintext'],
      }));
    });

    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    const pending = result.current.pendingApprovals[0];
    expect(pending.method).toBe('nip44_encrypt');
    expect(pending.route.dependantId).toBeNull();
    // Nothing runs, and nothing is answered, until the owner decides.
    expect(ws.published).toHaveLength(0);

    await act(async () => { await result.current.deny(pending.handle); });
    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(decryptServerResponse(clientSk, ws.published[0])).toEqual({
      id: 'nip44-queued',
      error: 'user denied',
    });
    expect(result.current.pendingApprovals).toHaveLength(0);
    unmount();
  });

  it('a Stash-style vault-key unwrap asks once, then "Allow always" answers later unwraps silently (#189)', async () => {
    const { ownerBackend, relayUrl, result, unmount } = renderOwnerServer('wss://canary-always.example');
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
    const clientSk = generateSecretKey();
    const clientPubkey = getPublicKey(clientSk);
    const self = ownerBackend.activePublicKeyHex;
    // Data the owner encrypted to themselves, as Stash wraps its vault key.
    const wrapped = await ownerBackend.nip44Encrypt(self, 'vault key bytes');

    await act(async () => {
      ws.deliver(buildClientRequest({
        clientSk, targetPubkey: self, id: 'unwrap-1', method: 'nip44_decrypt', params: [self, wrapped],
      }));
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    const pending = result.current.pendingApprovals[0];
    expect(pending.description).toBe('Decrypt data you encrypted to yourself');
    expect(pending.alwaysAvailable).toBe(true);

    await act(async () => { await result.current.approveAlways(pending.handle); });
    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(decryptServerResponse(clientSk, ws.published[0])).toEqual({ id: 'unwrap-1', result: 'vault key bytes' });
    expect((await getConnectedClient(clientPubkey))?.allowAlways).toBe(true);

    await act(async () => {
      ws.deliver(buildClientRequest({
        clientSk, targetPubkey: self, id: 'unwrap-2', method: 'nip44_decrypt', params: [self, wrapped],
      }));
    });
    await waitFor(() => expect(ws.published).toHaveLength(2));
    expect(decryptServerResponse(clientSk, ws.published[1])).toEqual({ id: 'unwrap-2', result: 'vault key bytes' });
    expect(result.current.pendingApprovals).toHaveLength(0);

    await deleteConnectedClient(clientPubkey);
    unmount();
  });

  it('"Allow once" answers one owner NIP-44 request and saves nothing (#189)', async () => {
    const { ownerBackend, relayUrl, result, unmount } = renderOwnerServer('wss://canary-once.example');
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
    const clientSk = generateSecretKey();
    const clientPubkey = getPublicKey(clientSk);
    const peerSk = generateSecretKey();
    const peerPubkey = getPublicKey(peerSk);
    const incoming = encrypt('hello', getConversationKey(peerSk, ownerBackend.activePublicKeyHex));

    const ask = async (id: string) => {
      await act(async () => {
        ws.deliver(buildClientRequest({
          clientSk, targetPubkey: ownerBackend.activePublicKeyHex, id, method: 'nip44_decrypt', params: [peerPubkey, incoming],
        }));
      });
    };
    await ask('once-1');
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    expect(result.current.pendingApprovals[0].description).toMatch(/^Decrypt a message from npub1/);
    await act(async () => { await result.current.approveOnce(result.current.pendingApprovals[0].handle); });
    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(decryptServerResponse(clientSk, ws.published[0])).toEqual({ id: 'once-1', result: 'hello' });
    expect(await getConnectedClient(clientPubkey)).toBeUndefined();

    // The next request asks again.
    await ask('once-2');
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    expect(ws.published).toHaveLength(1);
    unmount();
  });

  it('ignores a saved client that addresses an owner persona other than the one it paired with (#194)', async () => {
    const personaA = new LocalSigningBackend(bytesToHex(generateSecretKey()));
    const personaB = new LocalSigningBackend(bytesToHex(generateSecretKey()));
    const relayUrl = 'wss://canary-bound.example';
    const { unmount } = renderHook(() => useBunkerServer({
      enabled: true,
      relayUrl,
      routes: [
        { pubkey: personaA.activePublicKeyHex, backend: personaA },
        { pubkey: personaB.activePublicKeyHex, backend: personaB },
      ],
      isOwnerServingActive: () => true,
    }));
    await waitFor(() => expect(MockRelaySocket.instances[0]?.subId).toBeTruthy());
    const ws = MockRelaySocket.instances[0];
    const clientSk = generateSecretKey();
    const clientPubkey = getPublicKey(clientSk);
    await saveConnectedClient({
      clientPubkey, appName: 'Bark', connectedAt: 1, lastSeenAt: 1, allowAlways: true,
      boundPubkey: personaA.activePublicKeyHex,
    });

    // To persona B: no reply of any kind, not even a refusal.
    await act(async () => {
      ws.deliver(buildClientRequest({ clientSk, targetPubkey: personaB.activePublicKeyHex, id: 'to-b', method: 'get_public_key', params: [] }));
    });
    // To persona A, after it: answered. Ordering proves B was dropped, not slow.
    await act(async () => {
      ws.deliver(buildClientRequest({ clientSk, targetPubkey: personaA.activePublicKeyHex, id: 'to-a', method: 'get_public_key', params: [] }));
    });
    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(ws.published[0].pubkey).toBe(personaA.activePublicKeyHex);
    expect(decryptServerResponse(clientSk, ws.published[0])).toEqual({ id: 'to-a', result: personaA.activePublicKeyHex });

    await deleteConnectedClient(clientPubkey);
    unmount();
  });

  it.each(['approved', 'expired', 'wrong secret', 'wrong persona', 'persistence failure', 'no persistence handler'] as const)(
    'checks fresh QR consent before changing an existing persona binding: %s', async mode => {
      const personaA = new LocalSigningBackend(bytesToHex(generateSecretKey()));
      const personaB = new LocalSigningBackend(bytesToHex(generateSecretKey()));
      const clientSk = generateSecretKey(), clientPubkey = getPublicKey(clientSk);
      const secret = 'fresh-qr-pairing-secret';
      const pendingAuthPairingsRef = { current: new Map([[secret, {
        origin: 'https://kithmoot.example', appName: 'KithMoot',
        signingPubkey: mode === 'wrong persona' ? personaA.activePublicKeyHex : personaB.activePublicKeyHex,
        expiresAt: Date.now() + (mode === 'expired' ? -60_000 : 60_000),
      }]]) };
      const persist = vi.fn(async ({ signingPubkey }: { signingPubkey: string }) => {
        if (mode === 'persistence failure') throw new Error('write failed');
        const existing = (await getConnectedClient(clientPubkey))!;
        await saveConnectedClient({ ...existing, boundPubkey: signingPubkey });
      });
      await saveConnectedClient({ clientPubkey, appName: 'KithMoot', connectedAt: 1, lastSeenAt: 1,
        allowAlways: true, boundPubkey: personaA.activePublicKeyHex });
      const h = renderHook(() => useBunkerServer({
        enabled: true, relayUrl: 'wss://qr-repair.example', isOwnerServingActive: () => true,
        routes: [personaA, personaB].map(backend => ({ pubkey: backend.activePublicKeyHex, backend })),
        pendingAuthPairingsRef, onAuthFlowPairingComplete: mode === 'no persistence handler' ? undefined : persist,
      }));
      await waitFor(() => expect(MockRelaySocket.instances[0]?.subId).toBeTruthy());
      const ws = MockRelaySocket.instances[0];
      const ask = (backend: LocalSigningBackend, id: string, method: string, params: string[] = []) =>
        ws.deliver(buildClientRequest({ clientSk, targetPubkey: backend.activePublicKeyHex, id, method, params }));
      try {
        await act(async () => { ask(personaB, 'new-qr-connect', 'connect', [personaB.activePublicKeyHex,
          mode === 'wrong secret' ? 'some-other-secret' : secret]); });
        if (mode === 'approved' || mode === 'persistence failure') {
          await waitFor(() => expect(ws.published).toHaveLength(1));
          expect(decryptServerResponse(clientSk, ws.published[0])).toEqual(mode === 'approved'
            ? { id: 'new-qr-connect', result: 'ack' }
            : { id: 'new-qr-connect', error: 'pairing failed — try again' });
          expect(persist).toHaveBeenCalledOnce();
          expect(pendingAuthPairingsRef.current.has(secret)).toBe(mode !== 'approved');
        } else expect(persist).not.toHaveBeenCalled();
        const expected = mode === 'approved' ? personaB : personaA;
        const other = mode === 'approved' ? personaA : personaB;
        // The old persona still stays silent unless fresh consent was persisted.
        await act(async () => { ask(other, 'unapproved-persona', 'get_public_key'); });
        await act(async () => { ask(expected, 'approved-persona', 'get_public_key'); });
        await waitFor(() => expect(ws.published).toHaveLength(mode === 'approved' || mode === 'persistence failure' ? 2 : 1));
        expect(decryptServerResponse(clientSk, ws.published.at(-1)!)).toEqual({ id: 'approved-persona', result: expected.activePublicKeyHex });
        expect((await getConnectedClient(clientPubkey))?.boundPubkey).toBe(expected.activePublicKeyHex);
        if (mode === 'approved') {
          // A consumed secret cannot take the client back to the old persona.
          await act(async () => { ask(personaA, 'spent-secret', 'connect', [personaA.activePublicKeyHex, secret]); });
          await act(async () => { ask(personaB, 'sign-after-qr', 'sign_event', [JSON.stringify({
            kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'after explicit QR approval',
          })]); });
          await waitFor(() => expect(ws.published).toHaveLength(3));
          const response = decryptServerResponse(clientSk, ws.published[2]);
          expect(response.id).toBe('sign-after-qr');
          const signed = JSON.parse(response.result!);
          expect(signed.pubkey).toBe(personaB.activePublicKeyHex);
          expect(signed.content).toBe('after explicit QR approval');
          expect(verifyEvent(signed)).toBe(true);
        }
      } finally { h.unmount(); await deleteConnectedClient(clientPubkey); }
    },
  );

  it('binds a pre-binding saved client to the first owner persona it uses (#194)', async () => {
    const personaA = new LocalSigningBackend(bytesToHex(generateSecretKey()));
    const personaB = new LocalSigningBackend(bytesToHex(generateSecretKey()));
    const relayUrl = 'wss://canary-lazybind.example';
    const { unmount } = renderHook(() => useBunkerServer({
      enabled: true,
      relayUrl,
      routes: [
        { pubkey: personaA.activePublicKeyHex, backend: personaA },
        { pubkey: personaB.activePublicKeyHex, backend: personaB },
      ],
      isOwnerServingActive: () => true,
    }));
    await waitFor(() => expect(MockRelaySocket.instances[0]?.subId).toBeTruthy());
    const ws = MockRelaySocket.instances[0];
    const clientSk = generateSecretKey();
    const clientPubkey = getPublicKey(clientSk);
    await saveConnectedClient({ clientPubkey, appName: 'Legacy', connectedAt: 1, lastSeenAt: 1, allowAlways: true });

    await act(async () => {
      ws.deliver(buildClientRequest({ clientSk, targetPubkey: personaB.activePublicKeyHex, id: 'first', method: 'get_public_key', params: [] }));
    });
    await waitFor(() => expect(ws.published).toHaveLength(1));
    await waitFor(async () => expect((await getConnectedClient(clientPubkey))?.boundPubkey).toBe(personaB.activePublicKeyHex));

    await act(async () => {
      ws.deliver(buildClientRequest({ clientSk, targetPubkey: personaA.activePublicKeyHex, id: 'other', method: 'get_public_key', params: [] }));
    });
    await act(async () => {
      ws.deliver(buildClientRequest({ clientSk, targetPubkey: personaB.activePublicKeyHex, id: 'again', method: 'get_public_key', params: [] }));
    });
    await waitFor(() => expect(ws.published).toHaveLength(2));
    expect(decryptServerResponse(clientSk, ws.published[1]).id).toBe('again');

    await deleteConnectedClient(clientPubkey);
    unmount();
  });

  it('"Allow always" on an owner request binds the client to that persona (#194)', async () => {
    const { ownerBackend, relayUrl, result, unmount } = renderOwnerServer('wss://canary-bind-on-allow.example');
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
    const clientSk = generateSecretKey();
    const clientPubkey = getPublicKey(clientSk);
    const self = ownerBackend.activePublicKeyHex;
    const wrapped = await ownerBackend.nip44Encrypt(self, 'k');
    await act(async () => {
      ws.deliver(buildClientRequest({ clientSk, targetPubkey: self, id: 'bind', method: 'nip44_decrypt', params: [self, wrapped] }));
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    await act(async () => { await result.current.approveAlways(result.current.pendingApprovals[0].handle); });
    await waitFor(async () => expect((await getConnectedClient(clientPubkey))?.boundPubkey).toBe(self));
    await deleteConnectedClient(clientPubkey);
    unmount();
  });

  it('rejects queued owner approvals when the serve socket tears down', async () => {
    const { ownerBackend, relayUrl, result, unmount } = renderOwnerServer('wss://canary-teardown.example');
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
    const clientSk = generateSecretKey();
    const template = {
      kind: 1,
      pubkey: '',
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'pending owner approval',
    };

    await act(async () => {
      ws.deliver(buildClientRequest({
        clientSk,
        targetPubkey: ownerBackend.activePublicKeyHex,
        id: 'pending-sign',
        method: 'sign_event',
        params: [JSON.stringify(template)],
      }));
    });

    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    unmount();

    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(decryptServerResponse(clientSk, ws.published[0])).toEqual({
      id: 'pending-sign',
      error: 'serving stopped',
    });
  });
});

describe('replayed requests on a rebuilt subscription', () => {
  it('handles each request event once: a replay after a resubscribe costs no second decrypt or reply', async () => {
    const ownerSk = generateSecretKey();
    const ownerBackend = new LocalSigningBackend(bytesToHex(ownerSk));
    const decryptSpy = vi.spyOn(ownerBackend, 'nip44Decrypt');
    const relayUrl = 'wss://canary-replay.example';
    const { unmount, rerender } = renderHook(({ nonce }) => useBunkerServer({
      enabled: true,
      relayUrl,
      routes: [{ pubkey: ownerBackend.activePublicKeyHex, backend: ownerBackend }],
      isOwnerServingActive: () => true,
      reconnectNonce: nonce,
    }), { initialProps: { nonce: 0 } });
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
    const clientSk = generateSecretKey();
    const request = buildClientRequest({
      clientSk,
      targetPubkey: ownerBackend.activePublicKeyHex,
      id: 'get-pubkey-once',
      method: 'get_public_key',
      params: [],
    });

    await act(async () => { ws.deliver(request); });
    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(decryptSpy).toHaveBeenCalledTimes(1);

    // The same event again on this socket (relay duplicate)...
    await act(async () => { ws.deliver(request); });
    // ...and on a rebuilt subscription, which replays the last 60 s.
    rerender({ nonce: 1 });
    await waitFor(() => {
      const latest = MockRelaySocket.instances[MockRelaySocket.instances.length - 1];
      expect(latest).not.toBe(ws);
      expect(latest.readyState).toBe(MockRelaySocket.OPEN);
      expect(latest.subId).toBeTruthy();
    });
    const replaySocket = MockRelaySocket.instances[MockRelaySocket.instances.length - 1];
    await act(async () => { replaySocket.deliver(request); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });

    expect(decryptSpy).toHaveBeenCalledTimes(1);
    expect(ws.published).toHaveLength(1);
    expect(replaySocket.published).toHaveLength(0);
    unmount();
  });
});

describe('a served route whose key lives on the paired signer', () => {
  it('never serves its own outgoing requests: one external request costs a bounded number of signer calls', async () => {
    // A routed backend: every call it makes is a NIP-46 request authored by
    // this app's client key and addressed to the route pubkey — on the same
    // relay the server listens on. Model that by echoing each call back into
    // the subscription, as the relay would.
    const personaSk = generateSecretKey();
    const inner = new LocalSigningBackend(bytesToHex(personaSk));
    const clientSk = generateSecretKey();      // this app's NIP-46 client key
    const transportClientPubkeyHex = getPublicKey(clientSk);
    let ws: MockRelaySocket | null = null;
    let calls = 0;
    const echoOutgoingRequest = () => {
      calls += 1;
      if (calls > 60 || !ws) return;           // hard stop for the loop in the unfixed code
      const socket = ws;
      const echo = buildClientRequest({
        clientSk,
        targetPubkey: inner.activePublicKeyHex,
        id: `outgoing-${calls}`,
        method: 'nip44_decrypt',
        params: ['x', 'y'],
      });
      setTimeout(() => { try { socket.deliver(echo); } catch { /* socket gone */ } }, 0);
    };
    const routed = {
      type: 'bunker' as const,
      activePublicKeyHex: inner.activePublicKeyHex,
      transportClientPubkeyHex,
      signEvent: async (e: Parameters<typeof inner.signEvent>[0]) => { echoOutgoingRequest(); return inner.signEvent(e); },
      nip44Encrypt: async (pk: string, pt: string) => { echoOutgoingRequest(); return inner.nip44Encrypt(pk, pt); },
      nip44Decrypt: async (pk: string, ct: string) => { echoOutgoingRequest(); return inner.nip44Decrypt(pk, ct); },
      destroy: () => {},
    };
    const relayUrl = 'wss://canary-routed-loop.example';
    const { unmount } = renderHook(() => useBunkerServer({
      enabled: true,
      relayUrl,
      routes: [{ pubkey: routed.activePublicKeyHex, backend: routed as never }],
      isOwnerServingActive: () => true,
    }));
    ws = await waitForOpenRelay(routed.activePublicKeyHex, relayUrl);

    const externalSk = generateSecretKey();
    await act(async () => {
      ws!.deliver(buildClientRequest({
        clientSk: externalSk,
        targetPubkey: routed.activePublicKeyHex,
        id: 'external-get-pubkey',
        method: 'get_public_key',
        params: [],
      }));
    });
    await waitFor(() => expect(ws!.published.length).toBeGreaterThanOrEqual(1));
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // decrypt the request + encrypt and sign the reply: 3 signer calls, no loop.
    expect(calls).toBeLessThanOrEqual(3);
    expect(ws.published).toHaveLength(1);
    unmount();
  });
});

describe('dedicated bot dispatch', () => {
  it('never falls through to owner approval or identity decryption when a bot handler is missing', async () => {
    const backend = new LocalSigningBackend(bytesToHex(generateSecretKey())), decrypt = vi.spyOn(backend, 'nip44Decrypt');
    const { result, unmount } = renderOwnerServer('wss://bot-relay.test', {
      routes: [{ source: 'bot', pubkey: backend.activePublicKeyHex, backend }],
    });
    const socket = await waitForOpenRelay(backend.activePublicKeyHex, 'wss://bot-relay.test');
    await act(async () => socket.deliver(buildClientRequest({ clientSk: generateSecretKey(), targetPubkey: backend.activePublicKeyHex,
      id: 'bot-only', method: 'get_public_key', params: [] })));
    expect(decrypt).not.toHaveBeenCalled(); expect(socket.published).toHaveLength(0);
    expect(result.current.pendingApproval).toBeNull(); unmount(); backend.destroy();
  });
  it('dispatches through the explicit bot handler and refuses its delayed reply after the route is removed', async () => {
    const backend = new LocalSigningBackend(bytesToHex(generateSecretKey())), decrypt = vi.spyOn(backend, 'nip44Decrypt');
    let send!: (response: NostrEvent) => boolean;
    const handler = vi.fn(async (_event: NostrEvent, publish: typeof send) => { send = publish; });
    const { unmount } = renderOwnerServer('wss://bot-relay.test', {
      routes: [{ source: 'bot', pubkey: backend.activePublicKeyHex, backend, handleBotEvent: handler }],
      isOwnerServingActive: () => false,
    });
    const socket = await waitForOpenRelay(backend.activePublicKeyHex, 'wss://bot-relay.test');
    await act(async () => socket.deliver(buildClientRequest({ clientSk: generateSecretKey(), targetPubkey: backend.activePublicKeyHex,
      id: 'bot-only', method: 'get_public_key', params: [] })));
    expect(handler).toHaveBeenCalledOnce(); expect(decrypt).not.toHaveBeenCalled();
    unmount();
    expect(send({ pubkey: backend.activePublicKeyHex, kind: 24133 } as NostrEvent)).toBe(false);
    expect(socket.published).toHaveLength(0); backend.destroy();
  });
});

describe('explicit Kinterest family authority', () => {
  function template() {
    return { kind:30078,pubkey:'',created_at:Math.floor(Date.now()/1000),content:'Authorise this family key to manage Kinterest and its encrypted family backup.',
      tags:[['d',`kin-jar/family-authorisation/v2/${'a'.repeat(64)}`],['scope','kin-jar:family:v2'],['family','a'.repeat(64)],['challenge','b'.repeat(64)],['approval','request']] };
  }
  /** Owner-route harness; `authority` is the kinterestAuthorityPubkey ('owner' = the route's own pubkey) and can be changed with rerender. */
  function renderKin(authority: string | undefined) {
    const ownerBackend = new LocalSigningBackend(bytesToHex(generateSecretKey())), relayUrl = 'wss://canary-relay.example';
    const hook = renderHook(({ authority: a }: { authority: string | undefined }) => useBunkerServer({ enabled: true, relayUrl, isOwnerServingActive: () => true,
      routes: [{ pubkey: ownerBackend.activePublicKeyHex, backend: ownerBackend }], kinterestAuthorityPubkey: a === 'owner' ? ownerBackend.activePublicKeyHex : a }),
      { initialProps: { authority } });
    return { ...hook, ownerBackend, relayUrl };
  }
  function childTemplate() {
    return { kind:30078,pubkey:'',created_at:Math.floor(Date.now()/1000),content:CHILD_PURPOSE,
      tags:[['d',`kin-jar/child-selection/v2/${'a'.repeat(64)}`],['scope','kin-jar:family:v2'],['family','a'.repeat(64)],['challenge','b'.repeat(64)],['approval','request'],['child','c'.repeat(64)],['device','d'.repeat(64)],['role','child-phone']] };
  }
  async function expectRefused(authority: string | undefined, tpl: ReturnType<typeof template> | ReturnType<typeof childTemplate>) {
    const { ownerBackend, relayUrl, result, unmount } = renderKin(authority), signing = vi.spyOn(ownerBackend, 'signEvent');
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex,relayUrl), clientSk = generateSecretKey();
    await act(async () => ws.deliver(buildClientRequest({clientSk,targetPubkey:ownerBackend.activePublicKeyHex,id:'wrong-route',method:'sign_event',params:[JSON.stringify(tpl)]})));
    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(decryptServerResponse(clientSk,ws.published[0])).toMatchObject({ id:'wrong-route', error:'Kinterest authority needs your real identity' });
    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(signing.mock.calls.some(([e]) => e.kind === 30078)).toBe(false);
    unmount();
  }
  it('refuses a family authorisation on a route that is not the real identity', async () => {
    await expectRefused(getPublicKey(generateSecretKey()), template());
  });
  it('refuses a family authorisation when no real identity is active', async () => {
    await expectRefused(undefined, template());
  });
  it('refuses a child selection on a persona route on arrival', async () => {
    await expectRefused(getPublicKey(generateSecretKey()), childTemplate());
  });
  it('fails signing when the real identity stops being active between request and approval', async () => {
    for (const later of [getPublicKey(generateSecretKey()), undefined]) {
      const { ownerBackend, relayUrl, result, rerender, unmount } = renderKin('owner'), signing = vi.spyOn(ownerBackend, 'signEvent');
      const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex,relayUrl), clientSk = generateSecretKey();
      await act(async () => ws.deliver(buildClientRequest({clientSk,targetPubkey:ownerBackend.activePublicKeyHex,id:'late',method:'sign_event',params:[JSON.stringify(template())]})));
      await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
      rerender({ authority: later });
      await act(async () => result.current.approveOnce(result.current.pendingApprovals[0].handle));
      await waitFor(() => expect(ws.published).toHaveLength(1));
      expect(decryptServerResponse(clientSk,ws.published[0])).toMatchObject({ id:'late', error:'signing failed' });
      expect(signing.mock.calls.some(([e]) => e.kind === 30078)).toBe(false);
      unmount(); MockRelaySocket.instances.length = 0;
    }
  });
  it('requires a fresh decision despite remembered allow-always, and never grants always for this ceremony', async () => {
    const { ownerBackend, relayUrl, result, unmount } = renderKin('owner');
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex,relayUrl), clientSk = generateSecretKey(), pk = getPublicKey(clientSk);
    await saveConnectedClient({clientPubkey:pk,appName:'Kinterest',connectedAt:1,lastSeenAt:1,allowAlways:true});
    await act(async () => ws.deliver(buildClientRequest({clientSk,targetPubkey:ownerBackend.activePublicKeyHex,id:'consent',method:'sign_event',params:[JSON.stringify(template())]})));
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    expect(ws.published).toHaveLength(0);
    const handle = result.current.pendingApprovals[0].handle;
    await act(async () => result.current.approveAlways(handle));
    await waitFor(() => expect(ws.published).toHaveLength(1));
    const response = decryptServerResponse(clientSk,ws.published[0]);
    expect(response.error).toBeUndefined();
    expect(JSON.parse(response.result!).tags).toContainEqual(['approval','confirmed']);
    await act(async () => ws.deliver(buildClientRequest({clientSk,targetPubkey:ownerBackend.activePublicKeyHex,id:'second',method:'sign_event',params:[JSON.stringify({...template(),tags:template().tags.map(t => t[0] === 'challenge' ? ['challenge','c'.repeat(64)] : t)})]})));
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    expect(ws.published).toHaveLength(1);
    unmount();
  });
  it('refuses a reserved but malformed request instead of signing it through a generic grant', async () => {
    const { ownerBackend, relayUrl, result, unmount } = renderKin('owner');
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex,relayUrl), clientSk = generateSecretKey(), pk = getPublicKey(clientSk);
    await saveConnectedClient({clientPubkey:pk,appName:'Kinterest',connectedAt:1,lastSeenAt:1,allowAlways:true});
    await act(async () => ws.deliver(buildClientRequest({clientSk,targetPubkey:ownerBackend.activePublicKeyHex,id:'malformed',method:'sign_event',params:[JSON.stringify({...template(),kind:1})]})));
    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(decryptServerResponse(clientSk,ws.published[0]).error).toBeTruthy();
    expect(result.current.pendingApprovals).toHaveLength(0);
    unmount();
  });
});

describe('dependant trusted-app reconnect and approval identity', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  async function setup(secret?: string, key: string | null = 'unlocked') {
    const clientSk = generateSecretKey();
    const backend = new LocalSigningBackend(bytesToHex(generateSecretKey()));
    const dependantId = getPublicKey(generateSecretKey());
    const pairings: TrustedAppPairing[] = [{ clientPubkey: getPublicKey(clientSk), label: 'Kindependence', origin: 'https://kindependence.example', pairedAt: 1 }];
    const lookup = vi.spyOn(db, 'listAppBunkerPairings').mockImplementation(async () => [...pairings]);
    const bind = vi.fn(async () => {});
    const hook = renderOwnerServer('wss://dependant-reconnect.example', {
      routes: [{ pubkey: backend.activePublicKeyHex, backend, dependantId, routeKind: 'app', pairingSecret: secret }],
      appPairingsEncryptionKey: key,
      onAppPairingComplete: bind,
    });
    const ws = await waitForOpenRelay(backend.activePublicKeyHex, hook.relayUrl);
    let serial = 0;
    async function send(method: string, params: string[], sender = clientSk) {
      const id = `trusted-${++serial}`;
      await act(async () => { ws.deliver(buildClientRequest({ clientSk: sender, targetPubkey: backend.activePublicKeyHex, id, method, params })); });
      await waitFor(() => expect(ws.published.some(e => e.tags.some(t => t[0] === 'p' && t[1] === getPublicKey(sender)) && decryptServerResponse(sender, e).id === id)).toBe(true));
      return decryptServerResponse(sender, ws.published.find(e => e.tags.some(t => t[0] === 'p' && t[1] === getPublicKey(sender)) && decryptServerResponse(sender, e).id === id)!);
    }
    return { ...hook, ws, backend, clientSk, dependantId, pairings, lookup, bind, send };
  }

  it('ACKs a stored pairing after its one-use secret was cleared, without rebinding', async () => {
    const h = await setup();
    expect(await h.send('connect', [h.backend.activePublicKeyHex, 'old-secret'])).toMatchObject({ result: 'ack' });
    expect(h.lookup).toHaveBeenCalledWith(h.dependantId, 'unlocked');
    expect(h.bind).not.toHaveBeenCalled();
  });

  it('rejects unknown and subsequently revoked clients with no pair window', async () => {
    const h = await setup();
    expect(await h.send('connect', ['', ''], generateSecretKey())).toMatchObject({ error: 'pairing not active' });
    expect(await h.send('connect', ['', ''])).toMatchObject({ result: 'ack' });
    h.pairings.length = 0;
    expect(await h.send('connect', ['', ''])).toMatchObject({ error: 'pairing not active' });
    expect(await h.send('get_public_key', [])).toMatchObject({ error: 'not paired' });
  });

  it('fails closed when locked or when the pairing lookup fails', async () => {
    const h = await setup(undefined, null);
    expect(await h.send('connect', ['', ''])).toMatchObject({ error: 'pairing not active' });
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it('fails closed on a failed encrypted pairing read', async () => {
    const h = await setup(); h.lookup.mockRejectedValue(new Error('locked'));
    expect(await h.send('connect', ['', ''])).toMatchObject({ error: 'pairing not active' });
  });

  it('keeps a fresh pair window intact when an existing client reconnects', async () => {
    const h = await setup('fresh-secret');
    expect(await h.send('connect', ['', 'old-secret'])).toMatchObject({ result: 'ack' });
    expect(h.bind).not.toHaveBeenCalled();
    expect(await h.send('connect', ['', 'wrong-secret'], generateSecretKey())).toMatchObject({ error: 'invalid secret' });
    const newClient = generateSecretKey();
    expect(await h.send('connect', ['', 'fresh-secret', JSON.stringify({ name: 'Another app' })], newClient)).toMatchObject({ result: 'ack' });
    expect(h.bind).toHaveBeenCalledWith(h.dependantId, getPublicKey(newClient), 'Another app', undefined);
  });

  it('shows the authorised app label in a dependant approval without auto-approving', async () => {
    const h = await setup();
    await act(async () => { h.ws.deliver(buildClientRequest({ clientSk: h.clientSk, targetPubkey: h.backend.activePublicKeyHex, id: 'label-sign', method: 'sign_event', params: [JSON.stringify({ kind: 30078, tags: [], content: '', created_at: Math.floor(Date.now()/1000) })] })); });
    await waitFor(() => expect(h.result.current.pendingApprovals).toHaveLength(1));
    expect(h.result.current.pendingApprovals[0].client).toMatchObject({ appName: 'Kindependence', appUrl: 'https://kindependence.example' });
    expect(h.ws.published).toHaveLength(0);
    await act(async () => { await h.result.current.approveOnce(h.result.current.pendingApprovals[0].handle); });
    await waitFor(() => expect(h.ws.published).toHaveLength(1));
  });
});


describe('approval replies across socket reconnects', () => {
  async function setup() {
    const ownerBackend = new LocalSigningBackend(bytesToHex(generateSecretKey()));
    const relayUrl = 'wss://approval-reconnect.example';
    const hook = renderHook(({ nonce, enabled, relay }) => useBunkerServer({
      enabled, relayUrl: relay,
      routes: [{ pubkey: ownerBackend.activePublicKeyHex, backend: ownerBackend }],
      isOwnerServingActive: () => true, reconnectNonce: nonce,
    }), { initialProps: { nonce: 0, enabled: true, relay: relayUrl } });
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
    const clientSk = generateSecretKey();
    await act(async () => ws.deliver(buildClientRequest({
      clientSk, targetPubkey: ownerBackend.activePublicKeyHex,
      id: 'approve-reconnect', method: 'sign_event',
      params: [JSON.stringify({ kind: 1, pubkey: '', created_at: Math.floor(Date.now() / 1000), tags: [], content: 'approve once' })],
    })));
    await waitFor(() => expect(hook.result.current.pendingApproval).not.toBeNull());
    return { ...hook, ownerBackend, ws, clientSk, relayUrl };
  }

  async function latestSocket(old: MockRelaySocket) {
    await waitFor(() => {
      expect(MockRelaySocket.instances.at(-1)).not.toBe(old);
      expect(MockRelaySocket.instances.at(-1)?.readyState).toBe(MockRelaySocket.OPEN);
    });
    return MockRelaySocket.instances.at(-1)!;
  }

  it('delivers an approval on the replacement socket when encryption spans a resume reconnect', async () => {
    const h = await setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const encrypt = h.ownerBackend.nip44Encrypt.bind(h.ownerBackend);
    vi.spyOn(h.ownerBackend, 'nip44Encrypt').mockImplementationOnce(async (...args) => {
      await gate;
      return encrypt(...args);
    });
    const signing = vi.spyOn(h.ownerBackend, 'signEvent');
    let approval!: Promise<void>;
    await act(async () => { approval = h.result.current.approveOnce(h.result.current.pendingApproval!.handle); });
    h.rerender({ nonce: 1, enabled: true, relay: h.relayUrl });
    const replacement = await latestSocket(h.ws);
    await act(async () => { release(); await approval; });
    await waitFor(() => expect(replacement.published).toHaveLength(1));
    expect(h.ws.published).toHaveLength(0);
    const reply = decryptServerResponse(h.clientSk, replacement.published[0]);
    expect(reply.id).toBe('approve-reconnect');
    expect(JSON.parse(reply.result!).content).toBe('approve once');
    expect(signing).toHaveBeenCalledTimes(2); // user event + response envelope
  });

  it('buffers an approved reply while disconnected and sends it on reconnect', async () => {
    const h = await setup();
    await act(async () => { h.ws.close(); });
    await act(async () => { await h.result.current.approveOnce(h.result.current.pendingApproval!.handle); });
    const replacement = await latestSocket(h.ws);
    await waitFor(() => expect(replacement.published).toHaveLength(1));
    expect(decryptServerResponse(h.clientSk, replacement.published[0]).result).toBeTruthy();
  });

  it('preserves a waiting approval across the native resume reconnect kick', async () => {
    const h = await setup();
    const handle = h.result.current.pendingApproval!.handle;
    h.rerender({ nonce: 1, enabled: true, relay: h.relayUrl });
    const replacement = await latestSocket(h.ws);
    expect(h.result.current.pendingApproval!.handle).toBe(handle);
    await act(async () => { await h.result.current.approveOnce(handle); });
    expect(replacement.published).toHaveLength(1);
    expect(decryptServerResponse(h.clientSk, replacement.published[0]).result).toBeTruthy();
  });

  it.each([true, false])('does not replay a reply after relay OK accepted=%s', async accepted => {
    const h = await setup();
    h.ws.autoAck = false;
    await act(async () => { await h.result.current.approveOnce(h.result.current.pendingApproval!.handle); });
    await act(async () => { h.ws.ack(h.ws.published[0].id, accepted); h.ws.close(); });
    const replacement = await latestSocket(h.ws);
    expect(replacement.published).toHaveLength(0);
    if (!accepted) expect(h.result.current.serveStatus.lastNotice).toBe('blocked: test rejection');
  });

  it('replays the identical signed envelope when the connection drops before OK', async () => {
    const h = await setup();
    h.ws.autoAck = false;
    await act(async () => { await h.result.current.approveOnce(h.result.current.pendingApproval!.handle); });
    const original = h.ws.published[0];
    await act(async () => { h.ws.close(); });
    const replacement = await latestSocket(h.ws);
    await waitFor(() => expect(replacement.published).toEqual([original]));
  });

  it('expires buffered replies instead of replaying them after five minutes', async () => {
    const h = await setup();
    h.ws.autoAck = false;
    await act(async () => { await h.result.current.approveOnce(h.result.current.pendingApproval!.handle); });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 300_001);
    try {
      h.rerender({ nonce: 1, enabled: true, relay: h.relayUrl });
      const replacement = await latestSocket(h.ws);
      expect(replacement.published).toHaveLength(0);
    } finally { clock.mockRestore(); }
  });

  it('retains the reply if send throws and delivers it after reconnect', async () => {
    const h = await setup();
    const originalSend = h.ws.send.bind(h.ws);
    vi.spyOn(h.ws, 'send').mockImplementation(data => {
      if (JSON.parse(data)[0] === 'EVENT') throw new Error('socket closed during send');
      originalSend(data);
    });
    await act(async () => { await h.result.current.approveOnce(h.result.current.pendingApproval!.handle); });
    const replacement = await latestSocket(h.ws);
    expect(decryptServerResponse(h.clientSk, replacement.published[0]).result).toBeTruthy();
  });

  it('discards a user signature that completes after serving stops', async () => {
    const h = await setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sign = h.ownerBackend.signEvent.bind(h.ownerBackend);
    vi.spyOn(h.ownerBackend, 'signEvent').mockImplementationOnce(async template => { await gate; return sign(template); });
    let approval!: Promise<void>;
    await act(async () => { approval = h.result.current.approveOnce(h.result.current.pendingApproval!.handle); });
    h.rerender({ nonce: 0, enabled: false, relay: h.relayUrl });
    await act(async () => { release(); await approval; });
    expect(h.ws.published).toHaveLength(0);
  });

  it.each(['disable', 'relay', 'unmount'])('discards a late encrypted approval after %s', async change => {
    const h = await setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const encrypt = h.ownerBackend.nip44Encrypt.bind(h.ownerBackend);
    vi.spyOn(h.ownerBackend, 'nip44Encrypt').mockImplementationOnce(async (...args) => { await gate; return encrypt(...args); });
    let approval!: Promise<void>;
    await act(async () => { approval = h.result.current.approveOnce(h.result.current.pendingApproval!.handle); });
    if (change === 'unmount') h.unmount();
    else h.rerender({ nonce: 0, enabled: change !== 'disable', relay: change === 'relay' ? 'wss://different-relay.example' : h.relayUrl });
    await act(async () => { release(); await approval; });
    expect(MockRelaySocket.instances.flatMap(ws => ws.published)).toHaveLength(0);
  });
});

describe('M6: an owner persona\'s remembered allow-always never signs an app permission (kind 30420)', () => {
  afterEach(() => { MockRelaySocket.instances.length = 0; });
  const statement = (pubkey: string) => ({
    kind: 30420, created_at: Math.floor(Date.now() / 1000), content: '', pubkey,
    tags: [['d', 'twang'], ['p', getPublicKey(generateSecretKey())], ['valid_from', '1'], ['valid_until', '2'], ['v', '1'], ['role', 'player'], ['expiration', '2']],
  });

  it('asks again for a 30420, while an ordinary kind still goes through on the grant', async () => {
    const { result, ownerBackend, unmount } = renderOwnerServer('wss://m6-relay.example');
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, 'wss://m6-relay.example');
    const clientSk = generateSecretKey();
    await saveConnectedClient({ clientPubkey: getPublicKey(clientSk), appName: 'Twang', connectedAt: 1, lastSeenAt: 1, allowAlways: true });
    const signing = vi.spyOn(ownerBackend, 'signEvent');

    await act(async () => ws.deliver(buildClientRequest({ clientSk, targetPubkey: ownerBackend.activePublicKeyHex, id: 'perm', method: 'sign_event', params: [JSON.stringify(statement(ownerBackend.activePublicKeyHex))] })));
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    expect(ws.published).toHaveLength(0);
    expect(signing).not.toHaveBeenCalled();

    await act(async () => ws.deliver(buildClientRequest({ clientSk, targetPubkey: ownerBackend.activePublicKeyHex, id: 'note', method: 'sign_event', params: [JSON.stringify({ kind: 1, created_at: 1, tags: [], content: 'hi' })] })));
    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(decryptServerResponse(clientSk, ws.published[0])).toMatchObject({ id: 'note' });
    unmount();
  });
});


describe('explicit NIP-46 connection scopes at the server boundary', () => {
  it('refuses unrequested signing/crypto and widening connect; scoped deletion always prompts', async () => {
    const { ownerBackend, relayUrl, result, unmount } = renderOwnerServer('wss://scoped.example');
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
    const clientSk = generateSecretKey(), clientPubkey = getPublicKey(clientSk);
    await saveConnectedClient(buildConnectedClientFromNostrConnect({ clientPubkey, relayUrl, relayUrls: [relayUrl], secret: 'scoped-secret', appName: 'Game', permissions: ['sign_event:30420', 'sign_event:5'] }));
    async function send(id: string, method: string, params: string[]) {
      const count = ws.published.length;
      await act(async () => { ws.deliver(buildClientRequest({ clientSk, targetPubkey: ownerBackend.activePublicKeyHex, id, method, params })); });
      await waitFor(() => expect(ws.published.length).toBe(count + 1));
      return decryptServerResponse(clientSk, ws.published[count]);
    }
    for (const kind of [0, 1, 13, 24133]) {
      expect((await send(`kind-${kind}`, 'sign_event', [JSON.stringify({ kind, created_at: 1, tags: [], content: '' })])).error).toBe('permission not granted');
    }
    for (const method of ['nip44_encrypt', 'nip44_decrypt', 'nip04_encrypt', 'nip04_decrypt']) {
      expect((await send(method, method, [clientPubkey, 'plaintext'])).error).toBe('permission not granted');
    }
    expect((await send('widen', 'connect', [ownerBackend.activePublicKeyHex, 'scoped-secret', 'sign_event'])).error).toMatch(/approve requested permissions/);
    expect((await getConnectedClient(clientPubkey))?.permissions).toEqual(['sign_event:30420', 'sign_event:5']);
    const before = ws.published.length;
    await act(async () => { ws.deliver(buildClientRequest({ clientSk, targetPubkey: ownerBackend.activePublicKeyHex, id: 'delete', method: 'sign_event', params: [JSON.stringify({ kind: 5, created_at: 1, tags: [['e', 'a'.repeat(64)]], content: '' })] })); });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    expect(ws.published).toHaveLength(before);
    expect(result.current.pendingApprovals[0].alwaysAvailable).toBe(false);
    await act(async () => { await result.current.approveOnce(result.current.pendingApprovals[0].handle); });
    expect((await getConnectedClient(clientPubkey))?.permissions).toEqual(['sign_event:30420', 'sign_event:5']);
    unmount();
  });
});

it('uses a narrowed scope on the fresh owner check before silent signing or crypto', async () => {
  const { ownerBackend, relayUrl, result, unmount } = renderOwnerServer('wss://scope-update.example');
  const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
  const clientSk = generateSecretKey(), clientPubkey = getPublicKey(clientSk);
  const record = buildConnectedClientFromNostrConnect({ clientPubkey, relayUrl, relayUrls: [relayUrl], secret: 'scope-update', appName: 'Game' });
  for (const method of ['sign_event', 'nip44_encrypt']) {
    const read = vi.spyOn(db, 'getConnectedClient');
    read.mockResolvedValueOnce({ ...record, permissions: [method === 'sign_event' ? 'sign_event:1' : 'nip44_encrypt'] });
    read.mockResolvedValueOnce({ ...record, permissions: ['sign_event:5'] });
    const before = ws.published.length;
    await act(async () => { ws.deliver(buildClientRequest({ clientSk, targetPubkey: ownerBackend.activePublicKeyHex, id: method, method,
      params: method === 'sign_event' ? [JSON.stringify({ kind: 1, created_at: 1, tags: [], content: 'no' })] : [clientPubkey, 'no'],
    })); });
    await waitFor(() => expect(ws.published).toHaveLength(before + 1));
    expect(decryptServerResponse(clientSk, ws.published[before]).error).toBe('permission not granted');
    expect(result.current.pendingApprovals).toHaveLength(0);
    read.mockRestore();
  }
  unmount();
});

it('remembering a scoped approval preserves its ceiling and retires an earlier pairing rollback marker', async () => {
  const { ownerBackend, relayUrl, result, unmount } = renderOwnerServer('wss://scope-remember.example');
  const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
  const clientSk = generateSecretKey(), clientPubkey = getPublicKey(clientSk);
  await saveConnectedClient({ ...buildConnectedClientFromNostrConnect({ clientPubkey, relayUrl, relayUrls: [relayUrl], secret: 'scope-remember', appName: 'Game', permissions: ['sign_event:1'] }), allowAlways: false, pairingNonce: 'old-pairing' });
  await act(async () => { ws.deliver(buildClientRequest({ clientSk, targetPubkey: ownerBackend.activePublicKeyHex, id: 'remember', method: 'sign_event', params: [JSON.stringify({ kind: 1, created_at: 1, tags: [], content: 'approved post' })] })); });
  await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
  await act(async () => { await result.current.approveAlways(result.current.pendingApprovals[0].handle); });
  expect(await getConnectedClient(clientPubkey)).toMatchObject({ allowAlways: true, permissions: ['sign_event:1'] });
  expect((await getConnectedClient(clientPubkey))?.pairingNonce).toBeUndefined();
  unmount();
});

describe('switchRelaysAnswer', () => {
  it('names the persistent relay first and keeps the relay serving the live session', () => {
    expect(switchRelaysAnswer('wss://nos.lol', 'wss://pairing.example')).toEqual(['wss://nos.lol', 'wss://pairing.example']);
    expect(switchRelaysAnswer(' wss://nos.lol ', null)).toEqual(['wss://nos.lol']);
    expect(switchRelaysAnswer('wss://nos.lol', 'ws://pairing.example')).toEqual(['wss://nos.lol']);
  });

  it('answers null when the request arrived on the persistent relay', () => {
    expect(switchRelaysAnswer('wss://nos.lol', 'wss://nos.lol')).toBeNull();
    expect(switchRelaysAnswer('wss://nos.lol', 'WSS://NOS.LOL/')).toBeNull();
  });

  it('never names an absent or invalid relay', () => {
    expect(switchRelaysAnswer(undefined, 'wss://pairing.example')).toBeNull();
    expect(switchRelaysAnswer('', 'wss://pairing.example')).toBeNull();
    expect(switchRelaysAnswer('ws://relay.example', 'wss://pairing.example')).toBeNull();
    expect(switchRelaysAnswer('https://relay.example', 'wss://pairing.example')).toBeNull();
  });
});

describe('askToSign: "ask me each time it signs" (allowAlways untouched)', () => {
  afterEach(() => { MockRelaySocket.instances.length = 0; });

  async function pairAsking(relayUrl: string) {
    const server = renderOwnerServer(relayUrl);
    const ws = await waitForOpenRelay(server.ownerBackend.activePublicKeyHex, server.relayUrl);
    const clientSk = generateSecretKey(), clientPubkey = getPublicKey(clientSk);
    await saveConnectedClient(buildConnectedClientFromNostrConnect(
      { clientPubkey, relayUrl, relayUrls: [relayUrl], secret: 'ask-secret', appName: 'Asker' }, 1_770_000_000, { askToSign: true },
    ));
    return { ...server, ws, clientSk, clientPubkey };
  }
  const note = (content: string) => JSON.stringify({ kind: 1, created_at: 1, tags: [], content });

  it('prompts for sign_event instead of signing silently', async () => {
    const { ownerBackend, ws, clientSk, result, unmount } = await pairAsking('wss://ask-sign.example');
    const signing = vi.spyOn(ownerBackend, 'signEvent');
    await act(async () => ws.deliver(buildClientRequest({ clientSk, targetPubkey: ownerBackend.activePublicKeyHex, id: 'ask', method: 'sign_event', params: [note('hi')] })));
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    expect(ws.published).toHaveLength(0);
    expect(signing).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps nip44 encrypt silent for the same client', async () => {
    const { ownerBackend, ws, clientSk, result, unmount } = await pairAsking('wss://ask-crypto.example');
    const peerPubkey = getPublicKey(generateSecretKey());
    await act(async () => ws.deliver(buildClientRequest({ clientSk, targetPubkey: ownerBackend.activePublicKeyHex, id: 'enc', method: 'nip44_encrypt', params: [peerPubkey, 'still silent'] })));
    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(decryptServerResponse(clientSk, ws.published[0])).toMatchObject({ id: 'enc', result: expect.any(String) });
    expect(result.current.pendingApprovals).toHaveLength(0);
    unmount();
  });

  it('allowAlways is still true on the stored record, and approving "always" clears askToSign', async () => {
    const { ownerBackend, ws, clientSk, clientPubkey, result, unmount } = await pairAsking('wss://ask-clear.example');
    expect(await getConnectedClient(clientPubkey)).toMatchObject({ allowAlways: true, askToSign: true });
    await act(async () => ws.deliver(buildClientRequest({ clientSk, targetPubkey: ownerBackend.activePublicKeyHex, id: 'ask', method: 'sign_event', params: [note('hi')] })));
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    await act(async () => { await result.current.approveAlways(result.current.pendingApprovals[0].handle); });
    const stored = await getConnectedClient(clientPubkey);
    expect(stored?.allowAlways).toBe(true);
    expect(stored).not.toHaveProperty('askToSign');
    // ...and the next sign_event is silent again.
    const before = ws.published.length;
    await act(async () => ws.deliver(buildClientRequest({ clientSk, targetPubkey: ownerBackend.activePublicKeyHex, id: 'quiet', method: 'sign_event', params: [note('again')] })));
    await waitFor(() => expect(ws.published.length).toBe(before + 1));
    expect(result.current.pendingApprovals).toHaveLength(0);
    unmount();
  });

  it('approving once leaves askToSign in place', async () => {
    const { ownerBackend, ws, clientSk, clientPubkey, result, unmount } = await pairAsking('wss://ask-once.example');
    await act(async () => ws.deliver(buildClientRequest({ clientSk, targetPubkey: ownerBackend.activePublicKeyHex, id: 'ask', method: 'sign_event', params: [note('hi')] })));
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));
    await act(async () => { await result.current.approveOnce(result.current.pendingApprovals[0].handle); });
    expect(await getConnectedClient(clientPubkey)).toMatchObject({ allowAlways: true, askToSign: true });
    unmount();
  });
});

describe('db.updateConnectedClient', () => {
  it('toggles askToSign without touching allowAlways or anything else', async () => {
    const clientPubkey = getPublicKey(generateSecretKey());
    await saveConnectedClient({ clientPubkey, appName: 'A', connectedAt: 1, lastSeenAt: 2, allowAlways: true, permissions: ['sign_event:1'] });
    await db.updateConnectedClient(clientPubkey, { askToSign: true });
    expect(await getConnectedClient(clientPubkey)).toEqual({ clientPubkey, appName: 'A', connectedAt: 1, lastSeenAt: 2, allowAlways: true, permissions: ['sign_event:1'], askToSign: true });
    await db.updateConnectedClient(clientPubkey, { askToSign: false });
    expect(await getConnectedClient(clientPubkey)).not.toHaveProperty('askToSign');
    await db.updateConnectedClient('f'.repeat(64), { askToSign: true });
    expect(await getConnectedClient('f'.repeat(64))).toBeUndefined();
  });
});
