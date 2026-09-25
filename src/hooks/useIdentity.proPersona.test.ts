// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
// We test the deriveAndStoreProPersona utility extracted in Step 3, not the full hook.
import { deriveAndStoreProPersona } from './useIdentity';
import type { SignetIdentity } from '../types';
import * as db from '../lib/db';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('deriveAndStoreProPersona', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('derives the Pro persona when absent and stores it encrypted', async () => {
    const saveProPersonaEncrypted = vi.spyOn(db, 'saveProPersonaEncrypted').mockResolvedValue(undefined);
    const identity: Partial<SignetIdentity> = {
      mnemonic: TEST_MNEMONIC,
      naturalPerson: { publicKey: 'aaa', privateKey: 'bbb', displayName: 'Test User' },
      professionalPersona: undefined,
    };
    const fakeEncKey = 'test-passphrase';

    const result = await deriveAndStoreProPersona(identity as SignetIdentity, fakeEncKey);

    expect(result.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.displayName).toBe('Test User'); // defaults to NP displayName §4.5.4
    expect(saveProPersonaEncrypted).toHaveBeenCalledOnce();
  });

  it('returns existing Pro persona without re-deriving when already present', async () => {
    const saveProPersonaEncrypted = vi.spyOn(db, 'saveProPersonaEncrypted').mockResolvedValue(undefined);
    const existing = { publicKey: 'cafe'.repeat(16), privateKey: 'dead'.repeat(16), displayName: 'Prof Name' };
    const identity: Partial<SignetIdentity> = {
      mnemonic: TEST_MNEMONIC,
      naturalPerson: { publicKey: 'aaa', privateKey: 'bbb', displayName: 'Test User' },
      professionalPersona: existing,
    };
    const fakeEncKey = 'test-passphrase';

    const result = await deriveAndStoreProPersona(identity as SignetIdentity, fakeEncKey);

    expect(result.publicKey).toBe(existing.publicKey);
    expect(saveProPersonaEncrypted).not.toHaveBeenCalled();
  });
});
