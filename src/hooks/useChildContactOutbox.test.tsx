// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { purgeAllUserData, savePairedChild } from '../lib/db';
import { LocalSigningBackend } from '../lib/signing-backend';
import { queueChildContactRequest } from '../lib/child-contact-exchange';
import type { ChildContactRequest, ChildRequestScope } from '../lib/child-contact-requests';
import { useChildContactOutbox } from './useChildContactOutbox';

const client = new LocalSigningBackend('05'.repeat(32)), endpoint = new LocalSigningBackend('04'.repeat(32));
const guardian = '1'.repeat(64), childId = '2'.repeat(64);
const scope: ChildRequestScope = { guardian, child: childId, endpoint: endpoint.activePublicKeyHex, client: client.activePublicKeyHex, personas: ['3'.repeat(64)] };
const key = 'child-outbox-hook-test', now = 1800000000;

beforeEach(async () => { await purgeAllUserData(); });

async function pair() {
  await savePairedChild({ bunkerUri: `bunker://${endpoint.activePublicKeyHex}?relay=wss%3A%2F%2Frelay.example`,
    clientKeypair: { publicKey: client.activePublicKeyHex, privateKey: '05'.repeat(32) },
    dependantPubkey: childId, dependantName: 'Robin', pairedAt: now, hasPaired: true, guardianPubkey: guardian }, key);
}

it('is empty when disabled or the pairing is unknown', async () => {
  const hook = renderHook(() => useChildContactOutbox({ enabled: false, child: childId, key, guardian, personas: scope.personas, version: 0 }));
  expect(hook.result.current).toEqual([]);
  hook.unmount();
});

it('loads the child\'s own queued requests once paired', async () => {
  await pair();
  const request: ChildContactRequest = { v: 1, id: 'a'.repeat(32), guardian, endpoint: scope.endpoint, client: scope.client,
    persona: scope.personas[0], revision: 1, createdAt: now, expiresAt: now + 600,
    invite: { v: 1, recipient: '6'.repeat(64), secret: '7'.repeat(64), relays: ['wss://invite.example/'] } };
  await queueChildContactRequest({ scope, key, request, fingerprint: 'f'.repeat(64), now, isCurrent: () => true });
  const hook = renderHook(() => useChildContactOutbox({ enabled: true, child: childId, key, guardian, personas: scope.personas, version: 0 }));
  await waitFor(() => expect(hook.result.current).toHaveLength(1));
  expect(hook.result.current[0].request.id).toBe('a'.repeat(32));
  hook.unmount();
});

it('reloads when version bumps after a new ask is queued', async () => {
  await pair();
  const requestAt = (id: string): ChildContactRequest => ({ v: 1, id, guardian, endpoint: scope.endpoint, client: scope.client,
    persona: scope.personas[0], revision: 1, createdAt: now, expiresAt: now + 600,
    invite: { v: 1, recipient: '6'.repeat(64), secret: '7'.repeat(64), relays: ['wss://invite.example/'] } });
  await queueChildContactRequest({ scope, key, request: requestAt('a'.repeat(32)), fingerprint: 'f'.repeat(64), now, isCurrent: () => true });
  const hook = renderHook(({ version }) => useChildContactOutbox({ enabled: true, child: childId, key, guardian, personas: scope.personas, version }),
    { initialProps: { version: 0 } });
  await waitFor(() => expect(hook.result.current).toHaveLength(1));
  await queueChildContactRequest({ scope, key, request: requestAt('b'.repeat(32)), fingerprint: 'f'.repeat(64), now: now + 1, isCurrent: () => true });
  hook.rerender({ version: 1 });
  await waitFor(() => expect(hook.result.current).toHaveLength(2));
  hook.unmount();
});

it('follows an in-session re-pair: re-reads the pairing when the pairing generation bumps', async () => {
  await pair();
  const requestFor = (s: ChildRequestScope, id: string): ChildContactRequest => ({ v: 1, id, guardian, endpoint: s.endpoint, client: s.client,
    persona: s.personas[0], revision: 1, createdAt: now, expiresAt: now + 600,
    invite: { v: 1, recipient: '6'.repeat(64), secret: '7'.repeat(64), relays: ['wss://invite.example/'] } });
  await queueChildContactRequest({ scope, key, request: requestFor(scope, 'a'.repeat(32)), fingerprint: 'f'.repeat(64), now, isCurrent: () => true });
  const hook = renderHook(({ gen }) => useChildContactOutbox({ enabled: true, child: childId, key, guardian, personas: scope.personas, version: 0, pairingGeneration: gen }),
    { initialProps: { gen: 0 } });
  await waitFor(() => expect(hook.result.current.map(e => e.request.id)).toEqual(['a'.repeat(32)]));
  const client2 = new LocalSigningBackend('07'.repeat(32)), endpoint2 = new LocalSigningBackend('06'.repeat(32));
  await savePairedChild({ bunkerUri: `bunker://${endpoint2.activePublicKeyHex}?relay=wss%3A%2F%2Frelay.example`,
    clientKeypair: { publicKey: client2.activePublicKeyHex, privateKey: '07'.repeat(32) },
    dependantPubkey: childId, dependantName: 'Robin', pairedAt: now + 5, hasPaired: true, guardianPubkey: guardian }, key);
  const scope2: ChildRequestScope = { ...scope, endpoint: endpoint2.activePublicKeyHex, client: client2.activePublicKeyHex };
  await queueChildContactRequest({ scope: scope2, key, request: requestFor(scope2, 'b'.repeat(32)), fingerprint: 'f'.repeat(64), now, isCurrent: () => true });
  hook.rerender({ gen: 1 });
  await waitFor(() => expect(hook.result.current.map(e => e.request.id)).toEqual(['b'.repeat(32)]));
  hook.unmount();
});
