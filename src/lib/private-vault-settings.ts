import { parsePayload as parseGrants, mergeGrantLists } from './grants-sync';
import * as db from './db';
import { portableSettingsValues, parsePortableSettings } from './portable-settings';
import { portableChildContactSettings } from './child-contact-settings';
import { contactsMutationQueue } from './contacts-v2-queue';
import type { PrivateVaultDatasetAdapter } from './private-vault-sync';

export function settingsVaultAdapter(encryptionKey: string, isCurrent: () => boolean,
  grantOwners?: () => Promise<string[]>, family?: { guardianPubkey: string; legacyGuardianPubkeys(): Promise<string[]> }): PrivateVaultDatasetAdapter {
  const current = () => { if (!isCurrent()) throw new Error('Vault session changed'); };
  return {
    dataset: 'settings',
    snapshot: async () => {
      current();
      const preferences = await db.getPreferences(encryptionKey);
      const raw = JSON.stringify({ v: 1, updatedAt: preferences.portableSettingsUpdatedAt ?? 0,
        values: portableSettingsValues(preferences) });
      if (!parsePortableSettings(raw)) throw new Error('Portable settings cannot be backed up');
      current();
      if (!grantOwners) return raw;
      const owners = new Set(await grantOwners());
      const grants = (await db.listAllGrantsIncludingTombstones()).filter(g => owners.has(g.dependantId))
        .sort((a, b) => JSON.stringify([a.dependantId, a.scope, a.origin]).localeCompare(JSON.stringify([b.dependantId, b.scope, b.origin])));
      const childSettings = [];
      if (family) {
        const aliases = new Set([family.guardianPubkey, ...await family.legacyGuardianPubkeys()]);
        for (const child of [...owners].filter(key => key !== family.guardianPubkey).sort()) {
          const row = await db.getChildSettings(child);
          if (!row) continue;
          if (!aliases.has(row.guardianPubkey)) throw new Error('Child settings belong to another guardian');
          const value = portableChildContactSettings({ ...row, guardianPubkey: family.guardianPubkey });
          if (!value) throw new Error('Invalid child contact settings');
          childSettings.push(value);
        }
      }
      current();
      return JSON.stringify({ ...JSON.parse(raw), grants, ...(family ? { childSettings } : {}) });
    },
    merge: raw => contactsMutationQueue.run(async () => {
      const value = JSON.parse(raw);
      const parsed = parsePortableSettings(JSON.stringify({ v: value?.v, updatedAt: value?.updatedAt, values: value?.values }));
      if (!parsed) throw new Error('Invalid settings vault');
      const local = await db.getPreferences(encryptionKey);
      const writes: Array<() => Promise<void>> = [];
      current();
      if (value.childSettings !== undefined) {
        if (!family || !grantOwners || !Array.isArray(value.childSettings) || value.childSettings.length > 500) throw new Error('Invalid child contact settings');
        const owners = new Set(await grantOwners());
        const settings = value.childSettings.map(portableChildContactSettings);
        if (settings.some((row: ReturnType<typeof portableChildContactSettings>) => !row || row.guardianPubkey !== family.guardianPubkey
          || row.childPubkey === family.guardianPubkey || !owners.has(row.childPubkey))
          || new Set(settings.map((row: NonNullable<ReturnType<typeof portableChildContactSettings>>) => row.childPubkey)).size !== settings.length) {
          throw new Error('Child settings belong to another guardian');
        }
        const aliases = await family.legacyGuardianPubkeys();
        for (const row of settings) writes.push(() => db.restoreChildContactSettings(row!, aliases));
      }
      if (value.grants !== undefined) {
        if (!grantOwners || !Array.isArray(value.grants) || value.grants.length > 5000) throw new Error('Invalid settings grants');
        const grants = parseGrants(JSON.stringify({ v: 1, grants: value.grants }));
        const owners = new Set(await grantOwners());
        if (!grants || grants.length !== value.grants.length || grants.some(g => !owners.has(g.dependantId))) throw new Error('Settings grant belongs to another owner');
        const { toSave } = mergeGrantLists(await db.listAllGrantsIncludingTombstones(), grants);
        for (const grant of toSave) writes.push(() => db.saveGrant(grant));
      }
      for (const write of writes) { current(); await write(); }
      if (parsed.updatedAt <= (local.portableSettingsUpdatedAt ?? -1)) return;
      // Missing optional portable fields represent a reset to defaults.
      const updated = { ...local };
      for (const field of Object.keys(portableSettingsValues(local))) delete (updated as unknown as Record<string, unknown>)[field];
      await db.savePreferences({ ...updated, ...parsed.values }, encryptionKey, parsed.updatedAt);
    }),
  };
}
