import { fromMnemonic, derivePersona } from 'nsec-tree';
import { wrapNsec, unwrapNsec } from 'nsec-tree/wrapped';
import { encodeNpub } from 'nsec-tree/encoding';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getPublicKey } from 'nostr-tools/pure';

export type BackupOwner = {mnemonic: string; naturalPerson: {publicKey: string}};
export type ImportedBackupSlot = {privateKey: string; publicKey: string; imported?: boolean; heartwoodKey?: boolean};

/** Only an owner's verified local mnemonic root; never a remote/dependant fallback. */
export function ownerRoot(owner: BackupOwner) {
  if (!owner.mnemonic) throw new Error('This needs your local Signet recovery words. Hardware backup is not available here.');
  const root = fromMnemonic(owner.mnemonic);
  try {
    const np = derivePersona(root, 'natural-person');
    try {
      if (bytesToHex(np.identity.publicKey) !== owner.naturalPerson.publicKey.toLowerCase()) {
        throw new Error('The local recovery words do not match this Signet.');
      }
    } finally { np.identity.privateKey.fill(0); }
    return root;
  } catch (error) { root.destroy(); throw error; }
}

export async function createWrappedPersonaBackup(owner: BackupOwner, slot: ImportedBackupSlot): Promise<string> {
  if (!slot.imported || slot.heartwoodKey || !/^[0-9a-f]{64}$/i.test(slot.privateKey)) {
    throw new Error('Only an imported key held on this device can use this backup.');
  }
  const root = ownerRoot(owner);
  const raw = hexToBytes(slot.privateKey);
  try {
    if (getPublicKey(raw) !== slot.publicKey.toLowerCase()) throw new Error('The imported key does not match its account.');
    const record = await wrapNsec(root, raw);
    // Verify the actual generated record before offering it for download.
    const checked = await unwrapNsec(root, record, encodeNpub(hexToBytes(slot.publicKey)));
    checked.privateKey.fill(0);
    return record;
  } finally { raw.fill(0); root.destroy(); }
}

export async function restoreWrappedPersonaBackup(owner: BackupOwner, record: string, expectedNpub?: string) {
  const root = ownerRoot(owner);
  try { return await unwrapNsec(root, record, expectedNpub); }
  finally { root.destroy(); }
}

/** Read-back of a user-selected file: authentication and exact-account check. */
export async function verifyWrappedPersonaBackup(owner: BackupOwner, publicKey: string, record: string): Promise<string> {
  const root = ownerRoot(owner);
  try {
    const restored = await unwrapNsec(root, record, encodeNpub(hexToBytes(publicKey)));
    try { return restored.npub; } finally { restored.privateKey.fill(0); }
  } finally { root.destroy(); }
}
