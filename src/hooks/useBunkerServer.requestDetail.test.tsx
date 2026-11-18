// @vitest-environment jsdom
/**
 * What a queued Bunker request carries so the owner can decide: when it was
 * asked, what the app called itself, the size and a preview of its payload,
 * and Clear (take it off the list without refusing it).
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
import type { ConnectedClient } from '../types';

class MockRelaySocket {
  static OPEN = 1;
  static instances: MockRelaySocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  subId: string | null = null;
  published: NostrEvent[] = [];
  constructor(readonly url: string) {
    MockRelaySocket.instances.push(this);
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
  }
  send(data: string) {
    const parsed = JSON.parse(data);
    if (parsed[0] === 'REQ') this.subId = parsed[1];
    else if (parsed[0] === 'EVENT') {
      this.published.push(parsed[1]);
      this.onmessage?.({ data: JSON.stringify(['OK', parsed[1].id, true, '']) });
    }
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  deliver(event: NostrEvent) { this.onmessage?.({ data: JSON.stringify(['EVENT', this.subId, event]) }); }
}

beforeAll(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('WebSocket', MockRelaySocket);
});
afterEach(() => { cleanup(); MockRelaySocket.instances = []; vi.restoreAllMocks(); });
afterAll(() => { vi.unstubAllGlobals(); });

function request(input: { clientSk: Uint8Array; target: string; id: string; method: string; params: string[]; createdAt?: number }): NostrEvent {
  const content = encrypt(JSON.stringify({ id: input.id, method: input.method, params: input.params }), getConversationKey(input.clientSk, input.target));
  return finalizeEvent({
    kind: NostrConnect, created_at: input.createdAt ?? Math.floor(Date.now() / 1000), tags: [['p', input.target]], content,
  }, input.clientSk) as unknown as NostrEvent;
}
function reply(clientSk: Uint8Array, event: NostrEvent): { id: string; result?: string; error?: string } {
  return JSON.parse(decrypt(event.content, getConversationKey(clientSk, event.pubkey)));
}

let relayCounter = 0;
async function ownerServer(overrides: Partial<Parameters<typeof useBunkerServer>[0]> = {}) {
  const ownerBackend = new LocalSigningBackend(bytesToHex(generateSecretKey()));
  const relayUrl = `wss://detail-${++relayCounter}.example`;
  const owner = ownerBackend.activePublicKeyHex;
  const hook = renderHook((props: Partial<Parameters<typeof useBunkerServer>[0]>) => useBunkerServer({
    enabled: true, relayUrl, routes: [{ pubkey: owner, backend: ownerBackend }], isOwnerServingActive: () => true, ...props,
  }), { initialProps: overrides });
  await waitFor(() => { expect(MockRelaySocket.instances.at(-1)?.subId).toBeTruthy(); });
  const ws = MockRelaySocket.instances.at(-1)!;
  const client = () => { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; };
  const send = (c: { sk: Uint8Array }, id: string, method: string, params: string[], createdAt?: number) =>
    act(async () => { ws.deliver(request({ clientSk: c.sk, target: owner, id, method, params, createdAt })); });
  const connect = async (c: { sk: Uint8Array }, meta: object | null, id = 'c1') => {
    const before = ws.published.length;
    await send(c, id, 'connect', meta ? [owner, '', '', JSON.stringify(meta)] : [owner]);
    await waitFor(() => expect(ws.published.length).toBe(before + 1));
    return reply(c.sk, ws.published[before]);
  };
  return { hook, ws, owner, ownerBackend, client, send, connect };
}
const note = (content = 'hi') => JSON.stringify({ kind: 1, created_at: 1, tags: [], content });
const peer = () => getPublicKey(generateSecretKey());
const row = (pk: string, over: Partial<ConnectedClient> = {}): ConnectedClient =>
  ({ clientPubkey: pk, appName: 'Paired App', connectedAt: 1_770_000_000, lastSeenAt: 1_770_000_100, allowAlways: true, ...over });

describe('askedAt', () => {
  it('comes from the envelope, on a sign request and on a crypto request', async () => {
    const h = await ownerServer();
    const c = h.client();
    const t = Math.floor(Date.now() / 1000) - 120;
    await h.send(c, 's1', 'sign_event', [note()], t);
    await h.send(c, 'e1', 'nip44_encrypt', [peer(), 'plain'], t - 30);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(2));
    const queue = h.hook.result.current.pendingApprovals;
    expect(queue.find(a => a.method === 'sign_event')!.askedAt).toBe(t * 1000);
    expect(queue.find(a => a.method === 'nip44_encrypt')!.askedAt).toBe((t - 30) * 1000);
  });
  it('is clamped to now when the envelope is dated slightly ahead', async () => {
    const h = await ownerServer();
    const c = h.client();
    const before = Date.now();
    await h.send(c, 's1', 'sign_event', [note()], Math.floor(Date.now() / 1000) + 40);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(1));
    const { askedAt } = h.hook.result.current.pendingApprovals[0];
    expect(askedAt).toBeGreaterThanOrEqual(before);
    expect(askedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('what an app says about itself in connect', () => {
  const meta = { name: 'KithMoot', url: 'https://kithmoot.example/app' };

  it('reaches the queued entry of an unpaired client, sign and crypto, and the connect is still ACKed', async () => {
    const h = await ownerServer();
    const c = h.client();
    expect((await h.connect(c, meta)).result).toBe('ack');
    await h.send(c, 's1', 'sign_event', [note()]);
    await h.send(c, 'd1', 'nip44_decrypt', [peer(), 'cipher']);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(2));
    for (const entry of h.hook.result.current.pendingApprovals) {
      expect(entry.client).toMatchObject({ appName: 'Unknown app', existing: false, declaredName: 'KithMoot', declaredUrl: 'https://kithmoot.example' });
      expect(entry.client.connectedAt).toBeUndefined();
    }
    expect(await db.getConnectedClient(c.pk)).toBeUndefined();
  });

  it('is not used for a client that has a saved row, which keeps its own name and facts', async () => {
    const h = await ownerServer();
    const c = h.client();
    await db.saveConnectedClient(row(c.pk, { appName: 'Saved Name', allowAlways: true, askToSign: true, appUrl: 'https://saved.example' }));
    await h.connect(c, { name: 'Different', url: 'https://different.example' });
    await h.send(c, 's1', 'sign_event', [note()]);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(1));
    const { client } = h.hook.result.current.pendingApprovals[0];
    expect(client).toMatchObject({ appName: 'Saved Name', existing: true, connectedAt: 1_770_000_000, lastSeenAt: 1_770_000_100, appUrl: 'https://saved.example' });
    expect(client.declaredName).toBeUndefined();
    expect(client.declaredUrl).toBeUndefined();
  });

  it('leaves a matched pairing connect unchanged: it saves through the callback and answers ack', async () => {
    const pendingAuthPairingsRef = { current: new Map([['one-shot-secret', { origin: 'https://site.example', appName: 'Site', signingPubkey: '', expiresAt: Date.now() + 60_000 }]]) };
    const onAuthFlowPairingComplete = vi.fn(async (p: { clientPubkey: string; appName: string; origin: string }) => {
      await db.saveConnectedClient(row(p.clientPubkey, { appName: p.appName, appUrl: p.origin }));
    });
    const h = await ownerServer({ pendingAuthPairingsRef, onAuthFlowPairingComplete });
    // The register entry is keyed to the route's own pubkey (known only now).
    pendingAuthPairingsRef.current.get('one-shot-secret')!.signingPubkey = h.owner;
    const c = h.client();
    const before = h.ws.published.length;
    await h.send(c, 'm1', 'connect', [h.owner, 'one-shot-secret', '', JSON.stringify({ name: 'Paired Site', url: 'https://paired.example' })]);
    await waitFor(() => expect(h.ws.published.length).toBe(before + 1));
    expect(reply(c.sk, h.ws.published[before]).result).toBe('ack');
    expect(onAuthFlowPairingComplete).toHaveBeenCalledWith(expect.objectContaining({ clientPubkey: c.pk, appName: 'Paired Site', origin: 'https://paired.example' }));
    expect(await db.getConnectedClient(c.pk)).toMatchObject({ appName: 'Paired Site', allowAlways: true });
    expect(pendingAuthPairingsRef.current.size).toBe(0);
  });

  it('is dropped on lock, and keeps only the newest 50', async () => {
    const h = await ownerServer({ appPairingsEncryptionKey: 'unlock-key' });
    const first = h.client();
    await h.connect(first, { name: 'First' }, 'first');
    for (let i = 0; i < 50; i++) await h.connect(h.client(), { name: `App ${i}` }, `n${i}`);
    await h.send(first, 's1', 'sign_event', [note()]);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(1));
    expect(h.hook.result.current.pendingApprovals[0].client.declaredName).toBeUndefined(); // evicted: 51st in
    const second = h.client();
    await h.connect(second, { name: 'Second' }, 'second');
    h.hook.rerender({ appPairingsEncryptionKey: null }); // lock
    h.hook.rerender({ appPairingsEncryptionKey: 'unlock-key' });
    await h.send(second, 's2', 'sign_event', [note()]);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(2));
    expect(h.hook.result.current.pendingApprovals[1].client.declaredName).toBeUndefined();
  }, 30_000);

  it('is recorded even when the connect itself is refused for asking for permissions', async () => {
    const h = await ownerServer();
    const c = h.client();
    const before = h.ws.published.length;
    await h.send(c, 'refused', 'connect', [h.owner, '', 'sign_event', JSON.stringify({ name: 'Eager App' })]);
    await waitFor(() => expect(h.ws.published.length).toBe(before + 1));
    expect(reply(c.sk, h.ws.published[before]).error).toBe('approve requested permissions with nostrconnect');
    await h.send(c, 's1', 'sign_event', [note()]);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(1));
    expect(h.hook.result.current.pendingApprovals[0].client.declaredName).toBe('Eager App');
  });

  it('keeps a known name when a later connect says nothing about itself', async () => {
    const h = await ownerServer();
    const c = h.client();
    await h.connect(c, { name: 'KithMoot' }, 'first');
    await h.connect(c, null, 'second');
    await h.send(c, 's1', 'sign_event', [note()]);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(1));
    expect(h.hook.result.current.pendingApprovals[0].client.declaredName).toBe('KithMoot');
  });

  it('never saves a name the card did not show: a row present at queue time wins even if it is deleted before Always', async () => {
    const h = await ownerServer();
    const c = h.client();
    await db.saveConnectedClient(row(c.pk, { appName: 'Saved Name', askToSign: true }));
    await h.connect(c, { name: 'Claimed Name' });
    await h.send(c, 's1', 'sign_event', [note()]);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(1));
    await db.deleteConnectedClient(c.pk);
    await act(async () => { await h.hook.result.current.approveAlways(h.hook.result.current.pendingApprovals[0].handle); });
    await waitFor(async () => expect(await db.getConnectedClient(c.pk)).toMatchObject({ appName: 'Unnamed app' }));
  });

  it('never changes who prompts or who signs on its own', async () => {
    const h = await ownerServer();
    // A paired allow-always client that now claims a different name still signs silently...
    const paired = h.client();
    await db.saveConnectedClient(row(paired.pk, { appName: 'Paired App' }));
    await h.connect(paired, { name: 'Somebody Else' }, 'p-connect');
    const before = h.ws.published.length;
    await h.send(paired, 'p1', 'sign_event', [note('silent')]);
    await waitFor(() => expect(h.ws.published.length).toBe(before + 1));
    expect(JSON.parse(reply(paired.sk, h.ws.published[before]).result!)).toMatchObject({ kind: 1, content: 'silent' });
    expect(h.hook.result.current.pendingApprovals).toHaveLength(0);
    // ...and an unpaired client naming itself after that app is still asked, never signed or decrypted for.
    const stranger = h.client();
    await h.connect(stranger, { name: 'Paired App', url: 'https://paired.example' }, 'x-connect');
    const published = h.ws.published.length;
    await h.send(stranger, 'x1', 'sign_event', [note('asks')]);
    await h.send(stranger, 'x2', 'nip44_decrypt', [peer(), 'cipher']);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(2));
    expect(h.ws.published.length).toBe(published);
  });
});

describe('"Always" with no saved row', () => {
  it.each(['sign_event', 'nip44_encrypt'])('saves the declared name on %s', async method => {
    const h = await ownerServer();
    const c = h.client();
    await h.connect(c, { name: 'KithMoot' });
    await h.send(c, 'a1', method, method === 'sign_event' ? [note()] : [peer(), 'data']);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(1));
    await act(async () => { await h.hook.result.current.approveAlways(h.hook.result.current.pendingApprovals[0].handle); });
    await waitFor(async () => expect(await db.getConnectedClient(c.pk)).toMatchObject({ appName: 'KithMoot', allowAlways: true }));
  });
  it.each(['sign_event', 'nip44_encrypt'])('saves "Unnamed app", not "Unknown app", on %s when nothing was declared', async method => {
    const h = await ownerServer();
    const c = h.client();
    await h.send(c, 'a1', method, method === 'sign_event' ? [note()] : [peer(), 'data']);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(1));
    await act(async () => { await h.hook.result.current.approveAlways(h.hook.result.current.pendingApprovals[0].handle); });
    await waitFor(async () => expect(await db.getConnectedClient(c.pk)).toMatchObject({ appName: 'Unnamed app', allowAlways: true }));
  });
});

describe('crypto payload facts', () => {
  it('gives an encrypt request its length and at most 280 characters of preview', async () => {
    const h = await ownerServer();
    const c = h.client();
    const plaintext = 'line one\nline two ' + 'y'.repeat(5000);
    await h.send(c, 'e1', 'nip44_encrypt', [peer(), plaintext]);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(1));
    const entry = h.hook.result.current.pendingApprovals[0];
    if (entry.method === 'sign_event') throw new Error('expected a crypto request');
    expect(entry.payloadLength).toBe(plaintext.length);
    expect(entry.payloadPreview!.length).toBeLessThanOrEqual(280);
    expect(entry.payloadPreview!.startsWith('line one line two yyy')).toBe(true);
  });
  it('gives a decrypt request its length and no preview', async () => {
    const h = await ownerServer();
    const c = h.client();
    await h.send(c, 'd1', 'nip44_decrypt', [peer(), 'c'.repeat(900)]);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(1));
    const entry = h.hook.result.current.pendingApprovals[0];
    if (entry.method === 'sign_event') throw new Error('expected a crypto request');
    expect(entry.payloadLength).toBe(900);
    expect(entry.payloadPreview).toBeUndefined();
  });
});

describe('clearApproval', () => {
  it.each(['sign_event', 'nip44_encrypt', 'nip44_decrypt'])('answers "request expired" and writes nothing for an owner %s request', async method => {
    const h = await ownerServer();
    const c = h.client();
    await h.send(c, 'k1', method, method === 'sign_event' ? [note()] : [peer(), 'data']);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(1));
    const handle = h.hook.result.current.pendingApprovals[0].handle;
    const saveClient = vi.spyOn(db, 'saveConnectedClient');
    const saveGrant = vi.spyOn(db, 'saveGrant');
    const onAuditEvent = vi.fn();
    h.hook.rerender({ onAuditEvent });
    const signing = vi.spyOn(h.ownerBackend, 'signEvent');
    await act(async () => { await h.hook.result.current.clearApproval(handle); });
    await waitFor(() => expect(h.ws.published).toHaveLength(1));
    expect(reply(c.sk, h.ws.published[0])).toMatchObject({ id: 'k1', error: 'request expired' });
    expect(h.hook.result.current.pendingApprovals).toHaveLength(0);
    expect(saveClient).not.toHaveBeenCalled();
    expect(saveGrant).not.toHaveBeenCalled();
    expect(onAuditEvent).not.toHaveBeenCalled();
    expect(await db.getConnectedClient(c.pk)).toBeUndefined();
    // The only signature is the transport envelope of the answer itself.
    expect(signing.mock.calls.every(([t]) => (t as { kind: number }).kind === 24133)).toBe(true);
    // Clearing again is a no-op.
    await act(async () => { await h.hook.result.current.clearApproval(handle); });
    expect(h.ws.published).toHaveLength(1);
  });

  it('does not bump lastSeenAt or rewrite the saved row of a client that has one', async () => {
    const h = await ownerServer();
    const c = h.client();
    const saved = row(c.pk, { askToSign: true });
    await db.saveConnectedClient(saved);
    await h.send(c, 'k1', 'sign_event', [note()]);
    await waitFor(() => expect(h.hook.result.current.pendingApprovals).toHaveLength(1));
    const queued = await db.getConnectedClient(c.pk); // the request itself binds the row to its route
    expect(queued).toMatchObject({ lastSeenAt: saved.lastSeenAt });
    const saveClient = vi.spyOn(db, 'saveConnectedClient');
    await act(async () => { await h.hook.result.current.clearApproval(h.hook.result.current.pendingApprovals[0].handle); });
    await waitFor(() => expect(h.ws.published).toHaveLength(1));
    expect(reply(c.sk, h.ws.published[0]).error).toBe('request expired');
    expect(saveClient).not.toHaveBeenCalled();
    expect(await db.getConnectedClient(c.pk)).toEqual(queued);
  });

  it('writes no deny grant and no audit event on a dependant route (where Deny would)', async () => {
    const transportSk = generateSecretKey(), personaSk = generateSecretKey(), clientSk = generateSecretKey();
    const persona = getPublicKey(personaSk);
    const transport = new LocalSigningBackend(bytesToHex(transportSk));
    const route: BunkerRoute = {
      pubkey: transport.activePublicKeyHex, backend: transport, signingBackend: new LocalSigningBackend(bytesToHex(personaSk)),
      dependantId: persona, autonomyStage: 'request-approve', authorizedClientPubkey: getPublicKey(clientSk),
    };
    const onAuditEvent = vi.fn();
    const onGrantMutated = vi.fn();
    const relayUrl = `wss://detail-dep-${++relayCounter}.example`;
    const hook = renderHook(() => useBunkerServer({
      enabled: true, relayUrl, routes: [route], isOwnerServingActive: () => true, onAuditEvent, onGrantMutated,
    }));
    await waitFor(() => expect(MockRelaySocket.instances.at(-1)?.subId).toBeTruthy());
    const ws = MockRelaySocket.instances.at(-1)!;
    const origin = 'https://game.example';
    const signIn = JSON.stringify({ kind: 21236, created_at: 1_800_000_000, tags: [['origin', origin]], content: '' });
    await act(async () => { ws.deliver(request({ clientSk, target: transport.activePublicKeyHex, id: 'dep1', method: 'sign_event', params: [signIn] })); });
    await waitFor(() => expect(hook.result.current.pendingApprovals).toHaveLength(1));
    await act(async () => { await hook.result.current.clearApproval(hook.result.current.pendingApprovals[0].handle); });
    await waitFor(() => expect(ws.published).toHaveLength(1));
    expect(reply(clientSk, ws.published[0])).toMatchObject({ id: 'dep1', error: 'request expired' });
    expect(await db.lookupGrant(persona, 'sign-in', origin)).toBeUndefined();
    expect(onAuditEvent).not.toHaveBeenCalled();
    expect(onGrantMutated).not.toHaveBeenCalled();
  });
});
