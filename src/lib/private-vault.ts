/** Dedicated-key vault transport. Legacy rails remain separate and readable. */
import { bytesToHex } from '@noble/hashes/utils.js';
import { zeroise, verifyEvent } from 'signet-protocol';
import type { NostrEvent } from 'signet-protocol';
import { vaultIdentityFromMnemonic, vaultPurpose, vaultCheckpointTag, vaultContentHash,
  readVaultSnapshot, parseVaultCheckpoint, MAX_VAULT_CHUNKS, MAX_VAULT_CONTROL_BYTES,
  VAULT_EVENT_KIND, createVaultRelayReader } from 'signet-protocol/experimental';
import type { VaultDataset, VaultReader, VaultCheckpoint } from 'signet-protocol/experimental';
import { LocalSigningBackend } from './signing-backend';
import type { DecryptingSigningBackend } from './signing-backend';
import { sealVaultPayload, openVaultPayload } from './vault-envelope';

export function localVaultBackend(mnemonic: string, dataset: VaultDataset, rotation = 0): LocalSigningBackend {
  const child = vaultIdentityFromMnemonic(mnemonic, dataset, rotation);
  try { return new LocalSigningBackend(bytesToHex(child.privateKey)); }
  finally { zeroise(child); }
}

/** Bounded, code-point-safe pieces: never split a UTF-8 character between chunks. */
export function splitVaultPlaintext(plaintext: string, maxBytes: number): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4 || maxBytes > 65532) throw new Error('Invalid vault chunk size');
  if (new TextEncoder().encode(plaintext).length > maxBytes * MAX_VAULT_CHUNKS) throw new Error('Vault exceeds chunk limit');
  const parts: string[] = [];
  let chars: string[] = [], bytes = 0;
  for (const char of plaintext) {
    const length = new TextEncoder().encode(char).length;
    if (bytes + length > maxBytes) { parts.push(chars.join('')); chars = []; bytes = 0; }
    chars.push(char); bytes += length;
  }
  parts.push(chars.join(''));
  if (parts.length > MAX_VAULT_CHUNKS) throw new Error('Vault exceeds chunk limit');
  return parts;
}

export interface PreparedVaultSnapshot { checkpoint: NostrEvent; chunks: NostrEvent[]; manifest: VaultCheckpoint }

/** Preparation has no relay writes. All chunks must publish before the checkpoint. */
export async function prepareVaultSnapshot(args: {
  plaintext: string; dataset: VaultDataset; rotation: number; sequence: number; createdAt: number;
  vault: DecryptingSigningBackend; device: DecryptingSigningBackend; maxBucket?: number; nextRotation?: number;
}): Promise<PreparedVaultSnapshot> {
  const { plaintext, vault, device } = args;
  if (args.nextRotation !== undefined && (!Number.isSafeInteger(args.nextRotation)
    || args.nextRotation <= args.rotation || args.nextRotation > 0xffff_ffff)) throw new Error('Invalid next vault rotation');
  if (vault.activePublicKeyHex === device.activePublicKeyHex) throw new Error('Vault and device keys must differ');
  const maxBucket = args.maxBucket ?? 65536;
  if (![4096, 8192, 16384, 32768, 65536].includes(maxBucket)) throw new Error('Invalid vault padding bucket');
  const parts = splitVaultPlaintext(plaintext, maxBucket - 4);
  const chunks: NostrEvent[] = [];
  for (const part of parts) {
    const content = await sealVaultPayload(part, vault, { maxBucket });
    if (!content) throw new Error('Could not encrypt vault chunk');
    const event = await device.signEvent({ kind: VAULT_EVENT_KIND, pubkey: device.activePublicKeyHex,
      created_at: args.createdAt, tags: [['d', vaultContentHash(content)]], content });
    if (event.pubkey !== device.activePublicKeyHex || !await verifyEvent(event)) throw new Error('Invalid device signature');
    chunks.push(event);
  }
  const manifest: VaultCheckpoint = { v: 1, purpose: vaultPurpose(args.dataset), rotation: args.rotation,
    sequence: args.sequence, publisher: device.activePublicKeyHex, revision: vaultContentHash(plaintext), devicePubkeys: [device.activePublicKeyHex],
    ...(args.nextRotation === undefined ? {} : { nextRotation: args.nextRotation }),
    chunks: chunks.map(e => ({ eventId: e.id, author: e.pubkey, contentHash: vaultContentHash(e.content),
      contentBytes: new TextEncoder().encode(e.content).length })) };
  const raw = JSON.stringify(manifest);
  if (!parseVaultCheckpoint(raw, manifest)) throw new Error('Invalid vault checkpoint');
  const content = await sealVaultPayload(raw, vault, { maxBucket: 8192 });
  if (!content || new TextEncoder().encode(content).length > MAX_VAULT_CONTROL_BYTES) throw new Error('Vault checkpoint exceeds signer limit');
  const checkpoint = await vault.signEvent({ kind: VAULT_EVENT_KIND, pubkey: vault.activePublicKeyHex,
    created_at: args.createdAt, tags: [['d', vaultCheckpointTag(vault.activePublicKeyHex, device.activePublicKeyHex)]], content });
  if (checkpoint.pubkey !== vault.activePublicKeyHex || !await verifyEvent(checkpoint)) throw new Error('Invalid vault signature');
  return { checkpoint, chunks, manifest };
}

export function relayVaultReader(relays: readonly string[], backend: DecryptingSigningBackend): VaultReader {
  return createVaultRelayReader(relays, (content, author) =>
    openVaultPayload(content, backend, author, { legacyFallback: false }));
}
export { fetchVaultEvents } from 'signet-protocol/experimental';

export { readVaultSnapshot };
