import { readVaultHeadRotations, readVaultHeads, vaultPurpose, type VaultDataset, type VaultReader } from 'signet-protocol/experimental';
import type { DecryptingSigningBackend } from './signing-backend';
import { relayVaultReader, type PreparedVaultSnapshot } from './private-vault';
import { loadVaultBackup } from './private-vault-store';
import { flushVaultBackup } from './private-vault-publish';

export interface ForwardOptions {
  backend: DecryptingSigningBackend; dataset: VaultDataset; from: number; to: number;
  key: string; relays: { read: string[]; write: string[] }; devicePubkey: string;
  resolve(rotation: number): Promise<DecryptingSigningBackend>; isCurrent(): boolean; now: number;
}
/** Whether rotation `to` is complete and is exactly what recovery reads now
 * (the newest rotation). Once true, rotation `from` is never read again, so
 * its pointer is optional and ordinary sync writes to `to`. */
export async function checkVaultDestination(options: ForwardOptions): Promise<boolean> {
  const owned = new Map<number, DecryptingSigningBackend>();
  try {
    if (!options.isCurrent()) return false;
    const destination = await readVaultHeadRotations(async rotation => {
      if (!options.isCurrent()) throw new Error('Vault session changed');
      let backend = rotation === options.from ? options.backend : owned.get(rotation);
      if (!backend) {
        backend = await options.resolve(rotation);
        if (backend.activePublicKeyHex === options.backend.activePublicKeyHex) { backend.destroy(); throw new Error('Rotation keys must differ'); }
        owned.set(rotation, backend);
      }
      const saved = await loadVaultBackup(backend.activePublicKeyHex, options.key);
      return { author: backend.activePublicKeyHex, reader: relayVaultReader(options.relays.read, backend),
        sequenceFloors: { [options.devicePubkey]: saved.confirmed?.sequence ?? 0 } };
    }, vaultPurpose(options.dataset), options.now);
    return options.isCurrent() && destination.state === 'ready'
      && destination.snapshots.every(snapshot => snapshot.checkpoint.rotation === options.to);
  } catch { return false; }
  finally { for (const backend of owned.values()) backend.destroy(); }
}

/** Validate a pointer before publishing it. Rotation n + 1 is the revocation
 * boundary: once any authentic checkpoint exists there, recovery reads only the
 * newest rotation and never rotation n. So the pointer in rotation n is
 * published LAST, and only when (a) the destination rotation `to` is complete
 * and is exactly what recovery reads now, and (b) the candidate would be the
 * winning head for its tag in rotation `from` (a newer head would hide it).
 * The shared reader applies signature checks, rollback floors, hop/head counts,
 * clock bounds and byte limits. */
export async function checkVaultForwarding(options: ForwardOptions, candidate: PreparedVaultSnapshot): Promise<boolean> {
  if (!Number.isSafeInteger(options.from) || options.from < 0 || options.to !== options.from + 1
    || candidate.manifest.rotation !== options.from || candidate.manifest.nextRotation !== options.to
    || candidate.checkpoint.pubkey !== options.backend.activePublicKeyHex) return false;
  try {
    if (!options.isCurrent()) return false;
    const purpose = vaultPurpose(options.dataset);
    const floorsFor = async (backend: DecryptingSigningBackend) =>
      ({ [options.devicePubkey]: (await loadVaultBackup(backend.activePublicKeyHex, options.key)).confirmed?.sequence ?? 0 });
    // (a) The destination must already be complete: recovery must read it,
    // and nothing later, as the newest rotation.
    if (!await checkVaultDestination(options)) return false;
    // (b) The candidate, overlaid on the source rotation, must win its head.
    const remote = relayVaultReader(options.relays.read, options.backend);
    const reader: VaultReader = {
      ...remote,
      checkpoints: async (author, tag) => [...await remote.checkpoints(author, tag), candidate.checkpoint],
      chunk: async id => candidate.chunks.find(chunk => chunk.id === id) ?? remote.chunk(id),
    };
    const source = await readVaultHeads(reader, { author: options.backend.activePublicKeyHex, purpose,
      rotation: options.from, sequenceFloors: await floorsFor(options.backend), now: options.now });
    return options.isCurrent() && source.state === 'ready'
      && source.snapshots.some(snapshot => snapshot.event.id === candidate.checkpoint.id && snapshot.checkpoint.nextRotation === options.to);
  } catch { return false; }
}

/** Resume an already signed, durable pointer. Caller holds the dataset job lock.
 * Normal sync must not overwrite this outbox with an ordinary checkpoint. */
export async function resumeVaultForwarding(options: ForwardOptions): Promise<boolean> {
  try {
    const saved = await loadVaultBackup(options.backend.activePublicKeyHex, options.key);
    if (!saved.pending || !await checkVaultForwarding(options, saved.pending)) return false;
    if (!options.isCurrent()) return false;
    const result = await flushVaultBackup({ backend: options.backend, encryptionKey: options.key,
      relays: options.relays.write, now: options.now, isCurrent: options.isCurrent });
    return options.isCurrent() && result.state === 'verified';
  } catch { return false; }
}
