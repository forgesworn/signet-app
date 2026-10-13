import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { ContactOperation, ContactRecord, DependantIdentity } from '../types';
import { getDb, getDependants, listContactOperationsV2, listContactPictures } from './db';
import { encryptSecret, decryptSecret } from './crypto-store';
import { updateEncryptedPrivateState } from './private-vault-store';
import { generateMnemonic } from './signet';
import { directoryIdForDependant } from './contacts-v2-ids';
import { applyOperations } from './contacts-v2-reducer';
import { contactsMutationQueue } from './contacts-v2-queue';
import type { GuardianCopyChoice } from './independence-transfer';

export const independenceDirectoryMarker = (directoryId: string) => `independence:closed:${directoryId}`;
const draftId = (dependantId: string) => `independence:draft:${dependantId}`;
export interface IndependenceClosure {
  directoryId: string; guardianPubkey: string; dependantId: string; derivationPath: string;
  displayName: string; completedAt: number; choice: GuardianCopyChoice;
  slotPubkeys?: string[];
}
export interface IndependenceArchive extends IndependenceClosure { contacts?: ContactRecord[] }
export interface IndependenceSource { dependant: DependantIdentity; operations: ContactOperation[]; fingerprint: string }

export function validIndependenceClosure(value: unknown): value is IndependenceClosure {
  if (!value || typeof value !== 'object') return false;
  const v = value as IndependenceClosure;
  return /^[0-9a-f]{64}$/.test(v.dependantId) && /^[0-9a-f]{64}$/.test(v.guardianPubkey)
    && v.directoryId === `dependant:${v.dependantId}` && typeof v.derivationPath === 'string' && v.derivationPath.length <= 100
    && typeof v.displayName === 'string' && v.displayName.length <= 100
    && Number.isSafeInteger(v.completedAt) && v.completedAt >= 0 && ['archive', 'delete'].includes(v.choice)
    && (v.slotPubkeys === undefined || (Array.isArray(v.slotPubkeys) && v.slotPubkeys.length <= 202 && v.slotPubkeys.every(k => /^[0-9a-f]{64}$/.test(k))));
}

/** One encrypted draft per dependant. Reload/retry reuses the same independent
 * words; successful cutover deletes the draft including all new key material. */
export async function independenceDraftWords(dependantId: string, key: string, isCurrent: () => boolean): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(dependantId)) throw new Error('Invalid dependant');
  if (!isCurrent()) throw new Error('Unlock to prepare recovery words');
  const db = await getDb();
  if (await db.get('privateVaultState', independenceDirectoryMarker(`dependant:${dependantId}`))) throw new Error('This handover is already complete');
  const draft = await updateEncryptedPrivateState<{ mnemonic: string }>(draftId(dependantId), key,
    old => old ?? { mnemonic: generateMnemonic() }, () => { if (!isCurrent()) throw new Error('Identity locked'); });
  if (!isCurrent()) throw new Error('Identity locked');
  return draft.mnemonic;
}

async function rawSource(dependantId: string) {
  const db = await getDb();
  const tx = db.transaction(['identity', 'contactOpsV2', 'contactGrantsV2', 'contactPictures', 'privateVaultState'], 'readonly');
  const directory = `dependant:${dependantId}`;
  const identity = await tx.objectStore('identity').get(`dependant:${dependantId}`);
  const operations = await tx.objectStore('contactOpsV2').index('directoryId').getAll(directory);
  const grants = await tx.objectStore('contactGrantsV2').index('by-directory').getAll(directory);
  const invite = await tx.objectStore('privateVaultState').get(`contact-invites:${directory}`);
  const pictures = (await tx.objectStore('contactPictures').getAll()).filter(p => p.id.startsWith(`own:${directory}:`));
  await tx.done;
  const fingerprint = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify({ identity,
    operations: operations.sort((a, b) => a.operationId.localeCompare(b.operationId)), grants, invite, pictures }))));
  return { fingerprint, operations, pictures };
}

/** The normal log reader tolerates unreadable rows. A one-way handover must
 * refuse them, or it could declare a truncated directory completely moved. */
export async function readIndependenceSource(guardian: string, dependantId: string, key: string): Promise<IndependenceSource> {
  const before = await rawSource(dependantId);
  const dependant = (await getDependants(guardian, key)).find(d => d.id === dependantId);
  if (!dependant) throw new Error('Dependant unavailable');
  const operations = await listContactOperationsV2(directoryIdForDependant(dependant), key);
  if (operations.length !== before.operations.length) throw new Error('Some contacts could not be read. The handover has been stopped.');
  const after = await rawSource(dependantId);
  if (before.fingerprint !== after.fingerprint) throw new Error('Family data changed. Review the contacts again.');
  const records = [...applyOperations(operations).values()];
  const pictures = await listContactPictures(key);
  const ownPictures = pictures.filter(p => p.id.startsWith(`own:dependant:${dependantId}:`));
  if (ownPictures.length !== before.pictures.length) throw new Error('Some saved contact pictures could not be read. The handover has been stopped.');
  for (const picture of ownPictures) {
    const contact = records.find(c => picture.id === `own:${c.directoryId}:${c.contactId}`);
    if (contact && contact.lifecycle !== 'removed' && (!contact.picture || contact.picture.plainHash !== picture.plainHash)) {
      throw new Error('Back up their saved contact pictures before transferring. A local picture is not in the recovery backup yet.');
    }
  }
  return { dependant, operations, fingerprint: after.fingerprint };
}

