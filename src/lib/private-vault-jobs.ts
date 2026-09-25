import type { SignetIdentity } from '../types';
import type { VaultDataset } from 'signet-protocol/experimental';
import type { PrivateVaultJob } from '../hooks/usePrivateVaults';
import type { PrivateVaultDatasetAdapter } from './private-vault-sync';
import type { BunkerSigningBackend } from './signing-backend';
import { localVaultBackend } from './private-vault';
import { profilesVaultAdapter } from './private-vault-profiles';
import { contactsVaultAdapter } from './private-vault-contacts';
import { credentialsVaultAdapter } from './private-vault-credentials';
import { settingsVaultAdapter } from './private-vault-settings';
import { directoryIdForDependant } from './contacts-v2-ids';
import { derivePubkeysFromMnemonic } from './signet';
import * as db from './db';

export function hasLocalVaultTree(identity: SignetIdentity | null): boolean {
  if (!identity?.mnemonic) return false;
  try { return derivePubkeysFromMnemonic(identity.mnemonic).naturalPerson === identity.naturalPerson.publicKey; }
  catch { return false; }
}

export async function privateVaultJobs(args: {
  identity: SignetIdentity; encryptionKey: string; deviceHeldKeys: boolean;
  bunker: BunkerSigningBackend | null; isCurrent(): boolean;
}): Promise<PrivateVaultJob[]> {
  const { identity, encryptionKey, deviceHeldKeys, isCurrent } = args;
  if (!deviceHeldKeys && !hasLocalVaultTree(identity)) throw new Error('Recovery-derived vault keys are unavailable');
  const ownerPubkey = identity.naturalPerson.publicKey;
  const dependants = await db.getDependants(ownerPubkey, encryptionKey);
  const keys = (value: { naturalPerson: { publicKey: string }; persona: { publicKey: string }; extraPersonas?: { publicKey: string }[] }) =>
    [value.naturalPerson.publicKey, value.persona.publicKey, ...(value.extraPersonas ?? []).map(p => p.publicKey)];
  const forbidden = [...keys(identity), ...(identity.professionalPersona ? [identity.professionalPersona.publicKey] : []), ...dependants.flatMap(keys)];
  const resolve = (dataset: VaultDataset, rotation: number) => {
    if (!isCurrent()) return Promise.reject(new Error('Vault session changed'));
    if (deviceHeldKeys) {
      if (!args.bunker) return Promise.reject(new Error('Connect Heartwood to access private backups'));
      return args.bunker.vaultBackend(dataset, rotation, forbidden);
    }
    return Promise.resolve(localVaultBackend(identity.mnemonic, dataset, rotation));
  };
  const ownerPubkeys = async () => {
    const fresh = await db.loadIdentityDecrypted(identity.id, encryptionKey);
    if (!fresh || fresh.naturalPerson.publicKey !== ownerPubkey) throw new Error('Vault identity changed');
    const deps = await db.getDependants(ownerPubkey, encryptionKey);
    return [...keys(fresh), ...(fresh.professionalPersona ? [fresh.professionalPersona.publicKey] : []), ...deps.flatMap(keys)];
  };
  const adapters: PrivateVaultDatasetAdapter[] = [profilesVaultAdapter({ identityId: identity.id, ownerPubkey,
    encryptionKey, mnemonic: deviceHeldKeys ? null : identity.mnemonic, deviceHeldKeys, isCurrent }),
    contactsVaultAdapter('owner', encryptionKey, isCurrent), contactsVaultAdapter('bots', encryptionKey, isCurrent)];
  for (const dependant of dependants) {
    if (/^dependant-(0|[1-9][0-9]*)$/.test(dependant.derivationPath)) {
      adapters.push(contactsVaultAdapter(directoryIdForDependant(dependant), encryptionKey, isCurrent, dependant));
    }
  }
  adapters.push(credentialsVaultAdapter({ encryptionKey, ownerPubkeys, isCurrent }),
    settingsVaultAdapter(encryptionKey, isCurrent, async () => [ownerPubkey,
      ...(await db.getDependants(ownerPubkey, encryptionKey)).map(d => d.id)], {
        guardianPubkey: ownerPubkey,
        legacyGuardianPubkeys: async () => {
          const fresh = await db.loadIdentityDecrypted(identity.id, encryptionKey);
          if (!fresh || fresh.naturalPerson.publicKey !== ownerPubkey) throw new Error('Vault identity changed');
          return [fresh.id, ...keys(fresh)];
        },
      }));
  return adapters.map(adapter => ({ adapter, resolve: rotation => resolve(adapter.dataset, rotation) }));
}
