import { beforeEach, expect, it, vi } from 'vitest';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import { ContactIdentityDecryptBudget } from '@forgesworn/signet-contacts';
import { openContactMailboxWrap } from '@forgesworn/signet-contacts/adapters/invite-nostr-tools';
import { ContactInviteService } from './contact-invite-service';
import { recordContactArrival } from './contact-invite-store';
import { contactExchangeKey } from './contact-exchange-key';
import { recordCompletedContactExchange } from './contact-exchange-record';
import { partnerCardOf } from './contact-card-share';
import { applyOperations } from './contacts-v2-reducer';
import { getContactAvatar, listContactOperationsV2, purgeAllUserData } from './db';

const publish = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./sync-relays', () => ({ publishToRelays: publish }));
const KEY = 'test card round trip';
function party(secret: string, directoryId: string) {
  const sk = hexToBytes(secret), pubkey = getPublicKey(sk);
  const signer = { publicKey: pubkey, signEvent: vi.fn(async (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, sk)),
    decrypt: vi.fn(async (sender: string, ct: string) => nip44.v2.decrypt(ct, nip44.v2.utils.getConversationKey(sk, sender))) };
  const service = new ContactInviteService({ directoryId, encryptionKey: KEY, budget: new ContactIdentityDecryptBudget(),
    signer: async k => { if (k !== pubkey) throw new Error('Wrong identity'); return signer; },
    isCurrent: () => true, onChanged: vi.fn(), mayConnect: () => true });
  return { pubkey, service, directoryId };
}
const photo = (n: string) => ({ key: n.repeat(64), server: 'https://blossom.example.com/', hash: String.fromCharCode(n.charCodeAt(0) + 1).repeat(64) });
const aCard = { name: 'Alice at the fair', photo: photo('a') };
const bCard = { name: 'Bob', photo: photo('c') };
beforeEach(async () => { await purgeAllUserData(); publish.mockReset().mockResolvedValue(true); });

async function run(requestCard: typeof aCard | undefined, acceptCard: typeof bCard | undefined) {
  const a = party('01'.repeat(32), 'owner'), b = party('02'.repeat(32), `dependant:${'b'.repeat(64)}`);
  const now = 1700000000;
  const invite = await b.service.create(b.pubkey, 'Conference', ['wss://relay.example'], 'single-use', now);
  await a.service.request(a.pubkey, invite.invite, now + 1, undefined, requestCard);
  const first = await a.service.read();
  await recordContactArrival(b.directoryId, KEY, { id: first.outbox[0].id, inviteId: invite.id, identityPubkey: b.pubkey,
    packet: openContactMailboxWrap(first.outbox[0].event, invite.invite.secret)!, receivedAt: now + 2 });
  await b.service.openInbox(now + 3);
  const arrival = (await b.service.read()).arrivals[0];
  await b.service.accept(first.outbox[0].id, now + 4, false, false, acceptCard);
  await b.service.flush(now + 5);
  const receiver = await b.service.read(), exchange = receiver.exchanges[0];
  await recordContactArrival(a.directoryId, KEY, { id: receiver.outbox[0].id, inviteId: contactExchangeKey(exchange.request),
    identityPubkey: a.pubkey, packet: openContactMailboxWrap(receiver.outbox[0].event, exchange.request.reply.secret)!, receivedAt: now + 6, channel: 'exchange' });
  await a.service.openInbox(now + 7);
  await a.service.flush(now + 8);
  const sender = await a.service.read();
  const reveal = sender.outbox[1];
  await recordContactArrival(b.directoryId, KEY, { id: reveal.id, inviteId: contactExchangeKey(exchange.request), identityPubkey: b.pubkey,
    packet: openContactMailboxWrap(reveal.event, exchange.request.reply.secret)!, receivedAt: now + 9, channel: 'exchange' });
  await b.service.openInbox(now + 10);
  return { a, b, arrival, requesterSide: (await a.service.read()).exchanges[0], recipientSide: (await b.service.read()).exchanges[0] };
}

it('carries each side card through the real library, service and vault, and records the partner card on completion', async () => {
  const { a, b, arrival, requesterSide, recipientSide } = await run(aCard, bCard);
  expect(arrival.request?.card).toEqual(aCard);                       // what the recipient saw before accepting
  expect(requesterSide.phase).toBe('complete'); expect(recipientSide.phase).toBe('complete');
  expect(partnerCardOf(requesterSide)).toEqual(bCard);                // requester reads the acceptance's card
  expect(partnerCardOf(recipientSide)).toEqual(aCard);                // recipient reads the request's card
  // The acceptance never inherits the requester's card.
  expect(requesterSide.acceptance?.card).toEqual(bCard);

  const aContact = await recordCompletedContactExchange({ directoryId: 'owner', key: KEY, exchange: requesterSide, isCurrent: () => true,
    actor: { actorPubkey: a.pubkey, actorRole: 'owner', actorDeviceId: '3'.repeat(32) } });
  const bContact = await recordCompletedContactExchange({ directoryId: b.directoryId, key: KEY, exchange: recipientSide, isCurrent: () => true,
    actor: { actorPubkey: b.pubkey, actorRole: 'guardian', actorDeviceId: '4'.repeat(32) } });
  const name = async (dir: string, id: string) => applyOperations(await listContactOperationsV2(dir, KEY)).get(`${dir}/${id}`)!.displayName;
  expect(await name('owner', aContact)).toBe('Bob');
  expect(await name(b.directoryId, bContact)).toBe('Alice at the fair');
  expect(await getContactAvatar(b.pubkey, KEY)).toMatchObject({ shareKey: bCard.photo.key, fallback: { server: bCard.photo.server, hash: bCard.photo.hash } });
  expect(await getContactAvatar(a.pubkey, KEY)).toMatchObject({ shareKey: aCard.photo.key, fallback: { server: aCard.photo.server, hash: aCard.photo.hash } });
}, 120000);

it('sends no card property at all when none was chosen, and still completes', async () => {
  const { arrival, requesterSide, recipientSide } = await run(undefined, undefined);
  expect(arrival.request).not.toHaveProperty('card');
  expect(partnerCardOf(requesterSide)).toBeUndefined();
  expect(partnerCardOf(recipientSide)).toBeUndefined();
  expect(requesterSide.phase).toBe('complete');
}, 60000);
