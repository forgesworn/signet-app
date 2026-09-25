import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getDb } from './db';
import { encryptSecret, decryptSecret } from './crypto-store';
import { privateVaultQueue } from './private-vault-queue';
import type { PreparedVaultSnapshot } from './private-vault';

export interface VaultBackupState {
  pending?: PreparedVaultSnapshot;
  confirmed?: { eventId: string; revision: string; sequence: number; confirmedAt: number; relays: string[] };
}
interface StateRow { id: string; generation: number; encrypted: string }
const HEX = /^[0-9a-f]{64}$/;

/** Crypto happens outside IDB transactions. Generation compare-and-swap protects
 * another tab's pending backup or confirmation from a stale asynchronous write.
 */
export async function updateEncryptedPrivateState<T>(id: string, key: string, change: (value: T | undefined) => T | Promise<T>, beforeCommit?: () => void): Promise<T> {
  const db = await getDb();
  for (let retry = 0; retry < 8; retry++) {
    const old: StateRow | undefined = await db.get('privateVaultState', id);
    const previous = old ? JSON.parse(await decryptSecret(old.encrypted, key)) as T : undefined;
    const value = await change(previous);
    if (previous !== undefined && value === previous) return value;
    const encrypted = await encryptSecret(JSON.stringify(value), key);
    const tx = db.transaction('privateVaultState', 'readwrite');
    const current: StateRow | undefined = await tx.store.get(id);
    if (current?.generation !== old?.generation) {
      await tx.done;
      continue;
    }
    const generation = (old?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) { await tx.done; throw new Error('Vault storage generation overflow'); }
    // Consent writes can invalidate while encryption or the IDB read is pending.
    // This synchronous guard runs at the write boundary, inside the transaction.
    try { beforeCommit?.(); } catch (error) { tx.abort(); await tx.done.catch(() => {}); throw error; }
    await tx.store.put({ id, generation, encrypted });
    await tx.done;
    return value;
  }
  throw new Error('Private backup changed concurrently; retry');
}

function vaultId(author: string): string {
  if (!HEX.test(author)) throw new Error('Invalid vault author');
  return `vault:${author}`;
}

export async function loadVaultBackup(author: string, key: string): Promise<VaultBackupState> {
  const row: StateRow | undefined = await (await getDb()).get('privateVaultState', vaultId(author));
  if (!row) return {};
  const value: unknown = JSON.parse(await decryptSecret(row.encrypted, key));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid private backup state');
  return value as VaultBackupState;
}

export function queueVaultBackup(author: string, key: string, pending: PreparedVaultSnapshot): Promise<VaultBackupState> {
  if (pending.checkpoint.pubkey !== author) return Promise.reject(new Error('Wrong vault backup author'));
  return privateVaultQueue.run(() => updateEncryptedPrivateState<VaultBackupState>(vaultId(author), key, old => {
    // Never replace an unsent snapshot implicitly; the caller must drain it first.
    if (old?.pending && old.pending.checkpoint.id !== pending.checkpoint.id) throw new Error('A private backup is already pending');
    return { ...old, pending };
  }));
}

/** Confirm only the pending event actually read back; never clear a newer outbox. */
export function confirmVaultBackup(author: string, key: string, eventId: string, confirmedAt: number, relays: string[]): Promise<VaultBackupState> {
  return privateVaultQueue.run(() => updateEncryptedPrivateState<VaultBackupState>(vaultId(author), key, old => {
    if (!old?.pending || old.pending.checkpoint.id !== eventId) throw new Error('Private backup changed before confirmation');
    const { revision, sequence } = old.pending.manifest;
    return { confirmed: { eventId, revision, sequence, confirmedAt, relays: [...new Set(relays)] } };
  }));
}

/** Random per-installation signer, encrypted at rest and never backed up. */
export function vaultDeviceKey(ownerPubkey: string, key: string): Promise<{ privateKey: string; publicKey: string }> {
  if (!HEX.test(ownerPubkey)) return Promise.reject(new Error('Invalid backup owner'));
  return privateVaultQueue.run(() => updateEncryptedPrivateState<{ privateKey: string; publicKey: string }>(`device:${ownerPubkey}`, key, old => {
    if (old) {
      if (!HEX.test(old.privateKey)) throw new Error('Invalid backup device key');
      const secret = hexToBytes(old.privateKey);
      try {
        if (getPublicKey(secret) !== old.publicKey) throw new Error('Invalid backup device key');
      } finally { secret.fill(0); }
      return old;
    }
    const secret = generateSecretKey();
    try { return { privateKey: bytesToHex(secret), publicKey: getPublicKey(secret) }; }
    finally { secret.fill(0); }
  }));
}

/** Replace only after the caller has merged remote state and re-read local data. */
export function replaceVaultBackup(author: string, key: string, expectedPendingId: string | undefined,
  pending: PreparedVaultSnapshot): Promise<VaultBackupState> {
  if (pending.checkpoint.pubkey !== author) return Promise.reject(new Error('Wrong vault backup author'));
  return privateVaultQueue.run(() => updateEncryptedPrivateState<VaultBackupState>(vaultId(author), key, old => {
    if (old?.pending?.checkpoint.id !== expectedPendingId) throw new Error('Private backup changed concurrently');
    return { ...old, pending };
  }));
}
