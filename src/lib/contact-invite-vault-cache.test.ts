import { beforeEach, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createContactRequest, beginContactExchange, acceptContactExchange, receiveContactAcceptance, receiveContactReveal,
  confirmContactRevealSent } from '@forgesworn/signet-contacts';
import * as cryptoStore from './crypto-store';
import { getDb, purgeAllUserData } from './db';
import { contactExchangeKey } from './contact-exchange-key';
import { handshakeSigil } from './handshake-sigil';
import { createStoredContactInvite, loadContactInviteVault, updateContactInviteVault, type ContactInviteVault,
  type StoredContactExchange } from './contact-invite-store';
import { checkedContactExchange, forgetContactInviteVaultCache } from './contact-invite-vault-cache';

vi.mock('./crypto-store', async original => {
  const real = await original<typeof import('./crypto-store')>();
  return { ...real, decryptSecret: vi.fn(real.decryptSecret) };
});
const decrypt = vi.mocked(cryptoStore.decryptSecret);
const KEY = 'invite vault cache unlock', OWNER = 'a'.repeat(64);
beforeEach(async () => { await purgeAllUserData(); decrypt.mockClear(); });

/** A vault with every kind of row the parse checks: an invite, an arrival
 * holding an opened request, a completed handshake transcript and an outbox event. */
function fullVault(state: ContactInviteVault): ContactInviteVault {
  const invite = createStoredContactInvite({ identityPubkey: OWNER, name: 'Handshake', mode: 'single-use', relays: ['wss://relay.example'], now: 100, expiresAt: 220 });
  const request = createContactRequest({ id: '5'.repeat(32), from: OWNER, to: '2'.repeat(64), nonce: '4'.repeat(64),
    reply: { secret: '6'.repeat(64), relays: ['wss://relay.example'] }, now: 100 });
  const theirs = acceptContactExchange(request, '7'.repeat(64), 101);
  const ours = confirmContactRevealSent(receiveContactAcceptance(beginContactExchange(request, '4'.repeat(64)), theirs.acceptance!, 102));
  receiveContactReveal(theirs, ours.reveal!, 103);
  const exchange: StoredContactExchange = { ...ours, handshake: { startedAt: 100, strength: 'mutual', confirmedAt: 104, sigil: handshakeSigil(ours) } };
  const incoming = createContactRequest({ id: '8'.repeat(32), from: '3'.repeat(64), to: OWNER, nonce: '9'.repeat(64),
    reply: { secret: 'b'.repeat(64), relays: ['wss://relay.example'] }, now: 100 });
  const event = finalizeEvent({ kind: 1059, created_at: 100, tags: [['p', getPublicKey(generateSecretKey())]], content: 'sealed' }, generateSecretKey());
  return { ...state, invites: [invite],
    arrivals: [{ id: 'c'.repeat(64), inviteId: invite.id, identityPubkey: OWNER, receivedAt: 101, channel: 'invite',
      packet: { v: 1, key: 'd'.repeat(64), ciphertext: 'opaque' }, request: incoming }],
    exchanges: [exchange],
    outbox: [{ id: event.id, identityPubkey: OWNER, event, relays: ['wss://relay.example'], exchangeId: contactExchangeKey(request), messageType: 'reveal' }] };
}

it('reads an unchanged vault without decrypting it again, and a write is never served stale', async () => {
  await updateContactInviteVault('owner', KEY, fullVault);
  decrypt.mockClear();
  const first = await loadContactInviteVault('owner', KEY);
  const second = await loadContactInviteVault('owner', KEY);
  expect(second).toEqual(first);
  expect(decrypt).not.toHaveBeenCalled();
  // Each read is its own copy: changing one cannot reach the next.
  first.invites[0].name = 'Changed by a caller';
  expect((await loadContactInviteVault('owner', KEY)).invites[0].name).toBe('Handshake');
  await updateContactInviteVault('owner', KEY, state => ({ ...state, invites: state.invites.map(i => ({ ...i, name: 'Renamed' })) }));
  expect((await loadContactInviteVault('owner', KEY)).invites[0].name).toBe('Renamed');
});

