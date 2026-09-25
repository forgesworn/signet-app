import { beforeEach, expect, it } from 'vitest';
import { approveChildContact, getChildSettings, purgeAllUserData, saveChildSettings } from './db';
const child = '1'.repeat(64), guardian = '2'.repeat(64), a = '3'.repeat(64), b = '4'.repeat(64);
beforeEach(async () => { await purgeAllUserData(); });
it('merges concurrent explicit approvals without losing the guardian ceiling', async () => {
  await saveChildSettings({ childPubkey: child, guardianPubkey: guardian, contactPolicy: 'approved', defaultChildCeiling: 'ken' });
  await Promise.all([approveChildContact(child, guardian, a), approveChildContact(child, guardian, b)]);
  expect(await getChildSettings(child)).toMatchObject({ contactPolicy: 'approved', defaultChildCeiling: 'ken', approvedContacts: expect.arrayContaining([a, b]) });
});
it('refuses changed policy or a different guardian without adding approval', async () => {
  await saveChildSettings({ childPubkey: child, guardianPubkey: guardian, contactPolicy: 'kin-only' });
  await expect(approveChildContact(child, guardian, a)).rejects.toThrow('policy changed');
  await saveChildSettings({ childPubkey: child, guardianPubkey: guardian, contactPolicy: 'approved' });
  await expect(approveChildContact(child, b, a)).rejects.toThrow('policy changed');
  expect((await getChildSettings(child))?.approvedContacts).toBeUndefined();
});
it('does not lose an approval when a concurrent guardian setting changes the ceiling', async () => {
  const { updateChildContactSettings } = await import('./db');
  await saveChildSettings({ childPubkey: child, guardianPubkey: guardian, contactPolicy: 'approved' });
  await Promise.all([approveChildContact(child, guardian, a),
    updateChildContactSettings(child, guardian, { defaultChildCeiling: 'kith' }), approveChildContact(child, guardian, b)]);
  expect(await getChildSettings(child)).toMatchObject({ approvedContacts: expect.arrayContaining([a,b]), defaultChildCeiling: 'kith', updatedAt: expect.any(Number) });
});
