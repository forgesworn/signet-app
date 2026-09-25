import { beforeEach, expect, it } from 'vitest';
import { LocalSigningBackend } from './signing-backend';
import { purgeAllUserData } from './db';
import { childContactRequestInScope, sealChildContactRequest } from './child-contact-requests';
import {
  attachChildContactRequestEvent, loadChildContactOutbox, openChildContactReply, parseChildContactReply,
  queueChildContactRequest, sealChildContactReply,
} from './child-contact-exchange';
import type { ChildContactRequest, ChildRequestScope } from './child-contact-requests';

const child = new LocalSigningBackend('05'.repeat(32));
const guardian = new LocalSigningBackend('04'.repeat(32));
const scope: ChildRequestScope = { guardian: '1'.repeat(64), child: '2'.repeat(64), endpoint: guardian.activePublicKeyHex,
  client: child.activePublicKeyHex, personas: ['3'.repeat(64)] };
const now = 1800000000, key = 'child-exchange-test-key', current = () => true;
const request = (): ChildContactRequest => ({ v: 1, id: 'a'.repeat(32), guardian: scope.guardian, endpoint: scope.endpoint,
  client: scope.client, persona: scope.personas[0], revision: 1, createdAt: now, expiresAt: now + 600,
  invite: { v: 1, recipient: '6'.repeat(64), secret: '7'.repeat(64), relays: ['wss://invite.example/'] } });

beforeEach(async () => { await purgeAllUserData(); });

it('invalidates request authority on re-pairing and persona withdrawal', () => {
  const r = request();
  expect(childContactRequestInScope(r, scope)).toBe(true);
  expect(childContactRequestInScope(r, { ...scope, endpoint: '8'.repeat(64) })).toBe(false);
  expect(childContactRequestInScope(r, { ...scope, client: '8'.repeat(64) })).toBe(false);
  expect(childContactRequestInScope(r, { ...scope, guardian: '8'.repeat(64) })).toBe(false);
  expect(childContactRequestInScope(r, { ...scope, personas: [] })).toBe(false);
});

it('authenticates a guardian reply before decrypting and pins the pairing', async () => {
  const reply = { v: 1 as const, requestId: 'a'.repeat(32), guardian: scope.guardian, endpoint: scope.endpoint,
    client: scope.client, persona: scope.personas[0], revision: 1, createdAt: now, expiresAt: now + 600,
    status: 'completed' as const, exchangeId: 'b'.repeat(32), contactId: 'c'.repeat(32) };
  expect(parseChildContactReply(JSON.stringify(reply))).toEqual(reply);
  const event = await sealChildContactReply(reply, guardian);
  expect(event.tags).toEqual([['d', `signet:child-contact-reply:v1:${reply.requestId}`], ['p', scope.client]]);
  expect(await openChildContactReply(event, { scope, client: child, now, isCurrent: current })).toMatchObject({ reply });
  expect(await openChildContactReply(event, { scope: { ...scope, endpoint: scope.child }, client: child, now, isCurrent: current })).toBeNull();
  expect(parseChildContactReply(JSON.stringify({ ...reply, status: 'denied', exchangeId: undefined, contactId: undefined }))).toMatchObject({ status: 'denied' });
  expect(parseChildContactReply(JSON.stringify({ ...reply, status: 'pending', exchangeId: undefined, contactId: undefined }))).toMatchObject({ status: 'pending' });
});

it('queues one child request before signing and attaches one reusable event', async () => {
  const r = request();
  const queued = await queueChildContactRequest({ scope, key, request: r, fingerprint: 'f'.repeat(64), now, isCurrent: current });
  expect(queued.event).toBeUndefined();
  const event = await sealChildContactRequest(r, child);
  const attached = await attachChildContactRequestEvent({ scope, key, requestId: r.id, event, isCurrent: current });
  expect(attached.event?.id).toBe(event.id);
  expect((await loadChildContactOutbox(scope, key, current))[0].event?.id).toBe(event.id);
  await expect(attachChildContactRequestEvent({ scope, key, requestId: r.id, event: { ...event, id: 'd'.repeat(64) }, isCurrent: current })).rejects.toThrow();
  await expect(queueChildContactRequest({ scope: { ...scope, client: scope.child }, key, request: r, fingerprint: 'f'.repeat(64), now, isCurrent: current })).rejects.toThrow();
});

it('does not persist a request after the pairing changes during the write', async () => {
  let active = true;
  await expect(queueChildContactRequest({ scope, key, request: request(), fingerprint: 'f'.repeat(64), now, isCurrent: () => active })).resolves.toBeTruthy();
  active = false;
  await expect(loadChildContactOutbox(scope, key, () => active)).rejects.toThrow('session changed');
});
