// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { SignetIdentity } from '../types';

vi.mock('../lib/signet', () => ({
  createNewIdentity: vi.fn(),
  importFromMnemonic: vi.fn(),
  importFromNsec: vi.fn(),
  importFromLiteMnemonic: vi.fn(),
  deriveExtraPersona: vi.fn(),
}));

import { createNewIdentity, importFromMnemonic, importFromNsec, importFromLiteMnemonic, deriveExtraPersona } from '../lib/signet';
import { useIdentity } from './useIdentity';
import * as db from '../lib/db';

const mockCreate = vi.mocked(createNewIdentity);
const mockRestore = vi.mocked(importFromMnemonic);
const mockImportNsec = vi.mocked(importFromNsec);
const mockImportLiteMnemonic = vi.mocked(importFromLiteMnemonic);
const mockDeriveExtra = vi.mocked(deriveExtraPersona);

const NP_PUBKEY = 'a'.repeat(64);
const PERSONA_PUBKEY = 'b'.repeat(64);

function makeFakeIdentity(overrides: Partial<SignetIdentity> = {}): SignetIdentity {
  return {
    id: NP_PUBKEY,
    mnemonic: 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
    naturalPerson: { publicKey: NP_PUBKEY, privateKey: 'np-priv', displayName: 'Test User' },
    persona: { publicKey: PERSONA_PUBKEY, privateKey: 'persona-priv', displayName: 'Anonymous' },
    primaryKeypair: 'natural-person',
    isChild: false,
    createdAt: 1_700_000_000,
    backedUp: false,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.purgeAllUserData();
  vi.clearAllMocks();
});

describe('useIdentity — no encryption key', () => {
  it('returns empty identities, null identity, loading false when no key provided', async () => {
    const { result } = renderHook(() => useIdentity());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.identities).toEqual([]);
    expect(result.current.identity).toBeNull();
  });
});

