import { runPrivateVaultRotation, type PrivateVaultRotationResult } from './private-vault-rotation';
import { loadVaultRotation, advanceVaultRotation, loadSeenVaultRotation, markVaultRotationSeen, type VaultRotationIntent } from './private-vault-rotation-store';
import { checkVaultDestination, resumeVaultForwarding } from './private-vault-forward';

/** Best-effort pointer publication: bounded exponential backoff per signed
 * pointer, re-attempted on later syncs, never a gate once the destination is
 * complete. In-memory only; a reload simply retries sooner. */
const FORWARD_RETRY_BASE_SECONDS = 60, FORWARD_RETRY_MAX_SECONDS = 6 * 3600, FORWARD_RETRY_ENTRIES = 64;
const forwardRetries = new Map<string, { attempts: number; nextAt: number }>();
function forwardRetryDue(key: string, now: number): boolean { return (forwardRetries.get(key)?.nextAt ?? 0) <= now; }
function noteForwardFailure(key: string, now: number): void {
  const attempts = (forwardRetries.get(key)?.attempts ?? 0) + 1;
  forwardRetries.delete(key);
  if (forwardRetries.size >= FORWARD_RETRY_ENTRIES) forwardRetries.delete(forwardRetries.keys().next().value!);
  forwardRetries.set(key, { attempts, nextAt: now + Math.min(FORWARD_RETRY_BASE_SECONDS * 2 ** (attempts - 1), FORWARD_RETRY_MAX_SECONDS) });
}
import { withPrivateVaultLock, supportsPrivateVaultRotationLock } from './private-vault-lock';
import { readVaultHeadRotations, vaultPurpose, vaultContentHash } from 'signet-protocol/experimental';
import type { VaultDataset } from 'signet-protocol/experimental';
import type { DecryptingSigningBackend } from './signing-backend';
import { prepareVaultSnapshot, relayVaultReader } from './private-vault';
import { loadVaultBackup, replaceVaultBackup, vaultDeviceKey } from './private-vault-store';
import { flushVaultBackup } from './private-vault-publish';
import { LocalSigningBackend } from './signing-backend';

export interface PrivateVaultDatasetAdapter {
  dataset: VaultDataset;
  /** Validate the complete remote schema, merge durably, or throw. Never replace blindly. */
  merge(plaintext: string, createdAt: number): Promise<void>;
  /** Read current durable state, including any edits made during merge/signing. */
  snapshot(): Promise<string>;
}
export type PrivateVaultSyncResult = {
  state: 'verified' | 'pending' | 'waiting-legacy' | 'unavailable' | 'unusable' | 'cancelled';
  canonical?: boolean;
  rotation?: number;
  rotationPending?: number;
  merged?: boolean;
  confirmedAt?: number;
  confirmedRelays?: string[];
};

/** One bounded sync cycle. Scheduling and UI stay with the caller. */
export type PrivateVaultSyncOptions = {
  adapter: PrivateVaultDatasetAdapter; ownerPubkey: string; encryptionKey: string;
  relays: { read: string[]; write: string[] };
  resolve(rotation: number): Promise<DecryptingSigningBackend>;
  isCurrent(): boolean;
  now: number;
  allowInitialPublish?: boolean;
};
export async function syncPrivateVaultDataset(args: PrivateVaultSyncOptions): Promise<PrivateVaultSyncResult> {
  try {
    return await withPrivateVaultLock(args.ownerPubkey, args.adapter.dataset, async () => {
      const result = await syncPrivateVaultDatasetLocked(args);
      if (args.isCurrent()) {
        const intent = await loadVaultRotation(args.ownerPubkey, args.adapter.dataset, args.encryptionKey);
        if (intent && !['complete', 'cancelled'].includes(intent.phase)) {
          if (result.state === 'verified' && result.rotation !== undefined && result.rotation >= intent.to) {
            if (args.isCurrent()) await advanceVaultRotation(args.ownerPubkey, args.adapter.dataset, args.encryptionKey, intent.id, { phase: 'complete' });
          } else result.rotationPending = intent.to;
        }
      }
      return result;
    });
  } catch { return { state: args.isCurrent() ? 'unavailable' : 'cancelled' }; }
}
/** Explicit user action only; normal sync never starts a new key rotation. */
export async function rotatePrivateVaultDataset(args: PrivateVaultSyncOptions): Promise<PrivateVaultRotationResult> {
  if (!supportsPrivateVaultRotationLock()) throw new Error('This browser cannot coordinate private key rotation across tabs.');
  return withPrivateVaultLock(args.ownerPubkey, args.adapter.dataset, () => runPrivateVaultRotation(args, syncPrivateVaultDatasetLocked));
}
/** The rotation this device has already reached, from its own recorded
 * rotation intent: `to` once a rotation is confirmed `complete`, otherwise
 * `from` (the device has not yet proven it can read the newer rotation).
 * No recorded intent means the device has never rotated: 0. */
