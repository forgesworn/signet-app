/** A bounded inventory of existing nstw1 records inside the shared FSWNENC2 envelope. */
import {derive, zeroise} from 'nsec-tree';
import {wrapNsec, unwrapNsec, type UnwrappedNsec} from 'nsec-tree/wrapped';
import {encodeNpub} from 'nsec-tree/encoding';
import {hexToBytes, bytesToHex} from '@noble/hashes/utils.js';
import {sha256} from '@noble/hashes/sha2.js';
import {getPublicKey} from 'nostr-tools/pure';
import {seal as sealV3Frame, open as openV3Frame} from './vendor/stash/frame';
import {ownerRoot, type BackupOwner, type ImportedBackupSlot} from './wrapped-persona-backup';

export const COLLECTION_BYTES = 65_608;
export const MAX_COLLECTION_ACCOUNTS = 100;
const PURPOSE = 'signet/wrapped-account-collection/v1';
const TYPE = 'signet.wrapped-accounts';
const enc = new TextEncoder();
interface Entry {name: string; npub: string; record: string}
interface Inventory {type: typeof TYPE; version: 1; createdAt: number; accounts: Entry[]}
export interface CollectionAccount {name: string; npub: string}
export interface CollectionInspection {createdAt: number; accounts: CollectionAccount[]; sha256: string}
export type RestoredCollectionAccount = UnwrappedNsec & {name: string};

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && enc.encode(value).length <= 100
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function shape(value: unknown, keys: string): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
}
function parseInventory(bytes: Uint8Array): Inventory {
  const v: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  if (!shape(v, 'type,version,createdAt,accounts') || v.type !== TYPE || v.version !== 1
    || !Number.isSafeInteger(v.createdAt) || Number(v.createdAt) < 0 || !Array.isArray(v.accounts)
    || !v.accounts.length || v.accounts.length > MAX_COLLECTION_ACCOUNTS) throw new Error('Invalid account inventory.');
  const npubs = new Set<string>();
  for (const entry of v.accounts) {
    if (!shape(entry, 'name,npub,record') || !validName(entry.name) || typeof entry.npub !== 'string'
      || typeof entry.record !== 'string' || entry.record.length !== 181 || npubs.has(entry.npub)) {
      throw new Error('Invalid or duplicate account in collection.');
    }
    npubs.add(entry.npub);
  }
  return v as unknown as Inventory;
}
export function isAccountCollection(bytes: Uint8Array): boolean {
  return bytes.length === COLLECTION_BYTES && new TextDecoder().decode(bytes.subarray(0, 8)) === 'FSWNENC2';
}

/** No uploads. Every supplied account must be a matching, locally held imported key. */
export async function createAccountCollection(owner: BackupOwner, slots: readonly (ImportedBackupSlot & {displayName: string})[]): Promise<Uint8Array> {
  if (!slots.length || slots.length > MAX_COLLECTION_ACCOUNTS) throw new Error('Choose 1–100 imported accounts.');
  const snapshot = slots.map(s => ({...s}));
  const root = ownerRoot(owner);
  let storageKey: ReturnType<typeof derive> | undefined;
  let body: Uint8Array | undefined;
  try {
    storageKey = derive(root, PURPOSE, 0);
    const accounts: Entry[] = [];
    const seen = new Set<string>();
    for (const slot of snapshot) {
      if (!slot.imported || slot.heartwoodKey || !/^[0-9a-f]{64}$/i.test(slot.privateKey) || !validName(slot.displayName)) {
        throw new Error('Only named, locally held imported accounts can be backed up.');
      }
      const raw = hexToBytes(slot.privateKey);
      try {
        const publicKey = getPublicKey(raw);
        if (publicKey !== slot.publicKey.toLowerCase()) throw new Error('An imported key does not match its account.');
        const npub = encodeNpub(hexToBytes(publicKey));
        if (seen.has(npub)) throw new Error('Duplicate account in collection.');
        seen.add(npub);
        accounts.push({name: slot.displayName, npub, record: await wrapNsec(root, raw)});
      } finally { raw.fill(0); }
    }
    body = enc.encode(JSON.stringify({type: TYPE, version: 1, createdAt: Date.now(), accounts} satisfies Inventory));
    const file = await sealV3Frame(storageKey.privateKey, 'signet-accounts.json', 'application/json', body);
    if (!isAccountCollection(file)) throw new Error('Account collection is too large.');
    // Do not offer a download until the exact output has authenticated and every key has checked.
    await inspectAccountCollection(owner, file);
    return file;
  } finally { body?.fill(0); if (storageKey) zeroise(storageKey); root.destroy(); }
}

async function openCollection(owner: BackupOwner, file: Uint8Array, selected?: readonly string[]) {
  if (!isAccountCollection(file)) throw new Error('Invalid account collection file.');
  const bytes = file.slice();
  const root = ownerRoot(owner);
  let storageKey: ReturnType<typeof derive> | undefined;
  let body: Uint8Array | undefined;
  const restored: RestoredCollectionAccount[] = [];
  try {
    storageKey = derive(root, PURPOSE, 0);
    const opened = await openV3Frame(storageKey.privateKey, bytes);
    body = opened.bytes;
    if (opened.meta.name !== 'signet-accounts.json' || opened.meta.type !== 'application/json') throw new Error('Wrong collection type.');
    const inventory = parseInventory(body);
    const wanted = selected === undefined ? undefined : new Set(selected);
    if (wanted && (!wanted.size || wanted.size !== selected!.length
      || [...wanted].some(npub => !inventory.accounts.some(a => a.npub === npub)))) throw new Error('Invalid account selection.');
    // Validate ALL records, including unselected ones, before returning any key or inventory.
    for (const account of inventory.accounts) {
      const key = await unwrapNsec(root, account.record, account.npub);
      if (wanted?.has(account.npub)) restored.push({...key, name: account.name});
      else key.privateKey.fill(0);
    }
    return {restored, inspection: {createdAt: inventory.createdAt,
      accounts: inventory.accounts.map(({name, npub}) => ({name, npub})), sha256: bytesToHex(sha256(bytes))}};
  } catch (error) { restored.forEach(a => a.privateKey.fill(0)); throw error; }
  finally { body?.fill(0); if (storageKey) zeroise(storageKey); root.destroy(); }
}

/** Authenticates the complete inventory and all records, returning public metadata only. */
export async function inspectAccountCollection(owner: BackupOwner, file: Uint8Array): Promise<CollectionInspection> {
  return (await openCollection(owner, file)).inspection;
}
/** Caller must zeroise every returned privateKey after persistence or cancellation. */
export async function restoreAccountCollection(owner: BackupOwner, file: Uint8Array, selectedNpubs: readonly string[]): Promise<RestoredCollectionAccount[]> {
  return (await openCollection(owner, file, [...selectedNpubs])).restored;
}
