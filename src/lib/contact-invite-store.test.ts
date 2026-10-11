import { compactContactInviteVault, parseContactInviteVault } from './contact-invite-store';
import { contactExchangeKey } from './contact-exchange-key';
import { beforeEach, expect, it } from 'vitest';
import { createContactRequest, beginContactExchange, acceptContactExchange, createContactAcceptance, receiveContactAcceptance, confirmContactRevealSent } from '@forgesworn/signet-contacts';
import { getContactAvatar } from './db';
import { handshakeSigil } from './handshake-sigil';
import { getDb, purgeAllUserData } from './db';
import { createStoredContactInvite, loadContactInviteVault, updateContactInviteVault,
  recordContactArrival, restoreContactInviteVault, mergeContactInviteVault, conflictedContactExchanges } from './contact-invite-store';
const KEY = 'invite vault unlock', OWNER = 'a'.repeat(64);
beforeEach(async () => { await purgeAllUserData(); });
it('encrypts invite secrets and preserves them through backup restore', async () => {
  const invite = createStoredContactInvite({ identityPubkey: OWNER, name: 'Business card', relays: ['wss://relay.example'], now: 100 });
  await updateContactInviteVault('owner', KEY, state => ({ ...state, invites: [invite] }));
  const row = await (await getDb()).get('privateVaultState', 'contact-invites:owner');
  expect(JSON.stringify(row)).not.toContain(invite.invite.secret);
  const raw = JSON.stringify(await loadContactInviteVault('owner', KEY));
  await purgeAllUserData();
  await restoreContactInviteVault('owner', KEY, raw);
  expect((await loadContactInviteVault('owner', KEY)).invites).toEqual([invite]);
  await expect(restoreContactInviteVault(`dependant:${OWNER}`, KEY, raw)).rejects.toThrow('Invalid invite vault');
});
it('records one arrival for a single-use invite and deduplicates replay without decrypting identities', async () => {
  const invite = createStoredContactInvite({ identityPubkey: OWNER, name: 'One person', mode: 'single-use', relays: ['wss://relay.example'], now: 100 });
  await updateContactInviteVault('owner', KEY, state => ({ ...state, invites: [invite] }));
  const arrival = { id: 'b'.repeat(64), inviteId: invite.id, identityPubkey: OWNER, receivedAt: 101,
    packet: { v: 1 as const, key: 'c'.repeat(64), ciphertext: 'opaque' } };
  await Promise.all([recordContactArrival('owner', KEY, arrival), recordContactArrival('owner', KEY, arrival)]);
  await recordContactArrival('owner', KEY, { ...arrival, id: 'd'.repeat(64) });
  expect((await loadContactInviteVault('owner', KEY)).arrivals).toHaveLength(1);
});
it('retains pending request nonces across recovery and rejects altered commitments', async () => {
  const nonce = '3'.repeat(64);
  const request = createContactRequest({ id: '4'.repeat(32), from: OWNER, to: '2'.repeat(64), nonce,
    reply: { secret: '5'.repeat(64), relays: ['wss://relay.example'] }, now: 100 });
  const exchange = beginContactExchange(request, nonce);
  await updateContactInviteVault('owner', KEY, state => ({ ...state, exchanges: [exchange] }));
  const state = await loadContactInviteVault('owner', KEY);
  expect(state.exchanges[0].nonce).toBe(nonce);
  await expect(restoreContactInviteVault('owner', KEY, JSON.stringify({ ...state, exchanges: [{ ...exchange, nonce: '9'.repeat(64) }] }))).rejects.toThrow('Invalid contact exchange state');
});

it('quarantines concurrent acceptances without blocking unrelated vault state or changing displayed words', async () => {
  const request = createContactRequest({ id: '4'.repeat(32), from: '2'.repeat(64), to: OWNER, nonce: '3'.repeat(64),
    reply: { secret: '5'.repeat(64), relays: ['wss://relay.example'] }, now: 100 });
  const base = await loadContactInviteVault('owner', KEY);
  const left = { ...base, exchanges: [acceptContactExchange(request, '6'.repeat(64), 101)] };
  const right = { ...base, exchanges: [acceptContactExchange(request, '7'.repeat(64), 102)], invites: [
    createStoredContactInvite({ identityPubkey: OWNER, name: 'Unrelated invite', relays: ['wss://relay.example'], now: 100 }),
  ] };
  const merged = mergeContactInviteVault(left, right);
  expect(mergeContactInviteVault(right, left)).toEqual(merged);
  expect(merged.conflicts).toHaveLength(2);
  expect(conflictedContactExchanges(merged).has(contactExchangeKey(request))).toBe(true);
  expect(merged.invites).toHaveLength(1);
  await restoreContactInviteVault('owner', KEY, JSON.stringify(merged));
  expect((await loadContactInviteVault('owner', KEY)).conflicts).toHaveLength(2);
  expect(mergeContactInviteVault(merged, right)).toEqual(merged);
});
it('isolates peer-chosen request IDs across owned identities', async () => {
  const request = createContactRequest({ id: '4'.repeat(32), from: '2'.repeat(64), to: OWNER, nonce: '3'.repeat(64),
    reply: { secret: '5'.repeat(64), relays: ['wss://relay.example'] }, now: 100 });
  const other = createContactRequest({ ...request, to: 'b'.repeat(64), nonce: '6'.repeat(64), now: 100 });
  expect(contactExchangeKey(request)).not.toBe(contactExchangeKey(other));
  const base = await loadContactInviteVault('owner', KEY);
  const merged = mergeContactInviteVault({ ...base, exchanges: [acceptContactExchange(request, '7'.repeat(64), 101)] },
    { ...base, exchanges: [acceptContactExchange(other, '8'.repeat(64), 101)] });
  await restoreContactInviteVault('owner', KEY, JSON.stringify(merged));
  expect((await loadContactInviteVault('owner', KEY)).exchanges).toHaveLength(2);
  expect(conflictedContactExchanges(merged).size).toBe(0);
});