describe('useIdentity — loading state', () => {
  it('transitions loading to false once DB read completes', async () => {
    const { result } = renderHook(() => useIdentity('test-key'));

    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});

// M9 (2026-07-02 audit): on lock, decrypted identity state (mnemonic +
// private keys) must clear from React state in the SAME tick the
// encryptionKey is nulled — not after the async public-data reload
// resolves. Otherwise "locked" (encryptionKey null) briefly doesn't match
// what's still sitting in memory.
describe('useIdentity — lock clears decrypted state synchronously (M9)', () => {
  const KEY = 'test-encryption-key-min-8';

  it('clears identities/activeIdentity synchronously when encryptionKey transitions to null', async () => {
    const identity = makeFakeIdentity();
    await db.saveIdentityEncrypted(identity, KEY);
    await db.savePreferences({ id: 'current', theme: 'system', activeAccountId: identity.id });

    const { result, rerender } = renderHook(
      ({ key }: { key: string | null }) => useIdentity(key),
      { initialProps: { key: KEY as string | null } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    // Sanity: the decrypted private key is genuinely in state before lock.
    expect(result.current.identity?.naturalPerson.privateKey).toBe('np-priv');
    expect(result.current.identity?.mnemonic).toBe(identity.mnemonic);

    // Lock: encryptionKey transitions to null.
    rerender({ key: null });

    // Assert IMMEDIATELY — no waitFor, no extra microtask flush — proving
    // the clear happens synchronously within the lock transition, not
    // after loadPublic()'s async IndexedDB read resolves.
    expect(result.current.identities).toEqual([]);
    expect(result.current.identity).toBeNull();
  });
});

describe('useIdentity — create', () => {
  it('saves identity to DB and sets as active', async () => {
    mockCreate.mockReturnValue(makeFakeIdentity());

    const { result } = renderHook(() => useIdentity('test-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.create('Test User', 'natural-person', false);
    });

    expect(result.current.identity?.id).toBe(NP_PUBKEY);
    expect(result.current.identities).toHaveLength(1);
    expect(mockCreate).toHaveBeenCalledWith('Test User', 'natural-person', false, undefined);
  }, 15_000);
});

describe('useIdentity — restore', () => {
  it('imports from mnemonic and sets as active', async () => {
    mockRestore.mockReturnValue(makeFakeIdentity());

    const { result } = renderHook(() => useIdentity('test-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.restore(
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
        'Test User',
        'natural-person',
        false,
      );
    });

    expect(result.current.identity?.id).toBe(NP_PUBKEY);
    expect(mockRestore).toHaveBeenCalled();
  }, 10_000);
});

describe('useIdentity — restoreWithProfile', () => {
  it('hydrates NP + persona names from the profile and re-derives extras', async () => {
    mockRestore.mockReturnValue(makeFakeIdentity({
      naturalPerson: { publicKey: NP_PUBKEY, privateKey: 'np-priv', displayName: 'Margaret Smith' },
      persona: { publicKey: PERSONA_PUBKEY, privateKey: 'persona-priv', displayName: '' },
    }));
    mockDeriveExtra.mockImplementation((_m, name) => ({
      publicKey: `pub-${name}`,
      privateKey: `priv-${name}`,
    }));

    const { result } = renderHook(() => useIdentity('test-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.restoreWithProfile(
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
        {
          naturalPerson: { publicKey: NP_PUBKEY, displayName: 'Margaret Smith' },
          persona: { publicKey: PERSONA_PUBKEY, displayName: 'DarkWolf99' },
          extras: [
            { derivationName: 'persona-1', publicKey: 'ext1-pub', displayName: 'Club Alias' },
          ],
          primaryKeypair: 'natural-person',
        },
      );
    });

    expect(mockRestore).toHaveBeenCalledWith(
      expect.any(String),
      'Margaret Smith',
      'natural-person',
      false,
      undefined,
    );
    expect(result.current.identity?.naturalPerson.displayName).toBe('Margaret Smith');
    expect(result.current.identity?.persona.displayName).toBe('DarkWolf99');
    expect(result.current.identity?.extraPersonas).toHaveLength(1);
    expect(result.current.identity?.extraPersonas?.[0]).toMatchObject({
      derivationName: 'persona-1',
      displayName: 'Club Alias',
      publicKey: 'pub-persona-1',
    });
  }, 15_000);

  it('handles profile with persona primary and no NP profile', async () => {
    mockRestore.mockReturnValue(makeFakeIdentity({
      primaryKeypair: 'persona',
      id: PERSONA_PUBKEY,
      naturalPerson: { publicKey: NP_PUBKEY, privateKey: 'np-priv', displayName: '' },
      persona: { publicKey: PERSONA_PUBKEY, privateKey: 'persona-priv', displayName: 'DarkWolf99' },
    }));

    const { result } = renderHook(() => useIdentity('test-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.restoreWithProfile(
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
        {
          naturalPerson: null,
          persona: { publicKey: PERSONA_PUBKEY, displayName: 'DarkWolf99' },
          extras: [],
          primaryKeypair: 'persona',
        },
      );
    });

    expect(mockRestore).toHaveBeenCalledWith(
      expect.any(String),
      'DarkWolf99',
      'persona',
      false,
      undefined,
    );
    expect(result.current.identity?.primaryKeypair).toBe('persona');
  }, 15_000);
});

describe('useIdentity — importNsec', () => {
  it('imports from nsec and sets as active', async () => {
    mockImportNsec.mockReturnValue(makeFakeIdentity());

    const { result } = renderHook(() => useIdentity('test-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.importNsec('nsec1...', 'Test User', 'natural-person');
    });

    expect(result.current.identity?.id).toBe(NP_PUBKEY);
  }, 15_000);
});

describe('useIdentity — importLiteMnemonic', () => {
  it('imports a Lite mnemonic identity and sets it active', async () => {
    mockImportLiteMnemonic.mockReturnValue(makeFakeIdentity({ id: PERSONA_PUBKEY, primaryKeypair: 'persona' }));

    const { result } = renderHook(() => useIdentity('test-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.importLiteMnemonic(
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
        'default',
        'DarkWolf99',
      );
    });

    expect(mockImportLiteMnemonic).toHaveBeenCalledWith(
      expect.any(String),
      'default',
      'DarkWolf99',
    );
    expect(result.current.identity?.id).toBe(PERSONA_PUBKEY);
    expect(result.current.identity?.primaryKeypair).toBe('persona');
  }, 15_000);
});

describe('useIdentity — markBackedUp', () => {
  it('sets backedUp to true on the active identity', async () => {
    mockCreate.mockReturnValue(makeFakeIdentity());

    const { result } = renderHook(() => useIdentity('test-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.create('Test User', 'natural-person', false);
    });

    await act(async () => {
      await result.current.markBackedUp();
    });

    expect(result.current.identity?.backedUp).toBe(true);
  }, 20_000);
});

describe('useIdentity — remove', () => {
  it('removes the identity from the list', async () => {
    mockCreate.mockReturnValue(makeFakeIdentity());

    const { result } = renderHook(() => useIdentity('test-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.create('Test User', 'natural-person', false);
    });

    expect(result.current.identities).toHaveLength(1);

    await act(async () => {
      await result.current.remove();
    });

    expect(result.current.identities).toHaveLength(0);
    expect(result.current.identity).toBeNull();
  }, 20_000);
});

