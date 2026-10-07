import { beforeEach, expect, it } from 'vitest';
import { createContactRequest, beginContactExchange, acceptContactExchange, receiveContactAcceptance, confirmContactRevealSent } from '@forgesworn/signet-contacts';
import { recordCompletedContactExchange, contactPeerAllowed } from './contact-exchange-record';
import { listContactOperationsV2, saveContactOperationsV2, purgeAllUserData } from './db';
import { applyOperations } from './contacts-v2-reducer';
import { buildOperation } from './contacts-v2-mutations';
import { shortNpub } from './nostr-follows';
import { getContactAvatar } from './db';
import { openDB } from 'idb';
const key = 'exchange contact test', own = '1'.repeat(64), peer = '2'.repeat(64);
const actor = { actorPubkey: own, actorRole: 'owner' as const, actorDeviceId: '3'.repeat(32) };
function exchange() {
  const nonce = '4'.repeat(64);
  const request = createContactRequest({ id: '5'.repeat(32), from: own, to: peer, nonce,
    reply: { secret: '6'.repeat(64), relays: ['wss://relay.example'] }, now: 100 });
  const accepted = acceptContactExchange(request, '7'.repeat(64), 101);
  return confirmContactRevealSent(receiveContactAcceptance(beginContactExchange(request, nonce), accepted.acceptance!, 102));
}
const record = () => recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: exchange(), isCurrent: () => true });
beforeEach(purgeAllUserData);
it('creates one Kith contact without asserting that its words were checked, and does not resurrect on replay', async () => {
  const contactId = await record();
  expect(await record()).toBe(contactId);
  let ops = await listContactOperationsV2('owner', key);
  expect(ops).toHaveLength(3);
  const contact = applyOperations(ops).get(`owner/${contactId}`)!;
  expect(contact.tier).toBe('kith');
  expect(contact.identities[0]).toMatchObject({ pubkey: peer, verification: 'unverified' });
  await saveContactOperationsV2([buildOperation({ directoryId: 'owner', contactId, action: 'remove', value: {},
    clock: 100, actor, now: 200000, operationId: '8'.repeat(32) })], key);
  expect(await record()).toBe(contactId);
  ops = await listContactOperationsV2('owner', key);
  expect(ops).toHaveLength(4);
  expect(applyOperations(ops).get(`owner/${contactId}`)!.lifecycle).toBe('removed');
});
it('preserves Kin and refuses a blocked peer before recording an exchange', async () => {
  const contactId = '9'.repeat(32);
  const make = (action: Parameters<typeof buildOperation>[0]['action'], value: unknown, clock: number) => buildOperation({
    directoryId: 'owner', contactId, action, value, clock, actor, now: 1000, operationId: clock.toString(16).padStart(32, '0') });
  await saveContactOperationsV2([make('add', { type: 'person', displayName: 'Friend', tier: 'kin' }, 1),
    make('add-identity', { itemId: 'a'.repeat(32), pubkey: peer, provenance: 'direct', verification: 'unverified' }, 2),
    make('block', { scope: { kind: 'contact' } }, 3)], key);
  expect(await contactPeerAllowed('owner', key, peer)).toBe(false);
  await expect(record()).rejects.toThrow('blocked');
  await purgeAllUserData();
  await saveContactOperationsV2([make('add', { type: 'person', displayName: 'Friend', tier: 'kin' }, 1),
    make('add-identity', { itemId: 'a'.repeat(32), pubkey: peer, provenance: 'direct', verification: 'unverified' }, 2)], key);
  expect(await record()).toBe(contactId);
  expect(applyOperations(await listContactOperationsV2('owner', key)).get(`owner/${contactId}`)!.tier).toBe('kin');
});
it('records confirmed words once and gives concurrent device operations distinct immutable IDs', async () => {
  const confirmed = { ...exchange(), wordsConfirmedAt: 103 };
  const args = { directoryId: 'owner', key, actor, exchange: confirmed, isCurrent: () => true };
  const contactId = await recordCompletedContactExchange(args);
  const first = await listContactOperationsV2('owner', key);
  await recordCompletedContactExchange(args);
  expect(await listContactOperationsV2('owner', key)).toHaveLength(first.length);
  expect(applyOperations(first).get(`owner/${contactId}`)!.checks?.[0]).toMatchObject({ method: 'words', checkedAt: 103000 });
  await purgeAllUserData();
  await recordCompletedContactExchange({ ...args, actor: { ...actor, actorDeviceId: 'e'.repeat(32) } });
  const second = await listContactOperationsV2('owner', key);
  expect(second.some(op => first.some(old => old.operationId === op.operationId))).toBe(false);
  await saveContactOperationsV2(first, key);
  const merged = [...applyOperations(await listContactOperationsV2('owner', key)).values()];
  expect(merged).toHaveLength(1);
  expect(merged[0].checks).toHaveLength(1);
});
it('copies private invite attribution to the contact once and does not recreate a removed history record', async () => {
  const completed = { ...exchange(), origin: { id: 'b'.repeat(32), ownerIdentityPubkey: own,
    method: 'accepted-request' as const, addedAt: 102000, inviteId: 'c'.repeat(32), inviteName: 'Private event name' } };
  const args = { directoryId: 'owner', key, actor, exchange: completed, isCurrent: () => true };
  const contactId = await recordCompletedContactExchange(args);
  const ops = await listContactOperationsV2('owner', key);
  expect(applyOperations(ops).get(`owner/${contactId}`)!.origins).toEqual([completed.origin]);
  await saveContactOperationsV2([buildOperation({ directoryId: 'owner', contactId, action: 'remove-origin', value: { id: completed.origin.id },
    clock: 100, actor, now: 200000, operationId: 'd'.repeat(32) })], key);
  await recordCompletedContactExchange(args);
  expect(applyOperations(await listContactOperationsV2('owner', key)).get(`owner/${contactId}`)!.origins).toEqual([]);
});
const link = (caption?: string) => ({ ...exchange(), origin: { id: 'b'.repeat(32), ownerIdentityPubkey: own,
  method: 'link' as const, addedAt: 102000, ...(caption ? { caption } : {}) } });
