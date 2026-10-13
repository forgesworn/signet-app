/** Private handover, not a public key-link ceremony. New proofs, pairings and
 * credentials must be established with the independent keys. Nothing here
 * publishes a relationship between the old and new personas. */
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { ContactAction, ContactOperation, ContactRecord, ContactTier, DependantIdentity, SignetIdentity } from '../types';
import { applyOperations, validateOperation } from './contacts-v2-reducer';
import { deriveExtraPersona, importFromMnemonic } from './signet';
import { toWire } from './personas-sync';
import { directoryIdForDependant } from './contacts-v2-ids';
import { localVaultBackend, prepareVaultSnapshot, relayVaultReader } from './private-vault';
import { LocalSigningBackend } from './signing-backend';
import { flushVaultBackup, type VaultPublishIo } from './private-vault-publish';
import { loadVaultBackup, replaceVaultBackup, vaultDeviceKey } from './private-vault-store';
import { withPrivateVaultLock } from './private-vault-lock';
import { readVaultHeads, vaultContentHash, type VaultDataset } from 'signet-protocol/experimental';

export interface IndependenceContactDecision { tier: ContactTier | 'remove'; keepBlocked: boolean }
export type IndependenceReview = Record<string, IndependenceContactDecision>;
export type GuardianCopyChoice = 'archive' | 'delete';
export interface IndependenceOptions {
  removeGuardian: boolean; rotateKeys: boolean; newMnemonic?: string;
  guardianCopy?: GuardianCopyChoice; review?: IndependenceReview;
}

/** External pairings must be stopped through their existing revocation flows,
 * before this phone removes its keys. The handover does not revoke hardware. */
export function independenceTransferProblem(dep: DependantIdentity): string | null {
  if (!/^dependant-(0|[1-9][0-9]*)$/.test(dep.derivationPath)) {
    return 'Contact transfer is not available for imported identities yet. Keep their existing recovery method.';
  }
  if (dep.childDevice || dep.bunkerEndpoint?.authorizedClientPubkey || dep.appBunkerEndpoint?.pairings.length) {
    return 'Unpair their phone and connected apps before transferring their identity.';
  }
  if (dep.extraPersonas?.some(p => p.imported || !/^persona-\d+$/.test(p.derivationName))) {
    return 'Back up and remove imported personas before transferring their identity.';
  }
  return null;
}

export function independenceSourceRevision(dep: DependantIdentity, ops: ContactOperation[]): string {
  return vaultContentHash(JSON.stringify({ dependant: dep, operations: [...ops].sort((a, b) => a.operationId.localeCompare(b.operationId)) }));
}