describe('useIdentity — switchPrimary', () => {
  it('switches primary keypair from natural-person to persona', async () => {
    mockCreate.mockReturnValue(makeFakeIdentity());

    const { result } = renderHook(() => useIdentity('test-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.create('Test User', 'natural-person', false);
    });

    expect(result.current.identity?.primaryKeypair).toBe('natural-person');
    expect(result.current.identity?.id).toBe(NP_PUBKEY);

    await act(async () => {
      await result.current.switchPrimary('persona');
    });

    expect(result.current.identity?.primaryKeypair).toBe('persona');
    expect(result.current.identity?.id).toBe(PERSONA_PUBKEY);
  }, 20_000);
});

describe('useIdentity — setSlotNip05Check / setPersonaPublicProfile clear-on-change', () => {
  it('setSlotNip05Check persists a check result on the target slot', async () => {
    mockCreate.mockReturnValue(makeFakeIdentity());
    const { result } = renderHook(() => useIdentity('test-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.create('Test User', 'natural-person', false);
    });

    await act(async () => {
      await result.current.setSlotNip05Check('natural-person', { result: 'match', checkedAt: 1_700_000_000_000 });
    });

    expect(result.current.identity?.naturalPerson.nip05CheckResult).toBe('match');
    expect(result.current.identity?.naturalPerson.nip05CheckedAt).toBe(1_700_000_000_000);
  }, 20_000);

  it('setPersonaPublicProfile preserves the check result when nip05 is unchanged', async () => {
    mockCreate.mockReturnValue(makeFakeIdentity());
    const { result } = renderHook(() => useIdentity('test-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.create('Test User', 'natural-person', false);
    });
    await act(async () => {
      await result.current.setPersonaPublicProfile(
        'natural-person',
        { displayName: 'Test User', nip05: 'alex@example.com' },
        undefined,
      );
    });
    await act(async () => {
      await result.current.setSlotNip05Check('natural-person', { result: 'match', checkedAt: 1_700_000_000_000 });
    });
    expect(result.current.identity?.naturalPerson.nip05CheckResult).toBe('match');

    // Re-save with the SAME nip05 (only `about` changes) — check result survives.
    await act(async () => {
      await result.current.setPersonaPublicProfile(
        'natural-person',
        { displayName: 'Test User', about: 'updated bio', nip05: 'alex@example.com' },
        undefined,
      );
    });
    expect(result.current.identity?.naturalPerson.nip05CheckResult).toBe('match');
    expect(result.current.identity?.naturalPerson.nip05CheckedAt).toBe(1_700_000_000_000);
  }, 20_000);

  it('setPersonaPublicProfile clears the check result when nip05 changes', async () => {
    mockCreate.mockReturnValue(makeFakeIdentity());
    const { result } = renderHook(() => useIdentity('test-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.create('Test User', 'natural-person', false);
    });
    await act(async () => {
      await result.current.setPersonaPublicProfile(
        'natural-person',
        { displayName: 'Test User', nip05: 'alex@example.com' },
        undefined,
      );
    });
    await act(async () => {
      await result.current.setSlotNip05Check('natural-person', { result: 'match', checkedAt: 1_700_000_000_000 });
    });
    expect(result.current.identity?.naturalPerson.nip05CheckResult).toBe('match');

    // Change nip05 to a different identifier — the stale result must clear.
    await act(async () => {
      await result.current.setPersonaPublicProfile(
        'natural-person',
        { displayName: 'Test User', nip05: 'alex-new@example.com' },
        undefined,
      );
    });
    expect(result.current.identity?.naturalPerson.nip05CheckResult).toBeUndefined();
    expect(result.current.identity?.naturalPerson.nip05CheckedAt).toBeUndefined();
  }, 20_000);

  it('setPersonaPublicProfile clears the check result when nip05 is cleared to empty', async () => {
    mockCreate.mockReturnValue(makeFakeIdentity());
    const { result } = renderHook(() => useIdentity('test-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.create('Test User', 'natural-person', false);
    });
    await act(async () => {
      await result.current.setPersonaPublicProfile(
        'natural-person',
        { displayName: 'Test User', nip05: 'alex@example.com' },
        undefined,
      );
    });
    await act(async () => {
      await result.current.setSlotNip05Check('natural-person', { result: 'match', checkedAt: 1_700_000_000_000 });
    });
    expect(result.current.identity?.naturalPerson.nip05CheckResult).toBe('match');

    await act(async () => {
      await result.current.setPersonaPublicProfile(
        'natural-person',
        { displayName: 'Test User' }, // nip05 omitted — clears it
        undefined,
      );
    });
    expect(result.current.identity?.naturalPerson.nip05).toBeUndefined();
    expect(result.current.identity?.naturalPerson.nip05CheckResult).toBeUndefined();
    expect(result.current.identity?.naturalPerson.nip05CheckedAt).toBeUndefined();
  }, 20_000);
});

