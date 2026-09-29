import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';

const published: { relay: string; event: NostrEvent }[] = [];
vi.mock('signet-protocol', async (orig) => {
  const actual = await orig<typeof import('signet-protocol')>();
  class FakeRelay {
    constructor(readonly url: string) {}
    async connect() {}
    async publish(event: NostrEvent) { published.push({ relay: this.url, event }); return { ok: true, message: '' }; }
    disconnect() {}
  }
  return { ...actual, RelayClient: FakeRelay };
});

import { LocalSigningBackend, type DecryptingSigningBackend } from './signing-backend';
import { buildChildDirectRoutes, type ChildRouteGate } from './child-bunker';
import { childConnectRoute, deliverChildNostrConnect } from './child-nostrconnect';
import { sendConnectResponse, type NostrConnectRequest } from './nip46';
import { ConnectWithdrawnError } from './connect-delivery';

const PERSONA = 'ab'.repeat(32), EXTRA = '34'.repeat(32);
const tk = (sk = generateSecretKey()) => ({ publicKey: getPublicKey(sk), privateKey: bytesToHex(sk) });

/** A router whose every touch is recorded. */
function recordingRouter() {
  const calls: string[] = [];
  const routeFor = (pk: string): DecryptingSigningBackend => ({
    type: 'bunker', activePublicKeyHex: pk,
    signEvent: vi.fn(async () => { calls.push(`sign:${pk}`); throw new Error('router used'); }),
    nip44Encrypt: vi.fn(async () => { calls.push(`enc:${pk}`); throw new Error('router used'); }),
    nip44Decrypt: vi.fn(async () => { calls.push(`dec:${pk}`); throw new Error('router used'); }),
    destroy: () => {},
  } as unknown as DecryptingSigningBackend);
  const router = { backendFor: vi.fn((pk: string) => { calls.push(`backendFor:${pk}`); return routeFor(pk); }) };
  return { router, calls };
}

beforeEach(() => { published.length = 0; });

describe('A40: nostrconnect:// on a direct child', () => {
  it('never calls the router; the connect ack is signed by the persona\'s LOCAL transport key', async () => {
    const keys = { [PERSONA]: tk(), [EXTRA]: tk() };
    const { router, calls } = recordingRouter();
    const gate: ChildRouteGate = { authorise: vi.fn() };
    const routes = buildChildDirectRoutes({
      personas: [PERSONA, EXTRA], transportKeys: keys,
      signingBackendFor: (p) => router.backendFor(p), gateFor: () => gate,
    }, (priv) => new LocalSigningBackend(priv));
    calls.length = 0; router.backendFor.mockClear(); // building the routes is not the connect

    const clientSk = generateSecretKey();
    const request: NostrConnectRequest = {
      clientPubkey: getPublicKey(clientSk), relayUrl: 'wss://relay.example', relayUrls: ['wss://relay.example'],
      secret: 'shh', appName: 'Chess', appUrl: 'https://chess.example',
    };
    const route = childConnectRoute(routes, EXTRA.toUpperCase());
    expect(route?.pubkey).toBe(keys[EXTRA].publicKey);
    const armed: string[] = [];
    const connected = vi.fn();
    const result = await deliverChildNostrConnect({
      route: route!,
      relayCandidates: request.relayUrls,
      stillOpen: () => true, claim: () => true, unclaim: () => {}, finishDelivery: () => false,
      arm: async (routePubkey, relayUrl) => { armed.push(`${routePubkey}@${relayUrl}`); },
      send: (backend, relayUrl, beforePublish) => sendConnectResponse(request, backend, relayUrl, async () => {
        if (!beforePublish()) throw new ConnectWithdrawnError();
      }),
      onConnected: connected,
    });

    expect(result).toEqual({ status: 'connected', relayUrl: 'wss://relay.example' });
    expect(calls).toEqual([]);
    expect(router.backendFor).not.toHaveBeenCalled();
    expect(published).toHaveLength(1);
    const ack = published[0].event;
    expect(ack.kind).toBe(24133);
    expect(ack.pubkey).toBe(keys[EXTRA].publicKey);
    expect(ack.pubkey).not.toBe(EXTRA);
    expect(verifyEvent(ack as never)).toBe(true);
    expect(armed).toEqual([`${keys[EXTRA].publicKey}@wss://relay.example`]);
    expect(connected).toHaveBeenCalledTimes(1);
  });

  it('a persona with no gated route (dormant, unknown, no Heartwood yet) has nothing to connect through', () => {
    const keys = { [PERSONA]: tk() };
    const routes = buildChildDirectRoutes({
      personas: [PERSONA], transportKeys: keys,
      signingBackendFor: (p) => ({ activePublicKeyHex: p } as never), gateFor: () => ({ authorise: vi.fn() }),
    }, (priv) => new LocalSigningBackend(priv));
    expect(childConnectRoute(routes, EXTRA)).toBeNull();
    expect(childConnectRoute(routes, null)).toBeNull();
    expect(childConnectRoute(routes, PERSONA)?.childGate).toBeTruthy();
  });

  it('a withdrawn request publishes nothing and is not noted as connected', async () => {
    const routes = buildChildDirectRoutes({
      personas: [PERSONA], transportKeys: { [PERSONA]: tk() },
      signingBackendFor: (p) => ({ activePublicKeyHex: p } as never), gateFor: () => ({ authorise: vi.fn() }),
    }, (priv) => new LocalSigningBackend(priv));
    const request: NostrConnectRequest = {
      clientPubkey: getPublicKey(generateSecretKey()), relayUrl: 'wss://relay.example', relayUrls: ['wss://relay.example'],
      secret: 's', appName: 'X',
    };
    const connected = vi.fn();
    const result = await deliverChildNostrConnect({
      route: childConnectRoute(routes, PERSONA)!,
      relayCandidates: request.relayUrls,
      stillOpen: () => true, claim: () => false, unclaim: () => {}, finishDelivery: () => false,
      arm: async () => {},
      send: (backend, relayUrl, beforePublish) => sendConnectResponse(request, backend, relayUrl, async () => {
        if (!beforePublish()) throw new ConnectWithdrawnError();
      }),
      onConnected: connected,
    });
    expect(result.status).toBe('withdrawn');
    expect(published).toHaveLength(0);
    expect(connected).not.toHaveBeenCalled();
  });
});