export async function listIndependenceArchives(guardian: string, key: string): Promise<IndependenceArchive[]> {
  const rows = await (await getDb()).getAll('privateVaultState');
  const out: IndependenceArchive[] = [];
  for (const row of rows) {
    if (!row.id.startsWith('independence:closed:')) continue;
    const value: unknown = JSON.parse(await decryptSecret(row.encrypted, key));
    if (!validIndependenceClosure(value)) throw new Error('Invalid independence history');
    if (value.guardianPubkey === guardian) out.push(value);
  }
  return out.sort((a, b) => b.completedAt - a.completedAt);
}

export function closureMetadata(value: IndependenceArchive): IndependenceClosure {
  const { directoryId, guardianPubkey, dependantId, derivationPath, displayName, completedAt, choice, slotPubkeys } = value;
  return { directoryId, guardianPubkey, dependantId, derivationPath, displayName, completedAt, choice, ...(slotPubkeys ? { slotPubkeys } : {}) };
}

/** Cutover marker, identity removal, grant removal and source deletion commit
 * together. The marker freezes the source even against in-flight tab writers.
 * Only encrypted archives survive, outside the writable contact directory. */
export async function closeIndependenceSource(args: {
  closure: IndependenceClosure; key: string; expectedFingerprint?: string; isCurrent(): boolean;
}): Promise<void> {
  if (!validIndependenceClosure(args.closure)) throw new Error('Invalid independence closure');
  await contactsMutationQueue.run(async () => {
    const db = await getDb();
    if (await db.get('privateVaultState', independenceDirectoryMarker(args.closure.directoryId))) return;
    const source = await rawSource(args.closure.dependantId);
    if (args.expectedFingerprint !== undefined && source.fingerprint !== args.expectedFingerprint) throw new Error('Family data changed. Review and retry the transfer.');
    const operations = await listContactOperationsV2(args.closure.directoryId, args.key);
    if (operations.length !== source.operations.length) throw new Error('Some contacts could not be archived');
    const archive: IndependenceArchive = { ...args.closure,
      ...(args.closure.choice === 'archive' ? { contacts: [...applyOperations(operations).values()] } : {}) };
    const encrypted = await encryptSecret(JSON.stringify(archive), args.key);
    const tx = db.transaction(['identity', 'contacts', 'ken', 'contactOpsV2', 'contactRecordsV2', 'contactGrantsV2', 'contactPictures', 'privateVaultState'], 'readwrite');
    try {
      const identity = await tx.objectStore('identity').get(`dependant:${args.closure.dependantId}`);
      const ops = await tx.objectStore('contactOpsV2').index('directoryId').getAll(args.closure.directoryId);
      const grants = await tx.objectStore('contactGrantsV2').index('by-directory').getAll(args.closure.directoryId);
      const invite = await tx.objectStore('privateVaultState').get(`contact-invites:${args.closure.directoryId}`);
      const pictures = (await tx.objectStore('contactPictures').getAll()).filter(p => p.id.startsWith(`own:${args.closure.directoryId}:`));
      const fingerprint = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify({ identity,
        operations: ops.sort((a, b) => a.operationId.localeCompare(b.operationId)), grants, invite, pictures }))));
      if (!args.isCurrent() || fingerprint !== source.fingerprint) throw new Error('Family data changed or locked. Retry the transfer.');
      if (await tx.objectStore('privateVaultState').get(independenceDirectoryMarker(args.closure.directoryId))) { await tx.done; return; }
      await tx.objectStore('privateVaultState').put({ id: independenceDirectoryMarker(args.closure.directoryId), generation: 1, encrypted });
      const slots = new Set<string>([args.closure.dependantId, ...(args.closure.slotPubkeys ?? []),
        ...[identity?.naturalPerson, identity?.persona, ...(identity?.extraPersonas ?? [])].flatMap(slot => slot?.publicKey ? [slot.publicKey] : [])]);
      // Legacy sync must not re-import the relinquished child's contacts into
      // quarantine, or rewrite them after this one-way door has committed.
      for (const slot of slots) {
        await tx.objectStore('privateVaultState').put({ id: `independence:slot:${slot}`, generation: 1, encrypted });
        for (const contact of await tx.objectStore('contacts').index('ownerPubkey').getAll(slot)) await tx.objectStore('contacts').delete(contact.pubkey);
        for (const ken of await tx.objectStore('ken').index('ownerPubkey').getAll(slot)) await tx.objectStore('ken').delete(ken.pubkey);
      }
      for (const op of ops) await tx.objectStore('contactOpsV2').delete(op.operationId);
      for (const record of await tx.objectStore('contactRecordsV2').index('directoryId').getAll(args.closure.directoryId)) {
        await tx.objectStore('contactRecordsV2').delete([record.directoryId, record.contactId]);
      }
      for (const grant of grants) await tx.objectStore('contactGrantsV2').delete(grant.grantId);
      for (const picture of await tx.objectStore('contactPictures').getAll()) {
        if (picture.id.startsWith(`own:${args.closure.directoryId}:`)) await tx.objectStore('contactPictures').delete(picture.id);
      }
      await tx.objectStore('identity').delete(`dependant:${args.closure.dependantId}`);
      await tx.objectStore('privateVaultState').delete(draftId(args.closure.dependantId));
      await tx.objectStore('privateVaultState').delete(`contact-invites:${args.closure.directoryId}`);
      await tx.done;
    } catch (error) { tx.abort(); await tx.done.catch(() => {}); throw error; }
  });
}

export const newIndependenceDeviceId = () => bytesToHex(randomBytes(16));
