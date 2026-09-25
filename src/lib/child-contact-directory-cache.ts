import { getDb } from './db';
import { decryptSecret, encryptSecret } from './crypto-store';
import type { PairedChildRecord } from '../types';
import { mergeChildContactDirectory, parseChildContactDirectory, type ChildContactDirectory } from './child-contact-directory';

type StoredPair = PairedChildRecord & { contactDirectoryCache?: string };
function checkCurrent(current: () => boolean) { if (!current()) throw new Error('Child directory session changed'); }
async function assertPair(raw: StoredPair | undefined, pair: PairedChildRecord, key: string): Promise<StoredPair> {
  if (!raw?.encrypted || raw.id !== pair.id || raw.guardianPubkey !== pair.guardianPubkey || raw.pairedAt !== pair.pairedAt
    || raw.clientKeypair.publicKey !== pair.clientKeypair.publicKey || await decryptSecret(raw.bunkerUri, key) !== pair.bunkerUri
    || await decryptSecret(raw.clientKeypair.privateKey, key) !== pair.clientKeypair.privateKey) throw new Error('Child directory pairing changed');
  return raw;
}
async function decode(raw: StoredPair, key: string): Promise<ChildContactDirectory | null> {
  if (raw.contactDirectoryCache === undefined) return null;
  const parsed = parseChildContactDirectory(await decryptSecret(raw.contactDirectoryCache, key));
  if (!parsed || parsed.guardian !== raw.guardianPubkey || parsed.recipient !== raw.clientKeypair.publicKey) throw new Error('Invalid child directory cache');
  return parsed;
}
export async function loadChildContactDirectoryCache(pair: PairedChildRecord, key: string, current: () => boolean): Promise<ChildContactDirectory | null> {
  checkCurrent(current);
  const db = await getDb();
  const raw = await assertPair(await db.get('pairedChild', pair.id), pair, key);
  const view = await decode(raw, key);
  const fresh = await db.get('pairedChild', pair.id) as StoredPair | undefined;
  if (!fresh || fresh.bunkerUri !== raw.bunkerUri || fresh.pairedAt !== raw.pairedAt
    || fresh.clientKeypair.privateKey !== raw.clientKeypair.privateKey || fresh.clientKeypair.publicKey !== raw.clientKeypair.publicKey
    || fresh.guardianPubkey !== raw.guardianPubkey || fresh.contactDirectoryCache !== raw.contactDirectoryCache) throw new Error('Child directory cache changed; retry');
  checkCurrent(current);
  return view;
}
/** Store the replay floor before rendering. Equal-revision conflict is durable;
 * corruption cannot be mistaken for an empty cache. Never mutates child contacts. */
export async function saveChildContactDirectoryCache(pair: PairedChildRecord, key: string, incoming: ChildContactDirectory,
  current: () => boolean): Promise<ChildContactDirectory> {
  const view = parseChildContactDirectory(JSON.stringify(incoming));
  if (!view || view.guardian !== pair.guardianPubkey || view.recipient !== pair.clientKeypair.publicKey) throw new Error('Foreign child directory');
  checkCurrent(current);
  const db = await getDb();
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await assertPair(await db.get('pairedChild', pair.id), pair, key);
    const merged = mergeChildContactDirectory(await decode(raw, key), view);
    const ciphertext = await encryptSecret(JSON.stringify(merged), key);
    checkCurrent(current);
    const tx = db.transaction('pairedChild', 'readwrite');
    const fresh = await tx.store.get(pair.id) as StoredPair | undefined;
    if (!fresh || fresh.bunkerUri !== raw.bunkerUri || fresh.pairedAt !== raw.pairedAt || fresh.guardianPubkey !== raw.guardianPubkey
      || fresh.clientKeypair.publicKey !== raw.clientKeypair.publicKey || fresh.clientKeypair.privateKey !== raw.clientKeypair.privateKey
      || fresh.contactDirectoryCache !== raw.contactDirectoryCache) { await tx.done; continue; }
    if (!current()) { tx.abort(); await tx.done.catch(() => {}); throw new Error('Child directory session changed'); }
    await tx.store.put({ ...fresh, contactDirectoryCache: ciphertext });
    await tx.done;
    checkCurrent(current);
    return merged;
  }
  throw new Error('Child directory cache changed; retry');
}
