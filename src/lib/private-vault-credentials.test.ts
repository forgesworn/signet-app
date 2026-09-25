import { beforeEach, expect, it } from 'vitest';
import { ATTESTATION_KIND, ATTESTATION_TYPES } from 'signet-protocol';
import { credentialsVaultAdapter } from './private-vault-credentials';
import * as db from './db';
import type { StoredCredential } from '../types';
const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64), KEY = 'credential unlock';
const credential = (id: string, owner: string): StoredCredential => ({ id, documentId: 'missing-document',
  keypairType: 'professional', verifierPubkey: 'c'.repeat(64), verifiedAt: 1, verifierStatus: 'confirmed',
  event: JSON.stringify({ kind: ATTESTATION_KIND, tags: [['type', ATTESTATION_TYPES.CREDENTIAL], ['tier', '1'], ['d', `credential:${owner}`]] }),
});
beforeEach(async () => { await db.purgeAllUserData(); });
it('restores owned credentials without a local document and excludes other accounts', async () => {
  const adapter = credentialsVaultAdapter({ encryptionKey: KEY, ownerPubkeys: async () => [OWNER], isCurrent: () => true });
  await db.saveCredential(credential('d'.repeat(64), OTHER), KEY);
  const own = credential('e'.repeat(64), OWNER);
  await adapter.merge(JSON.stringify({ v: 1, credentials: [own] }), 0);
  expect(JSON.parse(await adapter.snapshot()).credentials.map((c: StoredCredential) => c.id)).toEqual(['e'.repeat(64)]);
  expect((await db.getAllCredentials(KEY)).length).toBe(2);
  await expect(adapter.merge(JSON.stringify({ v: 1, credentials: [credential('d'.repeat(64), OWNER)] }), 0)).rejects.toThrow('another account');
  await expect(adapter.merge(JSON.stringify({ v: 1, credentials: [credential('f'.repeat(64), OTHER)] }), 0)).rejects.toThrow('another identity');
});
