// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { bytesToHex } from '@noble/hashes/utils.js';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';
import { encrypt as nip04Encrypt, decrypt as nip04Decrypt } from 'nostr-tools/nip04';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { NostrConnect } from 'nostr-tools/kinds';
import type { NostrEvent } from 'signet-protocol';
import { useBunkerServer } from './useBunkerServer';
import { LocalSigningBackend } from '../lib/signing-backend';
import { buildConnectedClientFromNostrConnect } from '../lib/nip46';
import { deleteConnectedClient, getConnectedClient, saveConnectedClient } from '../lib/db';
import * as db from '../lib/db';
import type { TrustedAppPairing } from '../types';

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

  it('rejects owner NIP-44 when the NostrConnect approval was not persisted', async () => {
    const { ownerBackend, relayUrl, unmount } = renderOwnerServer('wss://canary-denied.example');
    const ws = await waitForOpenRelay(ownerBackend.activePublicKeyHex, relayUrl);
    const clientSk = generateSecretKey();
    const peerPubkey = getPublicKey(generateSecretKey());

    await act(async () => {
      ws.deliver(buildClientRequest({
        clientSk,
        targetPubkey: ownerBackend.activePublicKeyHex,
        id: 'nip44-denied',
        method: 'nip44_encrypt',
        params: [peerPubkey, 'blocked plaintext'],
      }));
    });

    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(decryptServerResponse(clientSk, ws.published[0])).toEqual({
      id: 'nip44-denied',
      error: 'not connected',
    });
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
