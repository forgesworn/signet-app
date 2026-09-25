import { beforeEach, expect, it } from 'vitest';
import { purgeAllUserData, savePreferences, getPreferences } from './db';
import { settingsVaultAdapter } from './private-vault-settings';
const KEY = 'settings unlock';
beforeEach(async () => { await purgeAllUserData(); });
it('backs up portable settings without pairing secrets or device state', async () => {
  await savePreferences({ id: 'current', theme: 'dark', signingMode: 'bunker', contactsDeviceId: 'a'.repeat(32),
    bunkerUri: `bunker://${'b'.repeat(64)}?secret=do-not-share`, activeAccountId: 'local-account' }, KEY);
  const adapter = settingsVaultAdapter(KEY, () => true);
  const value = JSON.parse(await adapter.snapshot());
  expect(value.values).toEqual({ theme: 'dark' });
  expect(value.updatedAt).toBeGreaterThan(0);
  await adapter.merge(JSON.stringify({ v: 1, updatedAt: value.updatedAt + 1,
    values: { theme: 'light', signingMode: 'local', bunkerUri: 'injected', contactsDeviceId: 'injected' } }), 0);
  const restored = await getPreferences(KEY);
  expect(restored.theme).toBe('light');
  expect(restored.signingMode).toBe('bunker');
  expect(restored.bunkerUri).toContain('do-not-share');
  expect(restored.contactsDeviceId).toBe('a'.repeat(32));
});
it('does not let device-only preference changes advance the portable timestamp', async () => {
  await savePreferences({ id: 'current', theme: 'dark' });
  const first = await getPreferences();
  await savePreferences({ ...first, contactsDeviceId: 'b'.repeat(32) });
  expect((await getPreferences()).portableSettingsUpdatedAt).toBe(first.portableSettingsUpdatedAt);
});

it('restores owned grants independently of preference timestamps and refuses foreign grants', async () => {
  const db = await import('./db');
  const owner = 'a'.repeat(64);
  const adapter = settingsVaultAdapter(KEY, () => true, async () => [owner]);
  await savePreferences({ id: 'current', theme: 'dark' }, KEY);
  const grant = { dependantId: owner, scope: 'sign_event:1', origin: 'https://example.com', decision: 'allow', decidedAt: 1 };
  await adapter.merge(JSON.stringify({ v: 1, updatedAt: 0, values: { theme: 'light' }, grants: [grant] }), 0);
  expect((await getPreferences(KEY)).theme).toBe('dark');
  expect(await db.listAllGrantsIncludingTombstones()).toMatchObject([grant]);
  await expect(adapter.merge(JSON.stringify({ v: 1, updatedAt: 0, values: { theme: 'light' },
    grants: [{ ...grant, dependantId: 'b'.repeat(64) }] }), 0)).rejects.toThrow('another owner');
});

it('restores family policies and approvals independently of preferences, canonicalising an owned legacy guardian alias', async () => {
  const db = await import('./db');
  const guardian = 'a'.repeat(64), child = 'b'.repeat(64), legacy = 'c'.repeat(64), peer = 'd'.repeat(64);
  const adapter = settingsVaultAdapter(KEY, () => true, async () => [guardian, child], { guardianPubkey: guardian, legacyGuardianPubkeys: async () => [legacy] });
  await db.saveChildSettings({ childPubkey: child, guardianPubkey: legacy, contactPolicy: 'approved', approvedContacts: [peer], defaultChildCeiling: 'ken' });
  const snapshot = await adapter.snapshot();
  expect(JSON.parse(snapshot).childSettings).toEqual([{ childPubkey: child, guardianPubkey: guardian, contactPolicy: 'approved', approvedContacts: [peer], defaultChildCeiling: 'ken', updatedAt: 0 }]);
  await purgeAllUserData();
  await adapter.merge(snapshot, 0);
  expect(await db.getChildSettings(child)).toMatchObject({ guardianPubkey: guardian, approvedContacts: [peer] });
  const payload = JSON.parse(snapshot);
  payload.childSettings[0].contactPolicy = 'open';
  await adapter.merge(JSON.stringify(payload), 0);
  expect((await db.getChildSettings(child))?.contactPolicyConflicted).toBe(true);
  await db.updateChildContactSettings(child, guardian, { contactPolicy: 'approved' });
  const chosen = await db.getChildSettings(child);
  expect(chosen?.contactPolicyConflicted).toBe(false);
  await adapter.merge(snapshot, 0);
  expect(await db.getChildSettings(child)).toMatchObject({ contactPolicy: 'approved', updatedAt: chosen!.updatedAt });
});
it('validates all family ownership and grant scope before changing any settings', async () => {
  const db = await import('./db');
  const guardian = 'a'.repeat(64), child = 'b'.repeat(64), stranger = 'f'.repeat(64);
  const adapter = settingsVaultAdapter(KEY, () => true, async () => [guardian, child], { guardianPubkey: guardian, legacyGuardianPubkeys: async () => [] });
  const row = { childPubkey: child, guardianPubkey: guardian, contactPolicy: 'open', updatedAt: 100 };
  for (const rows of [[{ ...row, childPubkey: stranger }], [{ ...row, guardianPubkey: stranger }], [row, row]]) {
    await expect(adapter.merge(JSON.stringify({ v: 1, updatedAt: 0, values: {}, childSettings: rows }), 0)).rejects.toThrow();
    expect(await db.getChildSettings(child)).toBeUndefined();
  }
  await expect(adapter.merge(JSON.stringify({ v: 1, updatedAt: 0, values: {}, childSettings: [row],
    grants: [{ dependantId: stranger, scope: 'sign_event:1', origin: 'https://example.com', decision: 'allow', decidedAt: 1 }] }), 0)).rejects.toThrow();
  expect(await db.getChildSettings(child)).toBeUndefined();
});
