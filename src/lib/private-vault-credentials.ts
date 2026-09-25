import { parseCredential } from 'signet-protocol';
import type { StoredCredential } from '../types';
import type { PrivateVaultDatasetAdapter } from './private-vault-sync';
import { parsePayload, mergeCredentialLists } from './credentials-sync';
import * as db from './db';
import { contactsMutationQueue } from './contacts-v2-queue';

/** Ownership is explicit: never send another locally stored account's leaves. */
export function credentialsVaultAdapter(args: {
  encryptionKey: string; ownerPubkeys(): Promise<string[]>; isCurrent(): boolean;
}): PrivateVaultDatasetAdapter {
  const current = () => { if (!args.isCurrent()) throw new Error('Vault session changed'); };
  const owned = async (credentials: StoredCredential[]) => {
    const keys = new Set(await args.ownerPubkeys());
    const documentIds = new Set((await Promise.all([...keys].map(key => db.getDocumentsByOwner(key, args.encryptionKey))))
      .flat().map(doc => doc.id));
    return credentials.filter(c => {
      if (documentIds.has(c.documentId)) return true;
      try { return keys.has(parseCredential(JSON.parse(c.event))?.subjectPubkey ?? ''); }
      catch { return false; }
    });
  };
  return {
    dataset: 'credentials',
    snapshot: () => contactsMutationQueue.run(async () => {
      current();
      const credentials = (await owned(await db.getAllCredentials(args.encryptionKey))).sort((a, b) => a.id.localeCompare(b.id));
      const raw = JSON.stringify({ v: 1, credentials });
      const parsed = parsePayload(raw);
      if (!parsed || parsed.length !== credentials.length) throw new Error('A credential cannot be represented in the private backup');
      current();
      return raw;
    }),
    merge: raw => contactsMutationQueue.run(async () => {
      current();
      const value = JSON.parse(raw);
      const parsed = parsePayload(raw);
      if (value?.v !== 1 || !parsed || parsed.length !== value.credentials?.length) throw new Error('Invalid credentials vault');
      const accepted = await owned(parsed);
      if (accepted.length !== parsed.length) throw new Error('Credential belongs to another identity or cannot be assigned');
      const local = await db.getAllCredentials(args.encryptionKey);
      const ownedLocalIds = new Set((await owned(local)).map(c => c.id));
      const foreignIds = new Set(local.filter(c => !ownedLocalIds.has(c.id)).map(c => c.id));
      if (accepted.some(c => foreignIds.has(c.id))) throw new Error('Credential ID belongs to another account');
      const { toSave } = mergeCredentialLists(local, accepted);
      for (const credential of toSave) { current(); await db.saveCredential(credential, args.encryptionKey); }
    }),
  };
}