const nameOf = async (contactId: string) => applyOperations(await listContactOperationsV2('owner', key)).get(`owner/${contactId}`)!.displayName;
it('names the new contact after the scanned invite caption, sanitised and capped, else the short key', async () => {
  const named = await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: link('  Bob‮ at the fair '), isCurrent: () => true });
  expect(await nameOf(named)).toBe('Bob at the fair');
  await purgeAllUserData();
  const long = await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: link('x'.repeat(150)), isCurrent: () => true });
  expect((await nameOf(long)).length).toBe(100);
  await purgeAllUserData();
  const bare = await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: link(), isCurrent: () => true });
  expect(await nameOf(bare)).toBe(shortNpub(peer));
});
it('keeps an existing contact’s own name rather than the caption', async () => {
  const contactId = '9'.repeat(32);
  const make = (action: Parameters<typeof buildOperation>[0]['action'], value: unknown, clock: number) => buildOperation({
    directoryId: 'owner', contactId, action, value, clock, actor, now: 1000, operationId: clock.toString(16).padStart(32, '0') });
  await saveContactOperationsV2([make('add', { type: 'person', displayName: 'Friend', tier: 'ken' }, 1),
    make('add-identity', { itemId: 'a'.repeat(32), pubkey: peer, provenance: 'direct', verification: 'unverified' }, 2)], key);
  await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: link('Someone else'), isCurrent: () => true });
  expect(await nameOf(contactId)).toBe('Friend');
});
it('falls back to the short key when the caption exceeds the reducer cap in UTF-16 units, and for app handovers', async () => {
  const emoji = await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: link('\u{1F600}'.repeat(60)), isCurrent: () => true });
  expect(await nameOf(emoji)).toBe(shortNpub(peer));
  await purgeAllUserData();
  const app = { ...link('Bob'), origin: { ...link('Bob').origin, method: 'app' as const } };
  const viaApp = await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: app, isCurrent: () => true });
  expect(await nameOf(viaApp)).toBe(shortNpub(peer));
});
const seedExisting = async (verification: 'unverified' | 'proven' | 'mutual') => {
  const contactId = '9'.repeat(32);
  const make = (action: Parameters<typeof buildOperation>[0]['action'], value: unknown, clock: number) => buildOperation({
    directoryId: 'owner', contactId, action, value, clock, actor, now: 1000, operationId: clock.toString(16).padStart(32, '0') });
  await saveContactOperationsV2([make('add', { type: 'person', displayName: 'Friend', tier: 'ken' }, 1),
    make('add-identity', { itemId: 'a'.repeat(32), pubkey: peer, provenance: 'direct', verification }, 2)], key);
  return contactId;
};
const identityOf = async (contactId: string) => applyOperations(await listContactOperationsV2('owner', key)).get(`owner/${contactId}`)!.identities[0];
it('words confirmed marks the peer key mutual, once, and moves a ken to kith', async () => {
  const contactId = await seedExisting('unverified');
  const args = { directoryId: 'owner', key, actor, exchange: { ...exchange(), wordsConfirmedAt: 103 }, isCurrent: () => true };
  await recordCompletedContactExchange(args);
  const record = applyOperations(await listContactOperationsV2('owner', key)).get(`owner/${contactId}`)!;
  expect(record.identities[0].verification).toBe('mutual');
  expect(record.checks?.[0]).toMatchObject({ method: 'words', identityPubkey: peer });
  expect(record.tier).toBe('kith');
  const count = (await listContactOperationsV2('owner', key)).length;
  await recordCompletedContactExchange(args);
  expect(await listContactOperationsV2('owner', key)).toHaveLength(count);
});
it('words confirmed on a brand-new contact also marks its key mutual', async () => {
  const contactId = await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: { ...exchange(), wordsConfirmedAt: 103 }, isCurrent: () => true });
  expect((await identityOf(contactId)).verification).toBe('mutual');
});
it('without words confirmed the key stays unverified and no check is recorded', async () => {
  const contactId = await seedExisting('unverified');
  await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: exchange(), isCurrent: () => true });
  expect((await identityOf(contactId)).verification).toBe('unverified');
  expect(applyOperations(await listContactOperationsV2('owner', key)).get(`owner/${contactId}`)!.checks ?? []).toHaveLength(0);
});
it('a proven key is lifted to mutual, and an already-mutual key gets no further write', async () => {
  const contactId = await seedExisting('proven');
  await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: { ...exchange(), wordsConfirmedAt: 103 }, isCurrent: () => true });
  expect((await identityOf(contactId)).verification).toBe('mutual');
  await purgeAllUserData();
  await seedExisting('mutual');
  await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: { ...exchange(), wordsConfirmedAt: 103 }, isCurrent: () => true });
  expect((await listContactOperationsV2('owner', key)).filter(op => op.action === 'update-identity')).toHaveLength(0);
});

