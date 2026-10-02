// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { NostrEvent } from 'signet-protocol';
const state = vi.hoisted(() => ({ relays: [] as Array<{ filters?: Array<{ authors?: string[] }>; receive?: (event: NostrEvent) => void; disconnect: ReturnType<typeof vi.fn> }> }));
vi.mock('signet-protocol', async original => ({ ...await original<typeof import('signet-protocol')>(), RelayClient: class {
  filters?: Array<{ authors?: string[] }>;
  receive?: (event: NostrEvent) => void;
  disconnect = vi.fn();
  constructor() { state.relays.push(this); }
  async connect() {}
  subscribe(filters: Array<{ authors?: string[] }>, receive: (event: NostrEvent) => void) { this.filters = filters; this.receive = receive; return 'sub'; }
} }));
import { purgeAllUserData, savePairedChild } from '../lib/db';
import { LocalSigningBackend } from '../lib/signing-backend';
import { sealChildContactReply, type ChildContactReply } from '../lib/child-contact-exchange';
import { useChildContactReplyInbox } from './useChildContactReplyInbox';

const guardian = '1'.repeat(64), childId = '2'.repeat(64), persona = '3'.repeat(64), key = 'reply-inbox-repair-test';
const endpointA = new LocalSigningBackend('04'.repeat(32)), clientA = new LocalSigningBackend('05'.repeat(32));
const endpointB = new LocalSigningBackend('06'.repeat(32)), clientB = new LocalSigningBackend('07'.repeat(32));
const pairWith = (endpoint: LocalSigningBackend, client: LocalSigningBackend, priv: string) => savePairedChild({
  bunkerUri: `bunker://${endpoint.activePublicKeyHex}?relay=wss%3A%2F%2Frelay.example`,
  clientKeypair: { publicKey: client.activePublicKeyHex, privateKey: priv },
  dependantPubkey: childId, dependantName: 'Robin', pairedAt: 1, hasPaired: true, guardianPubkey: guardian }, key);

beforeEach(async () => { state.relays.length = 0; await purgeAllUserData(); });

it('follows an in-session re-pair: listens on the new endpoint and opens replies for the new client key', async () => {
  await pairWith(endpointA, clientA, '05'.repeat(32));
  const { result, rerender, unmount } = renderHook(({ gen }) => useChildContactReplyInbox({
    enabled: true, child: childId, key, relayUrl: 'wss://relay.example', guardian, personas: [persona], pairingGeneration: gen }), { initialProps: { gen: 0 } });
  await waitFor(() => expect(state.relays[0]?.receive).toBeDefined());
  expect(state.relays[0].filters?.[0].authors).toEqual([endpointA.activePublicKeyHex]);

  await pairWith(endpointB, clientB, '07'.repeat(32));
  rerender({ gen: 1 });
  await waitFor(() => expect(state.relays[1]?.receive).toBeDefined());
  expect(state.relays[0].disconnect).toHaveBeenCalled();
  expect(state.relays[1].filters?.[0].authors).toEqual([endpointB.activePublicKeyHex]);

  const now = Math.floor(Date.now() / 1000);
  const reply: ChildContactReply = { v: 1, requestId: 'a'.repeat(32), guardian, endpoint: endpointB.activePublicKeyHex, client: clientB.activePublicKeyHex,
    persona, revision: 1, createdAt: now, expiresAt: now + 600, status: 'pending' };
  await act(async () => { state.relays[1].receive!(await sealChildContactReply(reply, endpointB)); });
  await waitFor(() => expect(result.current.map(r => r.reply.requestId)).toEqual(['a'.repeat(32)]));
  unmount();
});