function recordedVaultRotation(intent: VaultRotationIntent | null): number {
  if (!intent) return 0;
  return intent.phase === 'complete' ? intent.to : intent.from;
}
/** Caller holds the installation-wide dataset lock. */
async function syncPrivateVaultDatasetLocked(args: PrivateVaultSyncOptions): Promise<PrivateVaultSyncResult> {
  let canonical = false;
  let merged = false;
  const backends = new Map<number, DecryptingSigningBackend>();
  const current = () => { if (!args.isCurrent()) throw new Error('Vault session changed'); };
  try {
    current();
    const deviceKey = await vaultDeviceKey(args.ownerPubkey, args.encryptionKey);
    const intent = await loadVaultRotation(args.ownerPubkey, args.adapter.dataset, args.encryptionKey);
    const seenRotation = await loadSeenVaultRotation(args.ownerPubkey, args.adapter.dataset, args.encryptionKey);
    current();
    // The high-water mark is independent of `intent`: it also catches a
    // rotation this device only ever learned about by reading it (never
    // initiated locally), which a rotation intent alone cannot record.
    const minRotation = Math.max(seenRotation, recordedVaultRotation(intent));
    const restored = await readVaultHeadRotations(async rotation => {
      current();
      const backend = await args.resolve(rotation);
      backends.set(rotation, backend);
      let state = await loadVaultBackup(backend.activePublicKeyHex, args.encryptionKey);
      canonical ||= !!state.confirmed;
      const next = state.pending?.manifest.nextRotation;
      if (next !== undefined && state.pending) {
        const forwarding = { backend, dataset: args.adapter.dataset, from: rotation, to: next,
          key: args.encryptionKey, relays: args.relays, devicePubkey: deviceKey.publicKey,
          resolve: args.resolve, isCurrent: args.isCurrent, now: args.now };
        const retryKey = `${backend.activePublicKeyHex}:${state.pending.checkpoint.id}`;
        const due = forwardRetryDue(retryKey, args.now);
        const resumed = due && await resumeVaultForwarding(forwarding);
        current();
        if (resumed) {
          forwardRetries.delete(retryKey);
          state = await loadVaultBackup(backend.activePublicKeyHex, args.encryptionKey);
          canonical ||= !!state.confirmed;
        } else {
          if (due) noteForwardFailure(retryKey, args.now);
          // The pointer is optional once rotation `next` is complete and newest:
          // recovery never reads this rotation again and sync writes to `next`,
          // so the signed pointer outbox here cannot be overwritten. Before
          // that, writing to this rotation could race the pointer: wait.
          if (!await checkVaultDestination(forwarding)) throw new Error('Vault rotation is waiting for its verified destination');
          current();
        }
      }
      return { author: backend.activePublicKeyHex, reader: relayVaultReader(args.relays.read, backend),
        sequenceFloors: { [deviceKey.publicKey]: state.confirmed?.sequence ?? 0 } };
    }, vaultPurpose(args.adapter.dataset), args.now, minRotation);
    current();
    if (restored.state === 'unavailable' || restored.state === 'unusable') return { state: restored.state, canonical };
    canonical ||= restored.state === 'ready';
    if (restored.state === 'absent' && args.allowInitialPublish === false) return { state: 'waiting-legacy', canonical };
    const rotation = restored.state === 'ready' ? Math.max(...restored.snapshots.map(s => s.checkpoint.rotation)) : 0;
    // Record the mark as soon as a rotation is proven authentic and newest,
    // regardless of what happens later in this cycle (a merge or publish
    // failure below must not un-teach this device a rotation it has verified).
    if (restored.state === 'ready') {
      await markVaultRotationSeen(args.ownerPubkey, args.adapter.dataset, args.encryptionKey, rotation);
      current();
    }
    const snapshots = restored.state === 'ready' ? restored.snapshots : [];
    const maxSequence = Math.max(0, ...snapshots.filter(s => s.checkpoint.rotation === rotation).map(s => s.checkpoint.sequence));
    const maxCreatedAt = Math.max(0, ...snapshots.map(s => s.event.created_at));
    const backend = backends.get(rotation)!;
    const before = await loadVaultBackup(backend.activePublicKeyHex, args.encryptionKey);
    current();
    if (restored.state === 'absent' && before.confirmed) return { state: 'unusable', canonical };
    const priorPlaintext = snapshots.length ? await args.adapter.snapshot() : undefined;
    for (const snapshot of snapshots) {
      try { await args.adapter.merge(snapshot.plaintext, snapshot.event.created_at); }
      catch { return { state: args.isCurrent() ? 'unusable' : 'cancelled', canonical }; }
      current();
    }
    const plaintext = await args.adapter.snapshot();
    current();
    merged = priorPlaintext !== undefined && priorPlaintext !== plaintext;
    const revision = vaultContentHash(plaintext);
    if (!before.pending && before.confirmed?.revision === revision && snapshots.some(s => s.checkpoint.revision === revision)) {
      return { state: 'verified', canonical: true, merged, rotation,
        confirmedAt: before.confirmed?.confirmedAt, confirmedRelays: before.confirmed?.relays };
    }
    if (!before.pending || before.pending.manifest.revision !== revision
      || maxSequence >= before.pending.manifest.sequence) {
      current();
      const device = new LocalSigningBackend(deviceKey.privateKey);
      try {
        const sequence = Math.max(before.confirmed?.sequence ?? 0, before.pending?.manifest.sequence ?? 0,
          maxSequence) + 1;
        const prepared = await prepareVaultSnapshot({ plaintext, dataset: args.adapter.dataset, rotation, sequence,
          createdAt: Math.max(args.now, maxCreatedAt + 1), vault: backend, device });
        current();
        await replaceVaultBackup(backend.activePublicKeyHex, args.encryptionKey, before.pending?.checkpoint.id, prepared);
      } finally { device.destroy(); }
    }
    current();
    const result = await flushVaultBackup({ backend, encryptionKey: args.encryptionKey,
      relays: args.relays.write, now: args.now, isCurrent: args.isCurrent });
    current();
    return { state: result.state === 'verified' ? 'verified' : 'pending', canonical: canonical || result.state === 'verified', merged, rotation,
      ...(result.state === 'verified' ? { confirmedAt: args.now, confirmedRelays: result.confirmedRelays } : {}) };
  } catch {
    return { state: args.isCurrent() ? 'unavailable' : 'cancelled', canonical, merged };
  } finally {
    for (const backend of backends.values()) backend.destroy?.();
  }
}