// Partner cards. The requester reads the acceptance's card; the recipient reads the request's.
const photo = { key: '8'.repeat(64), server: 'https://blossom.example.com/', hash: '9'.repeat(64) };
const withCards = (role: 'requester' | 'recipient', card: { name?: string; photo?: typeof photo }, origin?: ReturnType<typeof link>['origin']) => {
  const base = exchange();
  return role === 'requester'
    ? { ...base, acceptance: { ...base.acceptance!, card }, ...(origin ? { origin } : {}) }
    : { ...base, role: 'recipient' as const, request: { ...base.request, card }, ...(origin ? { origin } : {}) };
};
it('requester side: the partner card name beats the invite caption, which beats the short key', async () => {
  const caption = link('Caption name').origin;
  const carded = await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: withCards('requester', { name: 'Card name' }, caption), isCurrent: () => true });
  expect(await nameOf(carded)).toBe('Card name');
  await purgeAllUserData();
  const captionOnly = await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: withCards('requester', { photo }, caption), isCurrent: () => true });
  expect(await nameOf(captionOnly)).toBe('Caption name');
  await purgeAllUserData();
  const neither = await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: withCards('requester', { photo }), isCurrent: () => true });
  expect(await nameOf(neither)).toBe(shortNpub(peer));
});
it('recipient side: the partner card name beats the short key', async () => {
  const carded = await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: withCards('recipient', { name: 'Card name' }), isCurrent: () => true });
  expect(await nameOf(carded)).toBe('Card name');
  await purgeAllUserData();
  const bare = await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: withCards('recipient', {}), isCurrent: () => true });
  expect(await nameOf(bare)).toBe(shortNpub(own));
});
it('an existing contact keeps its own name over a card name, and a card name over the UTF-16 cap falls through', async () => {
  const contactId = await seedExisting('unverified');
  await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: withCards('requester', { name: 'Card name' }), isCurrent: () => true });
  expect(await nameOf(contactId)).toBe('Friend');
  await purgeAllUserData();
  const long = await recordCompletedContactExchange({ directoryId: 'owner', key, actor,
    exchange: withCards('requester', { name: '\u{1F600}'.repeat(60) }, link('Caption name').origin), isCurrent: () => true });
  expect(await nameOf(long)).toBe('Caption name');
});
it('saves the partner photo key with the card server and hash as the fallback, on either side, and not at all without a photo', async () => {
  await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: withCards('requester', { photo }), isCurrent: () => true });
  expect(await getContactAvatar(peer, key)).toMatchObject({ pubkey: peer, shareKey: photo.key, fallback: { server: photo.server, hash: photo.hash } });
  await purgeAllUserData();
  await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: withCards('recipient', { photo }), isCurrent: () => true });
  expect(await getContactAvatar(own, key)).toMatchObject({ shareKey: photo.key, fallback: { server: photo.server, hash: photo.hash } });
  await purgeAllUserData();
  await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: withCards('requester', { name: 'Only a name' }), isCurrent: () => true });
  expect(await getContactAvatar(peer, key)).toBeNull();
});
it('the stored fallback is sealed at rest, and unreadable under another key', async () => {
  await recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: withCards('requester', { photo }), isCurrent: () => true });
  const raw = await (await openDB('my-signet')).get('contactAvatars', peer);
  expect(JSON.stringify(raw)).not.toContain(photo.server);
  expect(JSON.stringify(raw)).not.toContain(photo.key);
  expect(await getContactAvatar(peer, 'a different key')).toBeNull();
});