it('the value remembered at a write is exactly what a cold read of that ciphertext parses', async () => {
  await updateContactInviteVault('owner', KEY, fullVault);
  const warm = await loadContactInviteVault('owner', KEY);
  expect(decrypt).not.toHaveBeenCalled();
  forgetContactInviteVaultCache();
  const cold = await loadContactInviteVault('owner', KEY);
  expect(decrypt).toHaveBeenCalledTimes(1);
  expect(cold).toEqual(warm);
  expect(cold.exchanges[0].handshake?.strength).toBe('mutual');
});

it('forgets everything at lock, and a wrong key never reads the remembered vault', async () => {
  await updateContactInviteVault('owner', KEY, fullVault);
  await loadContactInviteVault('owner', KEY);
  await expect(loadContactInviteVault('owner', 'another unlock key')).rejects.toThrow();
  forgetContactInviteVaultCache();
  decrypt.mockClear();
  await loadContactInviteVault('owner', KEY);
  expect(decrypt).toHaveBeenCalledTimes(1);
});

it('a decrypt still running at lock does not refill the cache', async () => {
  await updateContactInviteVault('owner', KEY, fullVault);
  forgetContactInviteVaultCache();
  decrypt.mockClear();
  const reading = loadContactInviteVault('owner', KEY);
  forgetContactInviteVaultCache();
  await reading;
  await loadContactInviteVault('owner', KEY);
  expect(decrypt).toHaveBeenCalledTimes(2);
});

it('an update still reads a stored vault that no longer validates as plain JSON, and validates what it writes', async () => {
  const broken = { v: 1, directoryId: 'owner', invites: [], arrivals: [], outbox: [], exchanges: [{ role: 'requester', nonce: 'not hex' }] };
  await (await getDb()).put('privateVaultState', { id: 'contact-invites:owner', generation: 1, encrypted: await cryptoStore.encryptSecret(JSON.stringify(broken), KEY) });
  await expect(loadContactInviteVault('owner', KEY)).rejects.toThrow();
  let seen: unknown;
  await updateContactInviteVault('owner', KEY, state => { seen = state.exchanges; return { ...state, exchanges: [] }; });
  expect(seen).toEqual(broken.exchanges);
  expect((await loadContactInviteVault('owner', KEY)).exchanges).toEqual([]);
  await expect(updateContactInviteVault('owner', KEY, state => ({ ...state, exchanges: broken.exchanges as never }))).rejects.toThrow();
});

it('re-checks an exchange whose bytes changed and never remembers one that failed', () => {
  const check = vi.fn((record: { n: number }) => record.n > 0);
  expect(checkedContactExchange({ n: 1 }, check)).toBe(true);
  expect(checkedContactExchange({ n: 1 }, check)).toBe(true);
  expect(check).toHaveBeenCalledTimes(1);
  expect(checkedContactExchange({ n: 2 }, check)).toBe(true);
  expect(check).toHaveBeenCalledTimes(2);
  expect(checkedContactExchange({ n: 0 }, check)).toBe(false);
  expect(checkedContactExchange({ n: 0 }, check)).toBe(false);
  expect(check).toHaveBeenCalledTimes(4);
  forgetContactInviteVaultCache();
  expect(checkedContactExchange({ n: 1 }, check)).toBe(true);
  expect(check).toHaveBeenCalledTimes(5);
});

it('a stored transcript altered after it passed is refused, not waved through by the memo', async () => {
  await updateContactInviteVault('owner', KEY, fullVault);
  const state = await loadContactInviteVault('owner', KEY);
  const tampered = { ...state, exchanges: [{ ...state.exchanges[0], nonce: 'e'.repeat(64) }] };
  await expect(updateContactInviteVault('owner', KEY, () => tampered)).rejects.toThrow('Invalid contact exchange state');
});

it('never lets a pass under one check stand in for another', () => {
  const lenient = vi.fn(() => true), strict = vi.fn(() => false);
  expect(checkedContactExchange({ n: 1 }, lenient)).toBe(true);
  expect(checkedContactExchange({ n: 1 }, strict)).toBe(false);
  expect(strict).toHaveBeenCalledTimes(1);
});
