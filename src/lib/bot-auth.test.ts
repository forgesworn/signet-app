import { beforeEach, expect, it, vi } from 'vitest';
import { getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { unwrapEvent } from 'nostr-tools/nip59';
import { approveBotAuth, parseBotAuthRequest } from './bot-auth';
import { LocalSigningBackend } from './signing-backend';
import { publishToRelay } from './relay-publish';
vi.mock('./relay-publish', async original => ({ ...await original<typeof import('./relay-publish')>(), publishToRelay: vi.fn() }));
const key = '01'.repeat(32), pubkey = getPublicKey(Uint8Array.from({ length: 32 }, () => 1));
const recipient = Uint8Array.from({ length: 32 }, () => 2);
const request = () => ({ type: 'signet-auth-request' as const, requestId: 'a'.repeat(32), challenge: 'test-challenge-123456',
  origin: 'https://consumer.test', timestamp: Math.floor(Date.now() / 1000), relay: 'wss://relay.test', sessionPubkey: getPublicKey(recipient) });
const selection = { source: 'bot' as const, botPubkey: pubkey };
beforeEach(() => { vi.mocked(publishToRelay).mockReset().mockResolvedValue(true); });
it('delivers a real encrypted bot proof without owner fields, credentials or persistent signing authority', async () => {
  const backend = new LocalSigningBackend(key), destroy = vi.spyOn(backend, 'destroy');
  await approveBotAuth({ selection, request: request(), signer: async () => backend, isCurrent: () => true });
  const wrap = vi.mocked(publishToRelay).mock.calls[0][0];
  expect(verifyEvent(wrap)).toBe(true);
  const rumor = unwrapEvent(wrap, recipient);
  expect(rumor.pubkey).toBe(pubkey);
  const response = JSON.parse(rumor.content);
  expect(Object.keys(response).sort()).toEqual(['authEvent', 'requestId', 'type']);
  expect(response.authEvent.pubkey).toBe(pubkey);
  expect(verifyEvent(response.authEvent)).toBe(true);
  expect(response.authEvent.tags).toEqual([['challenge', request().challenge], ['origin', request().origin]]);
  expect(destroy).toHaveBeenCalledOnce();
});
it('rejects credential and connection requests and expired or non-relay requests before signing', async () => {
  for (const value of [{ ...request(), type: 'signet-login-request' }, { ...request(), timestamp: 1 },
    { ...request(), timestamp: NaN }, { ...request(), relay: undefined, sessionPubkey: undefined }]) {
    expect(() => parseBotAuthRequest(JSON.stringify(value))).toThrow();
  }
  expect(() => parseBotAuthRequest('nostrconnect://abcd')).toThrow();
  expect(publishToRelay).not.toHaveBeenCalled();
});
it('rejects a mismatched route and destroys the borrowed wrapper', async () => {
  const backend = new LocalSigningBackend('02'.repeat(32)), destroy = vi.spyOn(backend, 'destroy');
  await expect(approveBotAuth({ selection, request: request(), signer: async () => backend, isCurrent: () => true })).rejects.toThrow('Wrong bot');
  expect(publishToRelay).not.toHaveBeenCalled(); expect(destroy).toHaveBeenCalledOnce();
});
it('drops consent invalidated while signing', async () => {
  const backend = new LocalSigningBackend(key), original = backend.signEvent.bind(backend);
  let current = true;
  vi.spyOn(backend, 'signEvent').mockImplementation(async event => { const signed = await original(event); current = false; return signed; });
  await expect(approveBotAuth({ selection, request: request(), signer: async () => backend, isCurrent: () => current })).rejects.toThrow('session changed');
  expect(publishToRelay).not.toHaveBeenCalled();
});
it('surfaces relay rejection without recording a grant', async () => {
  vi.mocked(publishToRelay).mockResolvedValue(false);
  await expect(approveBotAuth({ selection, request: request(), signer: async () => new LocalSigningBackend(key), isCurrent: () => true })).rejects.toThrow('did not confirm');
});
