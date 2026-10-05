// @vitest-environment jsdom
/**
 * Dependant routes: "allow always" is only offered when it will be saved
 * (`PendingApproval.alwaysAvailable`), and at full-control a stored allow
 * grant is ignored (no "always" there) while a stored deny still applies.
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
import type { AutonomyStage } from '../types';

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


const ORIGIN = 'https://game.example';
const SIGN_IN = { kind: 21236, created_at: 1_800_000_000, tags: [['origin', ORIGIN]], content: '' };
const UNCLASSIFIED = { kind: 31337, created_at: 1_800_000_000, tags: [], content: '' };
let relayCounter = 0;

async function setup(opts: { stage?: AutonomyStage; dependant: boolean }) {
  const transportSk = generateSecretKey();
  const personaSk = generateSecretKey();
  const persona = getPublicKey(personaSk);
  const transport = new LocalSigningBackend(bytesToHex(transportSk));
  const signing = new LocalSigningBackend(bytesToHex(personaSk));
  const clientSk = generateSecretKey();
  const route: BunkerRoute = {
    pubkey: transport.activePublicKeyHex, backend: transport, signingBackend: signing,
    ...(opts.dependant ? { dependantId: persona, autonomyStage: opts.stage, authorizedClientPubkey: getPublicKey(clientSk) } : {}),
  };
  const relayUrl = `wss://dep-grants-${++relayCounter}.example`;
  const hook = renderHook(() => useBunkerServer({
    enabled: true, relayUrl, routes: [route], isOwnerServingActive: () => true,
  }));
  await waitFor(() => {
    expect(MockRelaySocket.instances).toHaveLength(1);
    expect(MockRelaySocket.instances[0].subId).toBeTruthy();
  });
  const ws = MockRelaySocket.instances[0];
  const send = async (id: string, template: object) => {
    await act(async () => {
      ws.deliver(buildClientRequest({ clientSk, targetPubkey: transport.activePublicKeyHex, id, method: 'sign_event', params: [JSON.stringify(template)] }));
    });
  };
  const reply = async (id: string) => {
    const before = ws.published.length;
    await send(id, SIGN_IN);
    await waitFor(() => expect(ws.published.length).toBe(before + 1));
    return decryptServerResponse(clientSk, ws.published[before]);
  };
  return { hook, ws, persona, send, reply };
}

async function grant(dependantId: string, decision: 'allow' | 'deny') {
  await db.saveGrant({ dependantId, scope: 'sign-in', origin: ORIGIN, decision, decidedAt: 1, lastUsedAt: 1 });
}

describe('useBunkerServer — stored grants vs full-control', () => {
  it('honours a stored allow grant at request-approve (signs without asking)', async () => {
    const h = await setup({ stage: 'request-approve', dependant: true });
    await grant(h.persona, 'allow');
    const res = await h.reply('a1');
    expect(JSON.parse(res.result!)).toMatchObject({ kind: 21236, pubkey: h.persona });
    expect(h.hook.result.current.pendingApprovals).toHaveLength(0);
    h.hook.unmount();
  });

  it('ignores a stored allow grant at full-control and queues the request for the guardian', async () => {
    const h = await setup({ stage: 'full-control', dependant: true });
    await grant(h.persona, 'allow');
    await h.send('a2', SIGN_IN);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(1));
    expect(h.ws.published).toHaveLength(0);
    expect(h.hook.result.current.pendingApprovals[0].alwaysAvailable).toBe(false);
    // The grant is kept, not deleted.
    expect((await db.lookupGrant(h.persona, 'sign-in', ORIGIN))?.decision).toBe('allow');
    h.hook.unmount();
  });

  it('still applies a stored deny grant at full-control', async () => {
    const h = await setup({ stage: 'full-control', dependant: true });
    await grant(h.persona, 'deny');
    const res = await h.reply('a3');
    expect(res.error).toBe('user denied');
    expect(h.hook.result.current.pendingApprovals).toHaveLength(0);
    h.hook.unmount();
  });
});

describe('useBunkerServer — PendingApproval.alwaysAvailable', () => {
  const pending = async (h: Awaited<ReturnType<typeof setup>>, template: object) => {
    await h.send('p1', template);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(1));
    const entry = h.hook.result.current.pendingApprovals[0];
    h.hook.unmount();
    return entry.alwaysAvailable;
  };

  it('owner route: true', async () => {
    expect(await pending(await setup({ dependant: false }), SIGN_IN)).toBe(true);
  });
  it('dependant, unclassified kind: false', async () => {
    expect(await pending(await setup({ stage: 'request-approve', dependant: true }), UNCLASSIFIED)).toBe(false);
  });
  it('dependant at full-control: false', async () => {
    expect(await pending(await setup({ stage: 'full-control', dependant: true }), SIGN_IN)).toBe(false);
  });
  it('dependant, origin-scoped scope at request-approve: true', async () => {
    expect(await pending(await setup({ stage: 'request-approve', dependant: true }), SIGN_IN)).toBe(true);
  });
});
