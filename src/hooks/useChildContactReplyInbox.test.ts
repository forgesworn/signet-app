import { beforeEach, expect, it } from 'vitest';
import { getDb, purgeAllUserData } from '../lib/db';
import { openChildContactReply, sealChildContactReply, type ChildContactReply } from '../lib/child-contact-exchange';
import { LocalSigningBackend } from '../lib/signing-backend';
import { loadChildContactReplyReceipts, saveChildContactReplyReceipt } from './useChildContactReplyInbox';
const client = new LocalSigningBackend('05'.repeat(32)), endpoint = new LocalSigningBackend('04'.repeat(32));
const scope = { guardian: '1'.repeat(64), child: '2'.repeat(64), endpoint: endpoint.activePublicKeyHex, client: client.activePublicKeyHex, personas: ['3'.repeat(64)] };
const now = 1800000000, key = 'reply-inbox-test', current = () => true;
const pending: ChildContactReply = { v: 1, requestId: 'a'.repeat(32), guardian: scope.guardian, endpoint: scope.endpoint, client: scope.client, persona: scope.personas[0], revision: 1, createdAt: now, expiresAt: now + 600, status: 'pending' };
async function receive(reply: ChildContactReply) {
  const opened = (await openChildContactReply(await sealChildContactReply(reply, endpoint), { scope, client, now: now + 10, isCurrent: current }))!;
  return saveChildContactReplyReceipt(scope, key, { id: reply.requestId, fingerprint: opened.fingerprint, reply: opened.reply, receivedAt: now + 10 }, current);
}
beforeEach(async () => { await purgeAllUserData(); });
it('persists terminal progress across reload without accepting an older pending replay', async () => {
  await receive(pending);
  const completed: ChildContactReply = { ...pending, status: 'completed', exchangeId: 'b'.repeat(32), createdAt: now + 1 };
  await receive(completed);
  await receive(pending);
  expect((await loadChildContactReplyReceipts(scope, key, current)).map(row => row.reply)).toEqual([completed]);
  await expect(receive({ ...completed, exchangeId: 'c'.repeat(32), createdAt: now + 2 })).rejects.toThrow('conflict');
  await expect(receive({ ...completed, status: 'pending', exchangeId: undefined, createdAt: now + 3 })).rejects.toThrow('conflict');
});
it('rejects equal-timestamp status changes and request-scope substitution', async () => {
  await receive(pending);
  await expect(receive({ ...pending, status: 'completed', exchangeId: 'b'.repeat(32) })).rejects.toThrow('conflict');
  await expect(receive({ ...pending, revision: 2, createdAt: now + 1 })).rejects.toThrow('scope conflict');
});
it('a stored reply naming a persona since hidden is skipped, not fatal, and survives until the persona is back', async () => {
  const P2 = '4'.repeat(64);
  const wide = { ...scope, personas: [scope.personas[0], P2] }, narrow = { ...scope, personas: [P2] };
  const receiveIn = async (s: typeof scope, reply: ChildContactReply) => {
    const opened = (await openChildContactReply(await sealChildContactReply(reply, endpoint), { scope: s, client, now: now + 10, isCurrent: current }))!;
    return saveChildContactReplyReceipt(s, key, { id: reply.requestId, fingerprint: opened.fingerprint, reply: opened.reply, receivedAt: now + 10 }, current);
  };
  await receiveIn(wide, pending);
  // The first persona is hidden: its reply drops out of the loaded set, and the inbox still loads and saves.
  expect(await loadChildContactReplyReceipts(narrow, key, current)).toEqual([]);
  const other: ChildContactReply = { ...pending, requestId: 'b'.repeat(32), persona: P2 };
  await receiveIn(narrow, other);
  expect((await loadChildContactReplyReceipts(narrow, key, current)).map(r => r.id)).toEqual(['b'.repeat(32)]);
  // Shown again: nothing was pruned on save.
  expect((await loadChildContactReplyReceipts(wide, key, current)).map(r => r.id).sort()).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
});
it('an unreadable inbox stays an error — never read as empty and saved over', async () => {
  await receive(pending);
  const db = await getDb(), row = (await db.getAll('privateVaultState'))[0];
  await db.put('privateVaultState', { ...row, encrypted: 'broken' });
  await expect(loadChildContactReplyReceipts(scope, key, current)).rejects.toThrow();
  await expect(receive({ ...pending, requestId: 'c'.repeat(32) })).rejects.toThrow();
  expect((await db.get('privateVaultState', row.id))?.encrypted).toBe('broken');
});
