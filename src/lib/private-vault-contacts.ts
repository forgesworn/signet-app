import { loadContactInviteVault, parseContactInviteVault, restoreContactInviteVault } from './contact-invite-store';
import type { VaultDataset } from 'signet-protocol/experimental';
import type { PrivateVaultDatasetAdapter } from './private-vault-sync';
import type { ContactOperation } from '../types';
import * as db from './db';
import { directoryIdForDependant } from './contacts-v2-ids';
import { contactsMutationQueue } from './contacts-v2-queue';
import { validateOperation } from './contacts-v2-reducer';
import { mergeOps } from './contacts-v2-clock';
import { MAX_CHECKPOINT_OPS } from './contacts-v2-sync';
import { toWireGrant, parseGrantsPayload, mergeGrantRegistry } from './contacts-v2-grants-rail';

/** One directory per vault; never serialize the whole family contact log here. */
export function contactsVaultAdapter(directoryId: string, encryptionKey: string, isCurrent: () => boolean,
  dependant?: { id: string; derivationPath: string }): PrivateVaultDatasetAdapter {
  let dataset: VaultDataset;
  if (directoryId === 'owner') dataset = 'contacts:owner';
  else if (directoryId === 'bots') dataset = 'contacts:bots';
  else {
    const match = /^dependant-(0|[1-9][0-9]*)$/.exec(dependant?.derivationPath ?? '');
    if (!dependant || directoryIdForDependant(dependant) !== directoryId || !match || Number(match[1]) > 0xffffffff) throw new Error('Invalid contacts vault directory');
    dataset = { dependant: Number(match[1]) };
  }
  const current = () => { if (!isCurrent()) throw new Error('Vault session changed'); };
  return {
    dataset,
    snapshot: () => contactsMutationQueue.run(async () => {
      current();
      const { ops: operations } = mergeOps([], await db.listContactOperationsV2(directoryId, encryptionKey));
      if (operations.length > MAX_CHECKPOINT_OPS) throw new Error('Contacts exceed backup limit');
      const grants = (await db.listContactGrantsV2ForDirectory(directoryId, encryptionKey))
        .map(toWireGrant).sort((a, b) => a.grantId.localeCompare(b.grantId));
      current();
      const invites = directoryId === 'bots' ? undefined : await loadContactInviteVault(directoryId, encryptionKey);
      return JSON.stringify({ v: 1, directoryId, operations, grants, invites });
    }),
    merge: (plaintext, createdAt) => contactsMutationQueue.run(async () => {
      current();
      const value = JSON.parse(plaintext);
      if (!value || value.v !== 1 || value.directoryId !== directoryId || !Array.isArray(value.operations)
        || value.operations.length > MAX_CHECKPOINT_OPS || !Array.isArray(value.grants)) throw new Error('Invalid contacts vault');
      if (!value.operations.every((op: unknown) => validateOperation(op) && (op as ContactOperation).directoryId === directoryId)) {
        throw new Error('Invalid contact operation in vault');
      }
      if (directoryId === 'bots' && (value.grants.length || value.invites !== undefined)) throw new Error('Bot grant and invite restore is not supported');
      const parsed = parseGrantsPayload(JSON.stringify({ v: 2, kind: 'grants', createdAt, grants: value.grants }));
      if (!parsed || parsed.grants.length !== value.grants.length || parsed.grants.some(g => g.directoryId !== directoryId)) {
        throw new Error('Invalid contact grant in vault');
      }
      if (value.invites !== undefined) await parseContactInviteVault(JSON.stringify(value.invites), directoryId);
      const allOps = await db.listAllContactOperationsV2(encryptionKey);
      const byId = new Map(allOps.map(op => [op.operationId, op]));
      if (value.operations.some((op: ContactOperation) => byId.has(op.operationId) && byId.get(op.operationId)!.directoryId !== directoryId)) {
        throw new Error('Contact operation belongs to another vault');
      }
      const allGrants = await db.listContactGrantsV2(encryptionKey);
      if (parsed.grants.some(g => allGrants.some(local => local.grantId === g.grantId && local.directoryId !== directoryId))) {
        throw new Error('Contact grant belongs to another vault');
      }
      const merged = mergeGrantRegistry(allGrants.filter(g => g.directoryId === directoryId), parsed.grants);
      if (merged.skippedRemote) throw new Error('Contact grant registry exceeds limit');
      current();
      const newOps = (value.operations as ContactOperation[]).filter(op => !byId.has(op.operationId));
      if (value.invites !== undefined) await restoreContactInviteVault(directoryId, encryptionKey, JSON.stringify(value.invites));
      await db.saveContactOperationsV2(newOps, encryptionKey);
      for (const grant of merged.grants) {
        current();
        await db.saveContactGrantV2(grant, encryptionKey);
      }
    }),
  };
}
