import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { vaultPurpose, type VaultDataset } from 'signet-protocol/experimental';
import { getDb } from './db';
import { decryptSecret } from './crypto-store';
import { updateEncryptedPrivateState } from './private-vault-store';
import { privateVaultQueue } from './private-vault-queue';
import type { PreparedVaultSnapshot } from './private-vault';

export interface VaultRotationIntent {
  id: string;
  from: number;
  to: number;
  startedAt: number;
  phase: 'preparing' | 'forwarding' | 'complete' | 'cancelled';
  /** Keep the authorised signed copy until the handover is verified. A relay
   * losing it during a crash/offline interval must not require fresh signing. */
  target?: PreparedVaultSnapshot;
}
function rowId(owner: string, dataset: VaultDataset): string {
  if (!/^[0-9a-f]{64}$/.test(owner)) throw new Error('Invalid vault owner');
  return `rotation:${owner}:${vaultPurpose(dataset)}`;
}
function valid(value: VaultRotationIntent): VaultRotationIntent {
  if (!value || !/^[0-9a-f]{32}$/.test(value.id) || !Number.isSafeInteger(value.from) || value.from < 0
    || value.to !== value.from + 1 || value.to > 0xffff_ffff || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0
    || !['preparing', 'forwarding', 'complete', 'cancelled'].includes(value.phase)) throw new Error('Invalid vault rotation state');
  if (value.target && (value.target.manifest.rotation !== value.to || value.target.manifest.nextRotation !== undefined
    || !/^[0-9a-f]{64}$/.test(value.target.checkpoint.id) || !Array.isArray(value.target.chunks))) throw new Error('Invalid rotation copy');
  return value;
}
export async function loadVaultRotation(owner: string, dataset: VaultDataset, key: string): Promise<VaultRotationIntent | null> {
  const row = await (await getDb()).get('privateVaultState', rowId(owner, dataset));
  return row ? valid(JSON.parse(await decryptSecret(row.encrypted, key))) : null;
}
export function beginVaultRotation(owner: string, dataset: VaultDataset, key: string, from: number, now: number): Promise<VaultRotationIntent> {
  const next = valid({ id: bytesToHex(randomBytes(16)), from, to: from + 1, startedAt: now, phase: 'preparing' });
  return privateVaultQueue.run(() => updateEncryptedPrivateState<VaultRotationIntent>(rowId(owner, dataset), key, old => {
    if (old && !['complete', 'cancelled'].includes(valid(old).phase)) return old;
    return next;
  }));
}
export function advanceVaultRotation(owner: string, dataset: VaultDataset, key: string, id: string,
  update: { phase?: VaultRotationIntent['phase']; target?: PreparedVaultSnapshot }): Promise<VaultRotationIntent> {
  return privateVaultQueue.run(() => updateEncryptedPrivateState<VaultRotationIntent>(rowId(owner, dataset), key, old => {
    if (!old || valid(old).id !== id) throw new Error('Vault rotation changed');
    if (old.phase === 'complete' || old.phase === 'cancelled') return old;
    if (old.phase === 'forwarding' && (update.phase === 'preparing' || update.phase === 'cancelled')) throw new Error('Published rotation must finish');
    const next = valid({ ...old, ...update });
    if (next.phase === 'complete' || next.phase === 'cancelled') delete next.target;
    return next;
  }));
}

interface VaultRotationHighWaterMark { rotation: number }
function highWaterRowId(owner: string, dataset: VaultDataset): string {
  if (!/^[0-9a-f]{64}$/.test(owner)) throw new Error('Invalid vault owner');
  // Deliberately a different id than `rowId`: this mark must survive a
  // rotation intent reaching `complete`/`cancelled`, and a fresh
  // `beginVaultRotation` overwriting that row.
  return `rotation-seen:${owner}:${vaultPurpose(dataset)}`;
}
function validHighWater(value: VaultRotationHighWaterMark): VaultRotationHighWaterMark {
  if (!value || !Number.isSafeInteger(value.rotation) || value.rotation < 0 || value.rotation > 0xffff_ffff) {
    throw new Error('Invalid vault rotation high-water mark');
  }
  return value;
}
/** The highest rotation this device has ever confirmed by reading an
 * authentic checkpoint there. Independent of, and never cleared by, this
 * device's own rotation intent — a device that only ever learns of a
 * rotation by reading it (never initiating one itself) still needs a floor
 * against a later relay withholding that rotation. 0 when never recorded. */
export async function loadSeenVaultRotation(owner: string, dataset: VaultDataset, key: string): Promise<number> {
  const row = await (await getDb()).get('privateVaultState', highWaterRowId(owner, dataset));
  return row ? validHighWater(JSON.parse(await decryptSecret(row.encrypted, key))).rotation : 0;
}
/** Monotonic: never lowers the stored mark, whatever `rotation` is. */
export function markVaultRotationSeen(owner: string, dataset: VaultDataset, key: string, rotation: number): Promise<number> {
  if (!Number.isSafeInteger(rotation) || rotation < 0 || rotation > 0xffff_ffff) throw new Error('Invalid vault rotation high-water mark');
  return privateVaultQueue.run(() => updateEncryptedPrivateState<VaultRotationHighWaterMark>(highWaterRowId(owner, dataset), key, old => {
    const previous = old ? validHighWater(old).rotation : 0;
    return { rotation: Math.max(previous, rotation) };
  })).then(v => v.rotation);
}