export function buildIndependenceTransfer(args: {
  dependant: DependantIdentity; operations: ContactOperation[]; mnemonic: string;
  review: IndependenceReview; deviceId: string; now: number;
}): { identity: SignetIdentity; contacts: string; profiles: string; records: ContactRecord[] } {
  const { dependant: dep, operations, mnemonic, review, deviceId, now } = args;
  const problem = independenceTransferProblem(dep);
  if (problem) throw new Error(problem);
  if (!/^[0-9a-f]{32}$/.test(deviceId) || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid handover context');
  const source = directoryIdForDependant(dep);
  if (!operations.every(op => validateOperation(op) && op.directoryId === source)) throw new Error('Invalid source contacts');
  const records = [...applyOperations(operations).values()];
  const identity = importFromMnemonic(mnemonic, dep.persona.displayName || dep.displayName, 'persona', false);
  identity.backedUp = true;
  identity.naturalPersonActive = dep.naturalPersonActive ?? !!dep.naturalPerson.displayName;
  identity.naturalPerson.displayName = identity.naturalPersonActive ? dep.naturalPerson.displayName : '';
  identity.persona.displayNameUpdatedAt = Math.floor(now / 1000);
  const slotMap = new Map([[dep.naturalPerson.publicKey, identity.naturalPerson.publicKey], [dep.persona.publicKey, identity.persona.publicKey]]);
  identity.extraPersonas = (dep.extraPersonas ?? []).map(old => {
    const fresh = deriveExtraPersona(mnemonic, old.derivationName);
    slotMap.set(old.publicKey, fresh.publicKey);
    return { ...fresh, derivationName: old.derivationName, displayName: old.displayName, hidden: old.hidden, updatedAt: Math.floor(now / 1000) };
  });
  identity.extraPersonaTombstones = dep.extraPersonaTombstones?.map(t => ({ ...t }));
  const ops: ContactOperation[] = [];
  const id = (input: string) => bytesToHex(sha256(new TextEncoder().encode(`signet:independence:v1:${identity.id}:${input}`))).slice(0, 32);
  for (const contact of records.sort((a, b) => a.contactId.localeCompare(b.contactId))) {
    const live = contact.lifecycle !== 'removed';
    const decision = review[contact.contactId];
    if (live && (!decision || !['kin', 'kith', 'ken', 'remove'].includes(decision.tier) || typeof decision.keepBlocked !== 'boolean')) {
      throw new Error('Review every contact before transferring');
    }
    const contactId = id(`contact:${contact.contactId}`);
    const emit = (action: ContactAction, value: unknown, ownerIdentityPubkey?: string) => {
      const op: ContactOperation = { operationId: id(`operation:${ops.length}`), directoryId: 'owner', contactId,
        actorPubkey: primary!, actorRole: 'owner', actorDeviceId: deviceId,
        logicalClock: ops.length + 1, action, value, createdAt: now,
        ...(ownerIdentityPubkey ? { ownerIdentityPubkey } : {}) };
      if (!validateOperation(op)) throw new Error('A contact cannot be transferred safely');
      ops.push(op);
    };
    const primary = contact.primaryIdentityPubkey ? slotMap.get(contact.primaryIdentityPubkey) : identity.persona.publicKey;
    if (!primary) throw new Error('A contact belongs to an unknown persona');
    emit('add', { type: contact.type, displayName: contact.displayName,
      tier: live && decision.tier !== 'remove' ? decision.tier : contact.tier,
      roles: contact.roles, lifecycle: live ? contact.lifecycle : 'active', ownerIdentityPubkey: primary });
    for (const membership of contact.listMemberships ?? []) {
      if (membership.removedAt !== undefined) continue;
      const key = slotMap.get(membership.ownerIdentityPubkey);
      if (!key) throw new Error('A contact list belongs to an unknown persona');
      emit('link-list', { ownerIdentityPubkey: key });
    }
    for (const item of contact.identities) {
      // Old ECDH secrets and bond assertions cannot prove the NEW identity's
      // relationships. Keep the person/key and label, require a fresh check.
      emit('add-identity', { itemId: item.itemId, pubkey: item.pubkey, label: item.label,
        provenance: item.provenance, verification: 'unverified' });
    }
    for (const method of contact.contactMethods) {
      emit('add-method', { itemId: method.itemId, kind: method.kind, label: method.label,
        value: method.value, verification: method.verification, sharingPolicy: method.sharingPolicy });
    }
    if (contact.notes) emit('note', { note: contact.notes });
    if (contact.picture) emit('set-picture', { ...contact.picture });
    // Retain historical provenance and check records under their ORIGINAL
    // owner, never relabel an old proof as a check made with the new keys.
    for (const origin of contact.origins ?? []) emit('record-origin', { ...origin }, origin.ownerIdentityPubkey);
    for (const check of contact.checks ?? []) emit('record-check', { ...check }, check.ownerIdentityPubkey);
    if ((!live || decision.keepBlocked) && contact.blocks.some(b => !b.liftedByOperationId)) {
      for (const block of contact.blocks.filter(b => !b.liftedByOperationId)) emit('block', { scope: block.scope, reason: block.reason });
    }
    if (!live || decision.tier === 'remove') emit(contact.archived ? 'archive' : 'remove', {});
  }
  const contacts = JSON.stringify({ v: 1, directoryId: 'owner', operations: ops, grants: [] });
  const profiles = JSON.stringify({ v: 1, personas: toWire(identity), dependants: { v: 1, dependants: [] },
    persona: { publicKey: identity.persona.publicKey, displayName: identity.persona.displayName, updatedAt: identity.persona.displayNameUpdatedAt } });
  return { identity, contacts, profiles, records: [...applyOperations(ops).values()] };
}

/** Persist ciphertext before publishing. Verify real signatures and decrypt
 * readback with a fresh backend derived solely from the written-down words.
 * A transport ACK is not a handover. Every dataset must verify on one relay. */
export async function publishIndependenceMirror(args: {
  identity: SignetIdentity; contacts: string; profiles: string; encryptionKey: string;
  relays: string[]; now: number; isCurrent(): boolean;
  io?: (dataset: VaultDataset, backend: LocalSigningBackend) => VaultPublishIo;
}): Promise<void> {
  const current = () => { if (!args.isCurrent()) throw new Error('Identity locked. Unlock and retry the transfer.'); };
  const key = await vaultDeviceKey(args.identity.naturalPerson.publicKey, args.encryptionKey);
  const device = new LocalSigningBackend(key.privateKey);
  try {
    for (const [dataset, plaintext] of [['profiles', args.profiles], ['contacts:owner', args.contacts]] as const) {
      await withPrivateVaultLock(args.identity.naturalPerson.publicKey, dataset, async () => {
        current();
        const backend = localVaultBackend(args.identity.mnemonic, dataset);
        try {
          const old = await loadVaultBackup(backend.activePublicKeyHex, args.encryptionKey);
          if (old.confirmed?.revision !== vaultContentHash(plaintext) || old.pending) {
            const pending = old.pending?.manifest.revision === vaultContentHash(plaintext) ? old.pending : await prepareVaultSnapshot({
              plaintext, dataset, rotation: 0, sequence: Math.max(old.pending?.manifest.sequence ?? 0, old.confirmed?.sequence ?? 0) + 1,
              createdAt: args.now, vault: backend, device });
            current();
            await replaceVaultBackup(backend.activePublicKeyHex, args.encryptionKey, old.pending?.checkpoint.id, pending);
            const sent = await flushVaultBackup({ backend, encryptionKey: args.encryptionKey, relays: args.relays,
              now: args.now, isCurrent: args.isCurrent, io: args.io?.(dataset, backend) });
            if (sent.state !== 'verified') throw new Error('The new backup could not be restored from a relay. Your family copy is unchanged. Retry when connected.');
          }
          const state = await loadVaultBackup(backend.activePublicKeyHex, args.encryptionKey);
          // Independent recovery, with no old root, session key cache, or local
          // prepared events used as the source of readback.
          const recovery = localVaultBackend(args.identity.mnemonic, dataset);
          try {
            let verified = false;
            for (const relay of state.confirmed?.relays ?? []) {
              current();
              const restored = await readVaultHeads(args.io?.(dataset, recovery).reader(relay) ?? relayVaultReader([relay], recovery), {
                author: recovery.activePublicKeyHex, purpose: `signet:vault:${dataset}`, rotation: 0,
                sequenceFloors: { [device.activePublicKeyHex]: state.confirmed!.sequence }, now: args.now });
              if (restored.state === 'ready' && restored.snapshots.some(s => s.plaintext === plaintext && s.event.id === state.confirmed?.eventId)) { verified = true; break; }
            }
            if (!verified) throw new Error('Recovery verification failed. Your family copy is unchanged.');
          } finally { recovery.destroy(); }
          current();
        } finally { backend.destroy(); }
      });
    }
  } finally { device.destroy(); }
}