it('retires dismissed packets while preserving consumed single-use receipts across stale restore', async () => {
  const invite = createStoredContactInvite({ identityPubkey: OWNER, name: 'Once', mode: 'single-use', relays: ['wss://relay.example'], now: 100 });
  const arrival = { id: 'b'.repeat(64), inviteId: invite.id, identityPubkey: OWNER, receivedAt: 101,
    packet: { v: 1 as const, key: 'c'.repeat(64), ciphertext: 'opaque' } };
  const stale = { ...await loadContactInviteVault('owner', KEY), invites: [invite], arrivals: [arrival] };
  const compacted = compactContactInviteVault({ ...stale, arrivals: [{ ...arrival, dismissedAt: 102 }] });
  expect(compacted.arrivals[0]).not.toHaveProperty('packet');
  expect(compacted.arrivals[0].packetHash).toHaveLength(64);
  expect(mergeContactInviteVault(compacted, stale)).toEqual(mergeContactInviteVault(stale, compacted));
  await restoreContactInviteVault('owner', KEY, JSON.stringify(compacted));
  await restoreContactInviteVault('owner', KEY, JSON.stringify(stale));
  await recordContactArrival('owner', KEY, { ...arrival, id: 'd'.repeat(64) });
  const restored = await loadContactInviteVault('owner', KEY);
  expect(restored.arrivals).toHaveLength(1);
  expect(restored.arrivals[0]).not.toHaveProperty('packet');
});
it('frees a standing invite’s pending capacity without forgetting dismissed replay IDs', async () => {
  const invite = createStoredContactInvite({ identityPubkey: OWNER, name: 'Standing', relays: ['wss://relay.example'], now: 100 });
  const arrivals = Array.from({ length: 512 }, (_, n) => ({ id: n.toString(16).padStart(64, '0'), inviteId: invite.id,
    identityPubkey: OWNER, receivedAt: 101, dismissedAt: 102,
    packet: { v: 1 as const, key: 'c'.repeat(64), ciphertext: 'opaque' } }));
  await updateContactInviteVault('owner', KEY, state => ({ ...state, invites: [invite], arrivals }));
  await recordContactArrival('owner', KEY, { ...arrivals[0], dismissedAt: undefined });
  await recordContactArrival('owner', KEY, { ...arrivals[0], id: 'd'.repeat(64), dismissedAt: undefined, packet: { ...arrivals[0].packet, ciphertext: 'new request' } });
  const state = await loadContactInviteVault('owner', KEY);
  expect(state.arrivals).toHaveLength(513);
  expect(state.arrivals.filter(row => row.packet)).toHaveLength(1);
  expect(state.arrivals[0].dismissedAt).toBe(102);
  await expect(parseContactInviteVault(JSON.stringify({ ...state, arrivals: [{ ...state.arrivals[0], dismissedAt: undefined }] }), 'owner')).rejects.toThrow('Invalid contact arrival');
});

it('persists expiry as terminal state so a stale pending backup cannot resume it', async () => {
  const nonce = '3'.repeat(64);
  const request = createContactRequest({ id: '4'.repeat(32), from: OWNER, to: '2'.repeat(64), nonce,
    reply: { secret: '5'.repeat(64), relays: ['wss://relay.example'] }, now: 100, expiresAt: 110 });
  const base = { ...await loadContactInviteVault('owner', KEY), exchanges: [beginContactExchange(request, nonce)] };
  const retired = compactContactInviteVault(base, 110);
  expect(retired.exchanges[0].phase).toBe('declined');
  expect(mergeContactInviteVault(retired, base).exchanges[0].phase).toBe('declined');
  expect(retired.exchanges[0].nonce).toBe(nonce);
});

