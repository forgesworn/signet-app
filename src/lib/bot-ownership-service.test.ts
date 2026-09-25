import { beforeEach, expect, it, vi } from 'vitest';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import { createBot, loadBotRegistry, mergeBotOwnership } from './bot-registry';
import { BotOwnershipService } from './bot-ownership-service';
import { purgeAllUserData } from './db';
import { readBotOwnership } from 'signet-protocol/experimental';
const root = 'a'.repeat(64), secret = hexToBytes('01'.repeat(32)), owner = getPublicKey(secret), key = 'bot ownership test';
const now = 1700000000, day = 86400;
beforeEach(async () => { await purgeAllUserData(); });
async function setup() {
  const bot = await createBot({ root, encryptionKey: key, ownerPersona: owner, ownedPersonas: [owner], label: 'Helper', now,
    source: 'generated', isCurrent: () => true });
  const sign = vi.fn(async (_owner, event) => finalizeEvent(event, secret)), publish = vi.fn(async () => true);
  const service = new BotOwnershipService({ root, encryptionKey: key, sign, publish, isCurrent: () => true, onChanged: vi.fn() });
  const read = async () => (await loadBotRegistry(root, key)).bots[0].ownership!;
  return { bot, sign, publish, service, read };
}
it('keeps creation private, persists explicit publication and sends renewals only after durable signing', async () => {
  const { bot, service, read, sign, publish } = await setup();
  await service.create(bot.publicKey, now);
  expect(sign).toHaveBeenCalledTimes(1);
  await service.flush(now);
  expect(publish).not.toHaveBeenCalled();
  await service.requestPublication(bot.publicKey, now);
  publish.mockResolvedValueOnce(false);
  await service.flush(now);
  expect((await read()).publishedEventId).toBeUndefined();
  await service.flush(now);
  expect((await read()).publishedEventId).toBe((await read()).event.id);
  await service.renew(bot.publicKey, now + 19 * day);
  expect(sign).toHaveBeenCalledTimes(1);
  await service.renew(bot.publicKey, now + 20 * day);
  expect(sign).toHaveBeenCalledTimes(2);
  expect((await read()).publishRequested).toBe(true);
  expect((await read()).publishedEventId).toBeUndefined();
  await service.flush(now + 20 * day);
  expect((await read()).publishedEventId).toBe((await read()).event.id);
});
it('throttles hardware refusal across restarts and never renews a revoked link', async () => {
  const { bot, service, read, sign } = await setup();
  await service.create(bot.publicKey, now);
  sign.mockRejectedValueOnce(new Error('Device refused'));
  await expect(service.renew(bot.publicKey, now + 20 * day)).rejects.toThrow('refused');
  await service.renew(bot.publicKey, now + 20 * day + 1);
  expect(sign).toHaveBeenCalledTimes(2);
  await service.renew(bot.publicKey, now + 21 * day);
  expect(sign).toHaveBeenCalledTimes(3);
  await service.revoke(bot.publicKey, now + 22 * day);
  expect((await readBotOwnership((await read()).event, { ownerPubkey: owner, botPubkey: bot.publicKey, now: now + 22 * day })).status).toBe('revoked');
  await service.renew(bot.publicKey, now + 60 * day);
  expect(sign).toHaveBeenCalledTimes(4);
});
it('retains the newest signed claim and explicit publication consent through an older device merge', async () => {
  const { bot, service, read } = await setup();
  await service.create(bot.publicKey, now);
  const old = await read();
  await service.requestPublication(bot.publicKey, now);
  await service.revoke(bot.publicKey, now + 1);
  const revoked = await read();
  const merged = mergeBotOwnership(old, revoked)!;
  expect(merged).toEqual(mergeBotOwnership(revoked, old));
  expect(merged.event.id).toBe(revoked.event.id);
  expect(merged.publishRequested).toBe(true);
});
