import { botRegistrySnapshot, loadBotRegistry, mergeBotRegistry, parseBotRegistry, updateBotRegistry } from './bot-registry';
import { deriveExtraPersonaPubkey } from './signet';
import type { PrivateVaultDatasetAdapter } from './private-vault-sync';
import * as db from './db';
import { toWire, parsePayload as parsePersonas, mergePersonas } from './personas-sync';
import { toSyncWire, parsePayload as parseDependants, fromSyncWire, mergeDependantWithLocal } from './dependants-sync';
import { applyRemotePersonasPatch } from './apply-remote-personas';
import { isNaturalPersonActive } from './identity-display';
import { deriveProfessionalPersona } from './professional/pro-persona';
import { sanitizeDisplayName } from './text-sanitize';
import { contactsMutationQueue } from './contacts-v2-queue';

export function profilesVaultAdapter(args: {
  identityId: string; ownerPubkey: string; encryptionKey: string; mnemonic: string | null;
  deviceHeldKeys: boolean; isCurrent(): boolean;
}): PrivateVaultDatasetAdapter {
  const current = () => { if (!args.isCurrent()) throw new Error('Vault session changed'); };
  const identity = async () => {
    const value = await db.loadIdentityDecrypted(args.identityId, args.encryptionKey);
    if (!value || value.naturalPerson.publicKey !== args.ownerPubkey) throw new Error('Private backup identity changed');
    current();
    return value;
  };
  return {
    dataset: 'profiles',
    snapshot: () => contactsMutationQueue.run(async () => {
      const local = await identity();
      const dependants = await db.getDependants(args.ownerPubkey, args.encryptionKey);
      const wires = dependants.map(toSyncWire).filter((d): d is NonNullable<typeof d> => d !== null).sort((a, b) => a.id.localeCompare(b.id));
      const bots = botRegistrySnapshot(await loadBotRegistry(args.ownerPubkey, args.encryptionKey));
      current();
      return JSON.stringify({ v: 1, bots, personas: toWire(local), dependants: { v: 1, dependants: wires },
        persona: { publicKey: local.persona.publicKey, displayName: local.persona.displayName,
          updatedAt: local.persona.displayNameUpdatedAt ?? 0 } });
    }),
    merge: (raw, createdAt) => contactsMutationQueue.run(async () => {
      current();
      const value = JSON.parse(raw);
      if (!value || value.v !== 1 || !value.personas || !value.dependants) throw new Error('Invalid profiles vault');
      const personas = parsePersonas(JSON.stringify(value.personas));
      const dependants = parseDependants(JSON.stringify(value.dependants));
      if (!personas || !dependants || dependants.length !== value.dependants.dependants?.length
        || personas.personas.length !== value.personas.personas?.length
        || dependants.some(d => d.guardianPubkey !== args.ownerPubkey)) throw new Error('Invalid profiles data');
      const bots = value.bots === undefined ? undefined : parseBotRegistry(JSON.stringify(value.bots), args.ownerPubkey);
      if (bots) {
        if (bots.bots.some(bot => bot.privateKey !== undefined)) throw new Error('Profiles cannot import bot signing keys');
        if (args.mnemonic && bots.bots.some(bot => bot.source === 'derived'
          && deriveExtraPersonaPubkey(args.mnemonic!, bot.derivationName!) !== bot.publicKey)) throw new Error('Bot does not match the recovery tree');
        mergeBotRegistry(await loadBotRegistry(args.ownerPubkey, args.encryptionKey), bots);
      }
      const local = await identity();
      const merged = mergePersonas({ local: local.extraPersonas ?? [], localTombstones: local.extraPersonaTombstones ?? [],
        localRecordAt: 0, remote: personas, remoteCreatedAt: createdAt, mnemonic: args.mnemonic,
        deviceHeldKeys: args.deviceHeldKeys, localNaturalPersonActive: isNaturalPersonActive(local),
        localNaturalPersonDisplayName: local.naturalPerson.displayName });
      if (merged.skipped.length) throw new Error('Some private personas could not be restored');
      let professionalSlot = local.professionalPersona;
      if (personas.professional && !professionalSlot) {
        if (args.mnemonic) {
          const derived = deriveProfessionalPersona(args.mnemonic);
          if (derived.publicKey !== personas.professional.publicKey) throw new Error('Professional identity does not match the recovery tree');
          professionalSlot = derived;
        } else if (args.deviceHeldKeys) {
          professionalSlot = { publicKey: personas.professional.publicKey, privateKey: '', displayName: '' };
        }
      }
      const pro = personas.professional;
      let updated = applyRemotePersonasPatch(local, { extraPersonas: merged.extraPersonas, tombstones: merged.tombstones,
        naturalPersonActive: merged.naturalPersonActive || undefined, naturalPersonDisplayName: merged.naturalPersonDisplayName,
        professionalSlot, professional: pro && pro.updatedAt > (local.professionalPersona?.updatedAt ?? -1)
          ? { displayName: pro.displayName, updatedAt: pro.updatedAt } : undefined });
      if (value.persona) {
        const p = value.persona;
        if (p.publicKey !== local.persona.publicKey || typeof p.displayName !== 'string' || p.displayName.length > 200
          || !Number.isSafeInteger(p.updatedAt) || p.updatedAt < 0) throw new Error('Invalid default persona backup');
        if (p.updatedAt > (local.persona.displayNameUpdatedAt ?? -1)) {
          updated = { ...updated, persona: { ...updated.persona, displayName: sanitizeDisplayName(p.displayName, 200), displayNameUpdatedAt: p.updatedAt } };
        }
      }
      const restored = dependants.map(wire => fromSyncWire(wire, args.mnemonic ?? '', { deviceHeldKeys: args.deviceHeldKeys }));
      if (restored.some(d => !d)) throw new Error('Some dependants could not be restored');
      current();
      await db.saveIdentityEncrypted(updated, args.encryptionKey);
      if (bots) await updateBotRegistry(args.ownerPubkey, args.encryptionKey, localBots => {
        current(); return mergeBotRegistry(localBots, bots);
      });
      for (const dep of restored) {
        current();
        const existing = (await db.getDependants(args.ownerPubkey, args.encryptionKey)).find(d => d.id === dep!.id);
        if (existing && existing.createdAt > dep!.createdAt) continue;
        await db.saveDependant(mergeDependantWithLocal(dep!, existing ?? null), args.encryptionKey);
      }
    }),
  };
}