it('recognises a rewrapped dismissed packet without another identity decryption', async () => {
  const invite = createStoredContactInvite({ identityPubkey: OWNER, name: 'Standing', relays: ['wss://relay.example'], now: 100 });
  const arrival = { id: 'b'.repeat(64), inviteId: invite.id, identityPubkey: OWNER, receivedAt: 101,
    packet: { v: 1 as const, key: 'c'.repeat(64), ciphertext: 'opaque' } };
  await updateContactInviteVault('owner', KEY, state => compactContactInviteVault({ ...state, invites: [invite], arrivals: [{ ...arrival, dismissedAt: 102 }] }));
  await recordContactArrival('owner', KEY, { ...arrival, id: 'd'.repeat(64) });
  const state = await loadContactInviteVault('owner', KEY);
  expect(state.arrivals).toHaveLength(1);
  expect(() => mergeContactInviteVault(state, { ...state, arrivals: [{ ...arrival, packet: { ...arrival.packet, ciphertext: 'changed' } }] })).toThrow('Inbox entry changed');
});

/** A finished handshake exchange whose partner shared a picture. */
function completeHandshake(mark: { strength?: 'tapped' | 'mutual' | 'proven'; confirmedAt?: number } | null) {
  const photo = { key: '8'.repeat(64), server: 'https://blossom.example.com/', hash: '9'.repeat(64) };
  const request = createContactRequest({ id: '4'.repeat(32), from: OWNER, to: '2'.repeat(64), nonce: '3'.repeat(64),
    reply: { secret: '5'.repeat(64), relays: ['wss://relay.example'] }, now: 100, expiresAt: 220 });
  const acceptance = createContactAcceptance(request, '7'.repeat(64), 101, { name: 'Sam', photo });
  const done = confirmContactRevealSent(receiveContactAcceptance(beginContactExchange(request, '3'.repeat(64)), acceptance, 102));
  const handshake = mark ? { startedAt: 100, ...mark, ...(mark.strength ? { sigil: handshakeSigil(done) } : {}) } : undefined;
  return { exchange: { ...done, ...(handshake ? { handshake } : {}) }, peer: '2'.repeat(64) };
}
it('a declined handshake nobody confirmed stays declined when an older or remote copy says complete, in either order', async () => {
  const base = await loadContactInviteVault('owner', KEY);
  const { exchange } = completeHandshake({});
  const complete = { ...base, exchanges: [exchange] }, declined = { ...base, exchanges: [{ ...exchange, phase: 'declined' as const }] };
  for (const [a, b] of [[complete, declined], [declined, complete]]) {
    const merged = mergeContactInviteVault(a, b);
    expect(merged.exchanges[0].phase).toBe('declined');
    expect(merged.exchanges[0].handshake?.strength).toBeUndefined();
  }
  expect(mergeContactInviteVault(complete, declined)).toEqual(mergeContactInviteVault(declined, complete));
});
it('a confirmed handshake still wins over a declined copy, and an ordinary complete exchange is unaffected', async () => {
  const base = await loadContactInviteVault('owner', KEY);
  const confirmed = completeHandshake({ strength: 'tapped', confirmedAt: 110 }).exchange;
  for (const [a, b] of [[confirmed, { ...confirmed, phase: 'declined' as const }], [{ ...confirmed, phase: 'declined' as const }, confirmed]]) {
    expect(mergeContactInviteVault({ ...base, exchanges: [a] }, { ...base, exchanges: [b] }).exchanges[0].phase).toBe('complete');
  }
  const plain = completeHandshake(null).exchange;
  expect(mergeContactInviteVault({ ...base, exchanges: [plain] }, { ...base, exchanges: [{ ...plain, phase: 'declined' }] }).exchanges[0].phase).toBe('complete');
  // Declined on one side, confirmed (strength) on the other copy of the mark: the confirmation wins.
  const unconfirmed = completeHandshake({}).exchange;
  expect(mergeContactInviteVault({ ...base, exchanges: [{ ...unconfirmed, phase: 'declined' }] }, { ...base, exchanges: [confirmed] }).exchanges[0].phase).toBe('complete');
});
it('restoring a vault records the partner photo key only for exchanges that are not handshakes or were confirmed', async () => {
  const base = await loadContactInviteVault('owner', KEY);
  const restoreWith = async (mark: Parameters<typeof completeHandshake>[0]) => {
    await purgeAllUserData();
    const { exchange, peer } = completeHandshake(mark);
    await restoreContactInviteVault('owner', KEY, JSON.stringify({ ...base, exchanges: [exchange] }));
    return getContactAvatar(peer, KEY);
  };
  expect(await restoreWith({})).toBeNull();
  expect(await restoreWith(null)).toMatchObject({ shareKey: '8'.repeat(64) });
  expect(await restoreWith({ strength: 'tapped', confirmedAt: 110 })).toMatchObject({ shareKey: '8'.repeat(64) });
});
