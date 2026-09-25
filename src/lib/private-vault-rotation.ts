import { readVaultHeads, vaultContentHash, vaultPurpose } from 'signet-protocol/experimental';
import type { PrivateVaultSyncOptions, PrivateVaultSyncResult } from './private-vault-sync';
import { beginVaultRotation, advanceVaultRotation, loadVaultRotation, type VaultRotationIntent } from './private-vault-rotation-store';
import { loadVaultBackup, replaceVaultBackup, vaultDeviceKey } from './private-vault-store';
import { prepareVaultSnapshot, relayVaultReader } from './private-vault';
import { flushVaultBackup } from './private-vault-publish';
import { checkVaultForwarding, resumeVaultForwarding } from './private-vault-forward';
import { LocalSigningBackend, type DecryptingSigningBackend } from './signing-backend';

export type PrivateVaultRotationResult = { state: 'complete' | 'pending' | 'unusable' | 'cancelled'; rotation?: number };
/** Called only after explicit user authentication and under the dataset lock.
 * Preparing/re-signing a copy is never an automatic retry: only an already signed
 * forward outbox can be resumed by ordinary sync. */
export async function runPrivateVaultRotation(args: PrivateVaultSyncOptions,
  baseline: (args: PrivateVaultSyncOptions) => Promise<PrivateVaultSyncResult>): Promise<PrivateVaultRotationResult> {
  const { ownerPubkey: owner, adapter, encryptionKey: key } = args;
  let source: DecryptingSigningBackend | undefined, target: DecryptingSigningBackend | undefined, device: LocalSigningBackend | undefined;
  let intent: VaultRotationIntent | null = null;
  const current = () => { if (!args.isCurrent()) throw new Error('Vault session changed'); };
  const pending = (): PrivateVaultRotationResult => ({ state: args.isCurrent() ? 'pending' : 'cancelled', rotation: intent?.to });
  const finish = async (): Promise<PrivateVaultRotationResult> => {
    current();
    await advanceVaultRotation(owner, adapter.dataset, key, intent!.id, { phase: 'complete' });
    return { state: 'complete', rotation: intent!.to };
  };
  try {
    current();
    intent = await loadVaultRotation(owner, adapter.dataset, key);
    if (intent && ['complete', 'cancelled'].includes(intent.phase)) intent = null;
    const deviceKey = await vaultDeviceKey(owner, key);
    device = new LocalSigningBackend(deviceKey.privateKey);
    // A once-verified destination may have vanished while the source pointer
    // was queued. Replay the retained, authorised signed copy before resuming.
    if (intent?.target) {
      target = await args.resolve(intent.to); current();
      const saved = await loadVaultBackup(target.activePublicKeyHex, key);
      const known = await readVaultHeads(relayVaultReader(args.relays.read, target), {
        author: target.activePublicKeyHex, purpose: vaultPurpose(adapter.dataset), rotation: intent.to, now: args.now,
        sequenceFloors: { [deviceKey.publicKey]: saved.confirmed?.sequence ?? 0 },
      });
      if (known.state !== 'ready') {
        if ((saved.confirmed?.sequence ?? 0) > intent.target.manifest.sequence
          || (saved.pending && saved.pending.checkpoint.id !== intent.target.checkpoint.id)) return { state: 'unusable', rotation: intent.to };
        current();
        await replaceVaultBackup(target.activePublicKeyHex, key, saved.pending?.checkpoint.id, intent.target);
        const repaired = await flushVaultBackup({ backend: target, encryptionKey: key, relays: args.relays.write, now: args.now, isCurrent: args.isCurrent });
        if (repaired.state !== 'verified') return pending();
      }
      target.destroy(); target = undefined;
    }
    const before = await baseline(args); current();
    if (before.state !== 'verified') return { state: before.state === 'unusable' ? 'unusable' : 'pending', rotation: intent?.to };
    if (intent && before.rotation !== undefined && before.rotation >= intent.to) return finish();
    intent ??= await beginVaultRotation(owner, adapter.dataset, key, before.rotation ?? 0, args.now);
    if ((before.rotation ?? 0) !== intent.from) return { state: 'unusable', rotation: intent.to };
    source = await args.resolve(intent.from); target = await args.resolve(intent.to); current();
    if (source.activePublicKeyHex === target.activePublicKeyHex) return { state: 'unusable', rotation: intent.to };
    let savedTarget = await loadVaultBackup(target.activePublicKeyHex, key);
    if (savedTarget.pending?.manifest.nextRotation !== undefined) return { state: 'unusable', rotation: intent.to };
    if (savedTarget.pending) {
      // Previous attempt may have published only some chunks. Finish that copy
      // before reading/merging its checkpoint, then capture current local edits.
      const drained = await flushVaultBackup({ backend: target, encryptionKey: key, relays: args.relays.write, now: args.now, isCurrent: args.isCurrent });
      if (drained.state !== 'verified') return pending();
      savedTarget = await loadVaultBackup(target.activePublicKeyHex, key);
    }
    const destination = await readVaultHeads(relayVaultReader(args.relays.read, target), {
      author: target.activePublicKeyHex, purpose: vaultPurpose(adapter.dataset), rotation: intent.to, now: args.now,
      sequenceFloors: { [deviceKey.publicKey]: savedTarget.confirmed?.sequence ?? 0 },
    });
    current();
    if (destination.state === 'unavailable') return pending();
    if (destination.state === 'unusable' || (destination.state === 'absent' && savedTarget.confirmed)) return { state: 'unusable', rotation: intent.to };
    const targetSnapshots = destination.state === 'ready' ? destination.snapshots : [];
    // Never overwrite an independently prepared later chain with a plain head.
    if (targetSnapshots.some(snapshot => snapshot.checkpoint.nextRotation !== undefined)) return { state: 'unusable', rotation: intent.to };
    for (const snapshot of targetSnapshots) { await adapter.merge(snapshot.plaintext, snapshot.event.created_at); current(); }
    // Any orphan destination data must also be recoverable through the old key
    // before attempting the handover. This baseline is verified first.
    const refreshed = await baseline(args); current();
    if (refreshed.state !== 'verified') return pending();
    if (refreshed.rotation !== undefined && refreshed.rotation >= intent.to) return finish();
    const plaintext = await adapter.snapshot(), revision = vaultContentHash(plaintext); current();
    savedTarget = await loadVaultBackup(target.activePublicKeyHex, key);
    const preparedTarget = intent.target?.manifest.revision === revision
      && intent.target.manifest.publisher === deviceKey.publicKey
      && intent.target.manifest.sequence >= (savedTarget.confirmed?.sequence ?? 0)
      && targetSnapshots.every(snapshot => snapshot.checkpoint.publisher !== deviceKey.publicKey
        || snapshot.event.id === intent!.target!.checkpoint.id
        || (snapshot.event.created_at < intent!.target!.checkpoint.created_at && snapshot.checkpoint.sequence <= intent!.target!.manifest.sequence))
      ? intent.target : await prepareVaultSnapshot({ plaintext, dataset: adapter.dataset, rotation: intent.to,
        sequence: Math.max(savedTarget.confirmed?.sequence ?? 0, savedTarget.pending?.manifest.sequence ?? 0,
          ...targetSnapshots.map(snapshot => snapshot.checkpoint.sequence), 0) + 1,
        createdAt: Math.max(args.now, ...targetSnapshots.map(snapshot => snapshot.event.created_at + 1), (savedTarget.pending?.checkpoint.created_at ?? 0) + 1),
        vault: target, device });
    current();
    intent = await advanceVaultRotation(owner, adapter.dataset, key, intent.id, { target: preparedTarget });
    current();
    await replaceVaultBackup(target.activePublicKeyHex, key, savedTarget.pending?.checkpoint.id, preparedTarget);
    const uploaded = await flushVaultBackup({ backend: target, encryptionKey: key, relays: args.relays.write, now: args.now, isCurrent: args.isCurrent });
    if (uploaded.state !== 'verified') return pending();
    current();
    const oldHeads = await readVaultHeads(relayVaultReader(args.relays.read, source), {
      author: source.activePublicKeyHex, purpose: vaultPurpose(adapter.dataset), rotation: intent.from, now: args.now,
    });
    if (oldHeads.state !== 'ready') return pending();
    if (oldHeads.snapshots.some(snapshot => (snapshot.checkpoint.nextRotation ?? intent!.from) >= intent!.to)) {
      const followed = await baseline(args); current();
      return followed.state === 'verified' && (followed.rotation ?? 0) >= intent.to ? finish() : pending();
    }
    current();
    const old = await loadVaultBackup(source.activePublicKeyHex, key);
    current();
    if (old.pending) return pending();
    const forward = await prepareVaultSnapshot({ plaintext, dataset: adapter.dataset, rotation: intent.from, nextRotation: intent.to,
      sequence: Math.max(old.confirmed?.sequence ?? 0, ...oldHeads.snapshots.map(snapshot => snapshot.checkpoint.sequence)) + 1,
      createdAt: Math.max(args.now, ...oldHeads.snapshots.map(snapshot => snapshot.event.created_at + 1)), vault: source, device });
    current();
    const forwarding = { backend: source, dataset: adapter.dataset, from: intent.from, to: intent.to, key,
      relays: args.relays, devicePubkey: deviceKey.publicKey, resolve: args.resolve, isCurrent: args.isCurrent, now: args.now };
    if (!await checkVaultForwarding(forwarding, forward)) return { state: 'unusable', rotation: intent.to };
    current();
    intent = await advanceVaultRotation(owner, adapter.dataset, key, intent.id, { phase: 'forwarding' });
    current();
    await replaceVaultBackup(source.activePublicKeyHex, key, undefined, forward);
    if (!await resumeVaultForwarding(forwarding)) return pending();
    return finish();
  } catch { return pending(); }
  finally { source?.destroy(); target?.destroy(); device?.destroy(); }
}
