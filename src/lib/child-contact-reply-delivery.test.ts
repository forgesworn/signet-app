import { beforeEach, expect, it, vi } from 'vitest';
import { LocalSigningBackend } from './signing-backend';
import { purgeAllUserData } from './db';
import { sealChildContactReply, type ChildContactReply } from './child-contact-exchange';
import { deliverChildContactReply, loadChildContactReplyOutbox, queueChildContactReply } from './child-contact-reply-delivery';
import type { ChildRequestScope } from './child-contact-requests';

const child = new LocalSigningBackend('05'.repeat(32)), endpoint = new LocalSigningBackend('04'.repeat(32));
const scope: ChildRequestScope = { guardian: '1'.repeat(64), child: '2'.repeat(64), endpoint: endpoint.activePublicKeyHex, client: child.activePublicKeyHex, personas: ['3'.repeat(64)] };
const now = 1800000000, key = 'child-reply-delivery', current = () => true;
const pending: ChildContactReply = { v: 1, requestId: 'a'.repeat(32), guardian: scope.guardian, endpoint: scope.endpoint, client: scope.client, persona: scope.personas[0], revision: 1, createdAt: now, expiresAt: now + 600, status: 'pending' };
async function reply() { return sealChildContactReply(pending, endpoint); }
beforeEach(async () => { vi.restoreAllMocks(); await purgeAllUserData(); });

it('persists a signed reply before publishing and acknowledges it once', async () => {
  const event = await reply(); await queueChildContactReply({ scope, key, requestId: 'a'.repeat(32), event, reply: pending, relays: ['wss://relay.example'], now, isCurrent: current });
  const publish = vi.fn(async () => true);
  expect(await deliverChildContactReply({ scope, key, id: 'a'.repeat(32), now, isCurrent: current, mayDeliver: () => true, publish })).toBe(true);
  expect(await deliverChildContactReply({ scope, key, id: 'a'.repeat(32), now: now + 1, isCurrent: current, mayDeliver: () => true, publish })).toBe(false);
  expect(publish).toHaveBeenCalledTimes(1); expect((await loadChildContactReplyOutbox(scope, key, current))[0].acknowledgedAt).toBe(now);
});

it('suppresses publication when policy or pairing changes', async () => {
  const event = await reply(); await queueChildContactReply({ scope, key, requestId: 'a'.repeat(32), event, reply: pending, relays: ['wss://relay.example'], now, isCurrent: current });
  const publish = vi.fn(async () => true);
  await expect(deliverChildContactReply({ scope, key, id: 'a'.repeat(32), now, isCurrent: current, mayDeliver: () => false, publish })).rejects.toThrow('policy');
  let active = true;
  await expect(deliverChildContactReply({ scope, key, id: 'a'.repeat(32), now, isCurrent: () => active, mayDeliver: async () => { active = false; return true; }, publish })).rejects.toThrow('session');
  expect(publish).not.toHaveBeenCalled(); expect((await loadChildContactReplyOutbox(scope, key, current))[0].acknowledgedAt).toBeUndefined();
});

it('delivers completion after acknowledged pending, preserves retries and rejects terminal substitution', async () => {
  const options = { scope, key, requestId: pending.requestId, relays: ['wss://relay.example'], now, isCurrent: current };
  const pendingEvent = await reply();
  await queueChildContactReply({ ...options, event: pendingEvent, reply: pending });
  const publish = vi.fn(async () => true);
  await deliverChildContactReply({ ...options, id: pending.requestId, mayDeliver: () => true, publish });
  const completed: ChildContactReply = { ...pending, status: 'completed', exchangeId: 'b'.repeat(32), contactId: 'c'.repeat(32), createdAt: now + 1 };
  const event = await sealChildContactReply(completed, endpoint);
  await queueChildContactReply({ ...options, event, reply: completed });
  expect((await loadChildContactReplyOutbox(scope, key, current))[0].acknowledgedAt).toBeUndefined();
  await deliverChildContactReply({ ...options, id: pending.requestId, mayDeliver: () => true, publish });
  expect(publish.mock.calls.map(args => (args as unknown as [typeof event])[0].id)).toEqual([pendingEvent.id, event.id]);
  const retry = { ...completed, createdAt: now + 2 };
  await queueChildContactReply({ ...options, event: await sealChildContactReply(retry, endpoint), reply: retry });
  await queueChildContactReply({ ...options, event: pendingEvent, reply: pending });
  expect((await loadChildContactReplyOutbox(scope, key, current))[0].event.id).toBe(event.id);
  const conflict = { ...retry, contactId: 'd'.repeat(32) };
  await expect(queueChildContactReply({ ...options, event: await sealChildContactReply(conflict, endpoint), reply: conflict })).rejects.toThrow('conflict');
});
