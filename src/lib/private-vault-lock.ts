import { vaultPurpose, type VaultDataset } from 'signet-protocol/experimental';
import { createSerialQueue, type SerialQueue } from './contacts-v2-queue';
const queues = new Map<string, { queue: SerialQueue; pending: number }>();
/** Serialise a whole read/merge/publish cycle, not just individual DB writes.
 * Web Locks also coordinate tabs sharing this installation's device key. The
 * process queue remains useful in non-browser consumers and older webviews. */
export async function withPrivateVaultLock<T>(owner: string, dataset: VaultDataset, task: () => Promise<T>): Promise<T> {
  if (!/^[0-9a-f]{64}$/.test(owner)) throw new Error('Invalid vault owner');
  const name = `signet:private-vault:${owner}:${vaultPurpose(dataset)}`;
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks) return locks.request(name, { mode: 'exclusive' }, task);
  let entry = queues.get(name);
  if (!entry) { entry = { queue: createSerialQueue(), pending: 0 }; queues.set(name, entry); }
  entry.pending++;
  try { return await entry.queue.run(task); }
  finally { if (--entry.pending === 0) queues.delete(name); }
}
/** Manual key rotation needs coordination across tabs, not just CAS on one row. */
export function supportsPrivateVaultRotationLock(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.locks;
}