describe('useIdentity — updatePhoto', () => {
  it('updates photoHash and blossomUrl on the active identity', async () => {
    mockCreate.mockReturnValue(makeFakeIdentity());

    const { result } = renderHook(() => useIdentity('test-key'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.create('Test User', 'natural-person', false);
    });

    await act(async () => {
      await result.current.updatePhoto('deadbeef', 'https://blossom.example.com/photo', 'aabbccdd'.repeat(8));
    });

    expect(result.current.identity?.photoHash).toBe('deadbeef');
    expect(result.current.identity?.blossomUrl).toBe('https://blossom.example.com/photo');
    expect(result.current.identity?.photoKey).toBe('aabbccdd'.repeat(8));
  }, 20_000);
});

// family-bunker §11.1.8 (D4): after migration the phone holds no mnemonic, so
// the owner's own "+ Add persona" must derive on the Heartwood device. The
// derivation token has to be byte-identical to the one the mnemonic path
// generates (`persona-N`) — the migration wizard's buildEnrolmentPlan enrols
// owner extras by `derivationName`, so a divergent token would make a later
// re-enrol derive a DIFFERENT key instead of an idempotent no-op.
describe('useIdentity — addPersona device derivation (§11.1.8 D4)', () => {
  const KEY = 'test-encryption-key-min-8';

  async function seedKeylessIdentity() {
    const identity = makeFakeIdentity({ mnemonic: '', naturalPerson: { publicKey: NP_PUBKEY, privateKey: '', displayName: 'Test User' } });
    await db.saveIdentityEncrypted(identity, KEY);
    await db.savePreferences({ id: 'current', theme: 'system', activeAccountId: identity.id });
    return identity;
  }

  it('derives the extra persona on the device and stores a keyless slot', async () => {
    await seedKeylessIdentity();
    const deviceDerive = vi.fn(async () => ({ publicKey: '4'.repeat(64), privateKey: '' as const }));

    const { result } = renderHook(() => useIdentity(KEY));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.addPersona('Games', undefined, { deviceDerive });
    });

    expect(deviceDerive).toHaveBeenCalledWith('persona-1');
    expect(mockDeriveExtra).not.toHaveBeenCalled();

    const persisted = await db.loadIdentityDecrypted(NP_PUBKEY, KEY);
    expect(persisted?.extraPersonas).toHaveLength(1);
    expect(persisted?.extraPersonas?.[0]).toMatchObject({
      publicKey: '4'.repeat(64),
      privateKey: '',
      displayName: 'Games',
      derivationName: 'persona-1',
    });
    expect(result.current.identity?.extraPersonas?.[0].publicKey).toBe('4'.repeat(64));
  }, 20_000);

  it('still throws the no-mnemonic error when no deviceDerive is supplied', async () => {
    await seedKeylessIdentity();

    const { result } = renderHook(() => useIdentity(KEY));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.addPersona('Games')).rejects.toThrow(/no mnemonic/i);
    const persisted = await db.loadIdentityDecrypted(NP_PUBKEY, KEY);
    expect(persisted?.extraPersonas ?? []).toHaveLength(0);
  }, 20_000);

  it('local path is unchanged — a mnemonic identity derives locally, device never asked', async () => {
    const identity = makeFakeIdentity();
    await db.saveIdentityEncrypted(identity, KEY);
    await db.savePreferences({ id: 'current', theme: 'system', activeAccountId: identity.id });
    mockDeriveExtra.mockReturnValue({ publicKey: '5'.repeat(64), privateKey: '6'.repeat(64) });
    const deviceDerive = vi.fn(async () => ({ publicKey: '4'.repeat(64), privateKey: '' as const }));

    const { result } = renderHook(() => useIdentity(KEY));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.addPersona('Games', undefined, { deviceDerive });
    });

    expect(deviceDerive).not.toHaveBeenCalled();
    expect(mockDeriveExtra).toHaveBeenCalledWith(identity.mnemonic, 'persona-1');
    const persisted = await db.loadIdentityDecrypted(NP_PUBKEY, KEY);
    expect(persisted?.extraPersonas?.[0].privateKey).toBe('6'.repeat(64));
  }, 20_000);
});
