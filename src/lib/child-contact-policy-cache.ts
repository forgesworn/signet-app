import { getDb } from './db';
import { decryptSecret, encryptSecret } from './crypto-store';
import { mergeChildContactPolicy, parseChildContactPolicy, type ChildContactPolicyView } from './child-contact-policy-wire';
import type { PairedChildRecord } from '../types';

type StoredPair = PairedChildRecord & { contactPolicyCache?: string };
async function assertPair(raw: StoredPair | undefined, pair: PairedChildRecord, key: string): Promise<StoredPair> {
  if (!raw?.encrypted || raw.id !== pair.id || raw.guardianPubkey !== pair.guardianPubkey
    || raw.clientKeypair.publicKey !== pair.clientKeypair.publicKey
    || await decryptSecret(raw.bunkerUri, key) !== pair.bunkerUri) throw new Error('Child policy pairing changed');
  return raw;
}
async function decode(raw: StoredPair, key: string): Promise<ChildContactPolicyView | null> {
  if (raw.contactPolicyCache === undefined) return null;
  const parsed = parseChildContactPolicy(await decryptSecret(raw.contactPolicyCache, key));
  if (!parsed || parsed.guardian !== raw.guardianPubkey || parsed.recipient !== raw.clientKeypair.publicKey) throw new Error('Invalid child policy cache');
  return parsed;
}
export async function loadChildContactPolicyCache(pair: PairedChildRecord, key: string): Promise<ChildContactPolicyView | null> {
  const db = await getDb();
  const raw = await assertPair(await db.get('pairedChild', pair.id), pair, key);
  return decode(raw, key);
}
/** Persist before using a received view. CAS covers concurrent tabs and pairing
 * changes while encryption is running. A corrupt cache is not a fresh start. */
export async function saveChildContactPolicyCache(pair: PairedChildRecord, key: string, incoming: ChildContactPolicyView): Promise<ChildContactPolicyView> {
  const view = parseChildContactPolicy(JSON.stringify(incoming));
  if (!view || view.guardian !== pair.guardianPubkey || view.recipient !== pair.clientKeypair.publicKey) throw new Error('Foreign child policy');
  const db = await getDb();
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await assertPair(await db.get('pairedChild', pair.id), pair, key);
    const previous = await decode(raw, key), merged = mergeChildContactPolicy(previous, view);
    const ciphertext = await encryptSecret(JSON.stringify(merged), key);
    const tx = db.transaction('pairedChild', 'readwrite');
    const fresh = await tx.store.get(pair.id) as StoredPair | undefined;
    if (!fresh || fresh.bunkerUri !== raw.bunkerUri || fresh.guardianPubkey !== raw.guardianPubkey
      || fresh.clientKeypair.publicKey !== raw.clientKeypair.publicKey || fresh.clientKeypair.privateKey !== raw.clientKeypair.privateKey
      || fresh.contactPolicyCache !== raw.contactPolicyCache) { await tx.done; continue; }
    await tx.store.put({ ...fresh, contactPolicyCache: ciphertext });
    await tx.done;
    return merged;
  }
  throw new Error('Child policy cache changed; retry');
}
