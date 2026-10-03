import { beforeEach, expect, it, vi } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
vi.mock('./db', async original => ({ ...await original<typeof import('./db')>(), getDependants: async () => [] }));
import { privateVaultJobs } from './private-vault-jobs';
import { forgetSyncCacheKeys } from './sync-decrypt-cache';
import { clearSyncCache } from './db';
import { LocalSigningBackend } from './signing-backend';
import type { BunkerSigningBackend, DecryptingSigningBackend } from './signing-backend';
import type { SignetIdentity } from '../types';

const identity = { id: 'n'.repeat(64), naturalPerson: { publicKey: 'n'.repeat(64) }, persona: { publicKey: 'p'.repeat(64) } } as unknown as SignetIdentity;
beforeEach(async () => { forgetSyncCacheKeys(); await clearSyncCache(); });

it('in device-held mode, every resolved vault backend reuses a key leg the device already decrypted', async () => {
  const local = new LocalSigningBackend(bytesToHex(crypto.getRandomValues(new Uint8Array(32))));
  const nip44Decrypt = vi.fn((peer: string, ct: string) => local.nip44Decrypt(peer, ct));
  const vaultBackend = vi.fn(async () => ({ type: 'bunker', activePublicKeyHex: local.activePublicKeyHex,
    signEvent: e => local.signEvent(e), nip44Encrypt: (p, t) => local.nip44Encrypt(p, t), nip44Decrypt, destroy: () => {} }) as DecryptingSigningBackend);
  const jobs = await privateVaultJobs({ identity, encryptionKey: 'a'.repeat(64), deviceHeldKeys: true,
    bunker: { vaultBackend } as unknown as BunkerSigningBackend, isCurrent: () => true });
  const contentKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const ct = await local.nip44Encrypt(local.activePublicKeyHex, contentKey);
  // Two independently resolved instances (a sync, then a rotation or forwarding step).
  for (const backend of [await jobs[0].resolve(0), await jobs[0].resolve(0)]) {
    expect(await backend.nip44Decrypt(local.activePublicKeyHex, ct)).toBe(contentKey);
  }
  expect(vaultBackend).toHaveBeenCalledTimes(2);
  expect(nip44Decrypt).toHaveBeenCalledTimes(1);
});
