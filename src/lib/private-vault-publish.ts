import { readVaultSnapshot } from 'signet-protocol/experimental';
import type { VaultReader } from 'signet-protocol/experimental';
import type { NostrEvent } from 'signet-protocol';
import type { DecryptingSigningBackend } from './signing-backend';
import { relayVaultReader } from './private-vault';
import { publishToRelays } from './sync-relays';
import { loadVaultBackup, confirmVaultBackup } from './private-vault-store';
import { isValidRelayUrl } from './relay-url';

export interface VaultPublishIo {
  publish(event: NostrEvent, relay: string): Promise<boolean>;
  reader(relay: string): VaultReader;
}

/** Drain the already-persisted outbox. Failure leaves it intact for retry.
 * A relay ACK is insufficient: at least one individual relay must return the
 * exact checkpoint and all chunks, decryptable with the current vault key.
 */
export async function flushVaultBackup(args: {
  backend: DecryptingSigningBackend; encryptionKey: string; relays: string[]; now: number; io?: VaultPublishIo; isCurrent?: () => boolean;
}): Promise<{ state: 'idle' | 'pending' | 'verified'; confirmedRelays: string[] }> {
  const current = () => args.isCurrent?.() ?? true;
  const author = args.backend.activePublicKeyHex;
  const state = await loadVaultBackup(author, args.encryptionKey);
  const pending = state.pending;
  if (!pending) return { state: 'idle', confirmedRelays: state.confirmed?.relays ?? [] };
  const io = args.io ?? {
    publish: (event: NostrEvent, relay: string) => publishToRelays(event, [relay]),
    reader: (relay: string) => relayVaultReader([relay], args.backend),
  };
  const expected = { author, purpose: pending.manifest.purpose, rotation: pending.manifest.rotation, publisher: pending.manifest.publisher,
    minSequence: Math.max(state.confirmed?.sequence ?? 0, pending.manifest.sequence), now: args.now };
  // Validate the encrypted stored candidate before sending anything, including
  // corruption introduced by an interrupted or incompatible local migration.
  const localReader = relayVaultReader([], args.backend);
  const local = await readVaultSnapshot({ ...localReader,
    checkpoints: async () => [pending.checkpoint],
    chunk: async id => pending.chunks.find(c => c.id === id) ?? null,
  }, expected);
  if (local.state !== 'ready' || local.checkpoint.revision !== pending.manifest.revision) {
    return { state: 'pending', confirmedRelays: [] };
  }
  const confirmedRelays: string[] = [];
  for (const relay of [...new Set(args.relays.filter(isValidRelayUrl))].slice(0, 8)) {
    try {
      let complete = true;
      for (const chunk of pending.chunks) {
        if (!current()) return { state: 'pending', confirmedRelays: [] };
        if (!await io.publish(chunk, relay)) { complete = false; break; }
      }
      if (!current()) return { state: 'pending', confirmedRelays: [] };
      if (!complete || !await io.publish(pending.checkpoint, relay)) continue;
      const restored = await readVaultSnapshot(io.reader(relay), expected);
      if (restored.state === 'ready' && restored.event.id === pending.checkpoint.id
        && restored.checkpoint.revision === pending.manifest.revision) confirmedRelays.push(relay);
    } catch { /* Durable outbox remains; another relay may succeed. */ }
  }
  if (!current()) return { state: 'pending', confirmedRelays: [] };
  if (!confirmedRelays.length) return { state: 'pending', confirmedRelays };
  await confirmVaultBackup(author, args.encryptionKey, pending.checkpoint.id, args.now, confirmedRelays);
  return { state: 'verified', confirmedRelays };
}
