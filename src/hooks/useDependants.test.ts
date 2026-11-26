// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useDependants } from './useDependants';
import { openDB } from 'idb';
import { saveIdentityEncrypted, saveDependant, getDependants, purgeAllUserData, setCardBackdrop } from '../lib/db';
import { createNewIdentity } from '../lib/signet';
import type { SignetIdentity, DependantIdentity } from '../types';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import { buildPersonaFirstDependant } from '../lib/dependant-record';
import { childModeSessionStale } from '../lib/child-mode-sign-in';

const KEY = 'a'.repeat(64);
const NP = '1'.repeat(64);
const PERSONA = '2'.repeat(64);

// Builds a real guardian identity (real tree, valid hex pubkeys) via the
// same factory useIdentity uses. `withMnemonic: false` simulates the
// post-Heartwood-migration state (§11.1.1-.2 strip): mnemonic and local
// private keys are gone, only pubkeys remain.
async function seedGuardian(withMnemonic: boolean): Promise<SignetIdentity> {
  const id = createNewIdentity('Guardian', 'natural-person', false);
  const identity: SignetIdentity = {
    ...id,
    mnemonic: withMnemonic ? id.mnemonic : '',
    naturalPerson: { ...id.naturalPerson, privateKey: withMnemonic ? id.naturalPerson.privateKey : '' },
    persona: { ...id.persona, privateKey: withMnemonic ? id.persona.privateKey : '' },
  };
  await saveIdentityEncrypted(identity, KEY);
  return identity;
}

describe('useDependants.addDependant', () => {
  beforeEach(async () => {
    await purgeAllUserData();
  });

  it('device path: persists keyless slots with the device pubkeys and the next free path', async () => {
    const g = await seedGuardian(false);
    const { result } = renderHook(() => useDependants(g.naturalPerson.publicKey, g.id, KEY));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const deviceDerive = vi.fn(async (_path: string) => ({
      naturalPerson: { publicKey: NP, privateKey: '' as const },
      persona: { publicKey: PERSONA, privateKey: '' as const },
    }));

    let dep!: Awaited<ReturnType<typeof result.current.addDependant>>;
    await act(async () => {
      dep = await result.current.addDependant('Robin', undefined, { deviceDerive });
    });

    expect(deviceDerive).toHaveBeenCalledWith('dependant-0');
    expect(dep.id).toBe(PERSONA);
    expect(dep.derivationPath).toBe('dependant-0');

    const stored = await getDependants(g.naturalPerson.publicKey, KEY);
    expect(stored[0].naturalPerson.privateKey).toBe('');
    expect(stored[0].persona.privateKey).toBe('');
    expect(stored[0].persona.publicKey).toBe(PERSONA);
  });

  it('device path: does not need a mnemonic (no throw); local path still guards without deviceDerive', async () => {
    const g = await seedGuardian(false);
    const { result } = renderHook(() => useDependants(g.naturalPerson.publicKey, g.id, KEY));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.addDependant('Robin')).rejects.toThrow(/no mnemonic/);
  });

  it('local path: unchanged (derives from mnemonic, private keys present)', async () => {
    const g = await seedGuardian(true);
    const { result } = renderHook(() => useDependants(g.naturalPerson.publicKey, g.id, KEY));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.addDependant('Mia');
    });

    const stored = await getDependants(g.naturalPerson.publicKey, KEY);
    expect(stored[0].derivationPath).toBe('dependant-0');
    expect(stored[0].naturalPerson.privateKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('useDependants.addDependantPersona', () => {
  beforeEach(async () => {
    await purgeAllUserData();
  });

  const EXTRA = '3'.repeat(64);

  it('device path: persists a keyless extra persona at the next derivation name', async () => {
    const g = await seedGuardian(false);
    const { result } = renderHook(() => useDependants(g.naturalPerson.publicKey, g.id, KEY));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const depDeviceDerive = vi.fn(async (_path: string) => ({
      naturalPerson: { publicKey: NP, privateKey: '' as const },
      persona: { publicKey: PERSONA, privateKey: '' as const },
    }));
    let dep!: Awaited<ReturnType<typeof result.current.addDependant>>;
    await act(async () => {
      dep = await result.current.addDependant('Robin', undefined, { deviceDerive: depDeviceDerive });
    });

    const personaDeviceDerive = vi.fn(async (_name: string) => ({ publicKey: EXTRA, privateKey: '' as const }));
    await act(async () => {
      await result.current.addDependantPersona(dep.id, 'Games', undefined, { deviceDerive: personaDeviceDerive });
    });

    expect(personaDeviceDerive).toHaveBeenCalledWith('dependant-0-persona-0');

    const stored = await getDependants(g.naturalPerson.publicKey, KEY);
    expect(stored[0].extraPersonas).toHaveLength(1);
    expect(stored[0].extraPersonas?.[0].publicKey).toBe(EXTRA);
    expect(stored[0].extraPersonas?.[0].privateKey).toBe('');
    expect(stored[0].extraPersonas?.[0].derivationName).toBe('dependant-0-persona-0');
  });

  it('local path without deviceDerive on a keyless guardian rejects with /no mnemonic/', async () => {
    const g = await seedGuardian(false);
    const { result } = renderHook(() => useDependants(g.naturalPerson.publicKey, g.id, KEY));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const depDeviceDerive = vi.fn(async (_path: string) => ({
      naturalPerson: { publicKey: NP, privateKey: '' as const },
      persona: { publicKey: PERSONA, privateKey: '' as const },
    }));
    let dep!: Awaited<ReturnType<typeof result.current.addDependant>>;
    await act(async () => {
      dep = await result.current.addDependant('Robin', undefined, { deviceDerive: depDeviceDerive });
    });

    await expect(result.current.addDependantPersona(dep.id, 'Games')).rejects.toThrow(/no mnemonic/);
  });
});

describe('useDependants.updateDependantName (dormant/active NP guard, spec §7.6)', () => {
  beforeEach(async () => {
    await purgeAllUserData();
  });

  it('dormant persona-first dependant: rename updates the family label only — never writes the dormant NP slot', async () => {
    const g = await seedGuardian(false);
    const { result } = renderHook(() => useDependants(g.naturalPerson.publicKey, g.id, KEY));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const deviceDerive = vi.fn(async (_path: string) => ({
      naturalPerson: { publicKey: NP, privateKey: '' as const },
      persona: { publicKey: PERSONA, privateKey: '' as const },
    }));
    let dep!: Awaited<ReturnType<typeof result.current.addDependant>>;
    await act(async () => {
      dep = await result.current.addDependant('Robin', undefined, { deviceDerive });
    });
    expect(dep.naturalPersonActive).toBe(false);
    expect(dep.naturalPerson.displayName).toBe('');

    await act(async () => {
      await result.current.updateDependantName(dep.id, 'New Name');
    });

    const [stored] = await getDependants(g.naturalPerson.publicKey, KEY);
    expect(stored.displayName).toBe('New Name');
    // The dormant real-identity slot is never named by a rename.
    expect(stored.naturalPerson.displayName).toBe('');
    expect(stored.naturalPersonActive).toBe(false);
    // updateDependantName never touches the persona slot either way — it's
    // untouched by the rename, in either branch.
    expect(stored.persona.displayName).toBe('Robin');
  });

  it('active dependant: rename updates both the family label and the NP display name', async () => {
    const g = await seedGuardian(false);
    const active: DependantIdentity = {
      id: NP,
      guardianPubkey: g.naturalPerson.publicKey,
      displayName: 'Old Family Label',
      naturalPerson: { publicKey: NP, privateKey: '', displayName: 'Old Real Name' },
      persona: { publicKey: PERSONA, privateKey: '', displayName: 'PersonaName' },
      derivationPath: 'dependant-0',
      createdAt: Math.floor(Date.now() / 1000),
      autonomyStage: 'full-control',
      primaryKeypair: 'natural-person',
      naturalPersonActive: true,
    };
    await saveDependant(active, KEY);

    const { result } = renderHook(() => useDependants(g.naturalPerson.publicKey, g.id, KEY));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.dependants).toHaveLength(1));

    await act(async () => {
      await result.current.updateDependantName(NP, 'New Name');
    });

    const [stored] = await getDependants(g.naturalPerson.publicKey, KEY);
    expect(stored.displayName).toBe('New Name');
    // Active NP: the rename also names the real-identity slot.
    expect(stored.naturalPerson.displayName).toBe('New Name');
    expect(stored.naturalPersonActive).toBe(true);
    // The persona slot is untouched by updateDependantName.
    expect(stored.persona.displayName).toBe('PersonaName');
  });
});


describe('dependant persona allocation after deletion', () => {
  beforeEach(async () => { await purgeAllUserData(); });

  it('never reuses live or deleted keys, including stale callbacks, concurrent taps and reload', async () => {
    const g = await seedGuardian(true);
    const hook = renderHook(() => useDependants(g.naturalPerson.publicKey, g.id, KEY));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    let dep!: DependantIdentity;
    await act(async () => { dep = await hook.result.current.addDependant('Robin'); });
    const add = hook.result.current.addDependantPersona;
    await act(async () => {
      await Promise.all([add(dep.id, 'First'), add(dep.id, 'Second')]);
    });
    let stored = (await getDependants(g.naturalPerson.publicKey, KEY))[0];
    expect(stored.extraPersonas?.map(p => p.derivationName)).toEqual([
      'dependant-0-persona-0', 'dependant-0-persona-1',
    ]);
    const originalKeys = stored.extraPersonas!.map(p => p.publicKey);
    await act(async () => {
      await hook.result.current.removeDependantExtraPersona(dep.id, originalKeys[0]);
      await add(dep.id, 'Third');
    });
    stored = (await getDependants(g.naturalPerson.publicKey, KEY))[0];
    expect(stored.extraPersonas?.map(p => p.derivationName)).toEqual([
      'dependant-0-persona-1', 'dependant-0-persona-2',
    ]);
    for (const ep of stored.extraPersonas!) {
      await act(async () => { await hook.result.current.removeDependantExtraPersona(dep.id, ep.publicKey); });
    }
    hook.unmount();
    const reloaded = renderHook(() => useDependants(g.naturalPerson.publicKey, g.id, KEY));
    await waitFor(() => expect(reloaded.result.current.loading).toBe(false));
    await act(async () => { await reloaded.result.current.addDependantPersona(dep.id, 'After reload'); });
    stored = (await getDependants(g.naturalPerson.publicKey, KEY))[0];
    expect(stored.extraPersonas?.[0].derivationName).toBe('dependant-0-persona-3');
    expect(originalKeys).not.toContain(stored.extraPersonas?.[0].publicKey);
    expect(stored.extraPersonaTombstones).toHaveLength(3);
    // Six derivations and a dozen encrypted writes: about six seconds on an
    // idle machine, past the 15 s default when the full suite shares the CPU.
  }, 60_000);
});

describe('useDependants.removeDependant', () => {
  beforeEach(async () => { await purgeAllUserData(); });

  it('forgets the card backdrop of every key the dependant could show a card for, and no one else\'s', async () => {
    const g = await seedGuardian(true);
    const hook = renderHook(() => useDependants(g.naturalPerson.publicKey, g.id, KEY));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    let dep!: DependantIdentity;
    await act(async () => { dep = await hook.result.current.addDependant('Robin'); });
    await act(async () => { await hook.result.current.addDependantPersona(dep.id, 'Extra'); });
    const stored = (await getDependants(g.naturalPerson.publicKey, KEY))[0];
    const keys = [stored.id, stored.naturalPerson.publicKey, stored.persona.publicKey, stored.extraPersonas![0].publicKey];
    const bystander = 'f'.repeat(64);
    const seeded = [...keys, bystander];
    const rawBefore = await openDB('my-signet');
    for (const key of seeded) await setCardBackdrop(key, new Blob(['x'], { type: 'image/jpeg' }));
    for (const key of seeded) expect(await rawBefore.get('preferences', `backdrop:${key}`)).toBeDefined();
    rawBefore.close();

    await act(async () => { await hook.result.current.removeDependant(dep.id); });

    // Read the raw rows: under jsdom the stored Blob does not satisfy getCardBackdrop's instanceof check.
    const raw = await openDB('my-signet');
    try {
      for (const key of keys) expect(await raw.get('preferences', `backdrop:${key}`)).toBeUndefined();
      expect(await raw.get('preferences', `backdrop:${bystander}`)).toBeDefined();
    } finally { raw.close(); }
  }, 60_000);
});

describe('useDependants edit time (#199)', () => {
  beforeEach(async () => { await purgeAllUserData(); });

  it('a stage change reaches the hook state with its edit time, so the sync wire carries it', async () => {
    const g = await seedGuardian(false);
    const { result } = renderHook(() => useDependants(g.naturalPerson.publicKey, g.id, KEY));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const deviceDerive = async () => ({
      naturalPerson: { publicKey: NP, privateKey: '' as const }, persona: { publicKey: PERSONA, privateKey: '' as const },
    });
    let dep!: DependantIdentity;
    await act(async () => { dep = await result.current.addDependant('Robin', undefined, { deviceDerive }); });
    const before = Date.now();
    await act(async () => { await result.current.updateAutonomyStage(dep.id, 'request-approve'); });
    const inState = result.current.dependants.find(d => d.id === dep.id)!;
    expect(inState.autonomyStage).toBe('request-approve');
    expect(inState.updatedAt).toBeGreaterThanOrEqual(before);
  });
});

// The child-mode stale-session check (App.tsx, `childModeSessionStale`) clears
// a saved session only once the dependants have been read WITH the key: the
// keyless read before unlock lists records it cannot decrypt, so "the child is
// not there" means nothing until then.
describe('useDependants.loadedWithKey', () => {
  beforeEach(async () => {
    await purgeAllUserData();
  });

  async function seedKid(guardianPubkey: string, key: string): Promise<DependantIdentity> {
    const npSk = generateSecretKey();
    const personaSk = generateSecretKey();
    const dep = buildPersonaFirstDependant({
      guardianPubkey, enteredName: 'RunKid', derivationPath: 'dependant-0',
      naturalPerson: { publicKey: getPublicKey(npSk), privateKey: bytesToHex(npSk) },
      persona: { publicKey: getPublicKey(personaSk), privateKey: bytesToHex(personaSk) },
      createdAt: 1_700_000_000,
    });
    await saveDependant(dep, key);
    return dep;
  }

  it('is false for the keyless read before unlock, true once read with the key, and false again after a lock', async () => {
    const g = await seedGuardian(true);
    const kid = await seedKid(g.naturalPerson.publicKey, KEY);
    const { result, rerender } = renderHook(
      ({ key, guardian }: { key: string | null; guardian: string | undefined }) => useDependants(guardian, g.id, key),
      { initialProps: { key: null, guardian: g.naturalPerson.publicKey } as { key: string | null; guardian: string | undefined } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadedWithKey).toBe(false);
    expect(result.current.dependants.map(d => d.id)).toEqual([kid.id]);
    expect(childModeSessionStale({ unlocked: false, dependantsLoadedWithKey: result.current.loadedWithKey, childModeLive: false, sessionDependantId: kid.id, dependantIds: [] })).toBe(false);

    rerender({ key: KEY, guardian: g.naturalPerson.publicKey });
    await waitFor(() => expect(result.current.loadedWithKey).toBe(true));
    expect(result.current.dependants.map(d => d.id)).toEqual([kid.id]);
    expect(childModeSessionStale({ unlocked: true, dependantsLoadedWithKey: true, childModeLive: false, sessionDependantId: kid.id, dependantIds: result.current.dependants.map(d => d.id) })).toBe(false);

    // A lock passes through "no guardian identity" and an empty list.
    rerender({ key: null, guardian: undefined });
    await waitFor(() => expect(result.current.loadedWithKey).toBe(false));
    expect(result.current.dependants).toEqual([]);
  });

  it('a record the key cannot decrypt is left out of the keyed read, so a session for it is stale', async () => {
    const g = await seedGuardian(true);
    const kid = await seedKid(g.naturalPerson.publicKey, 'b'.repeat(64));
    const { result } = renderHook(() => useDependants(g.naturalPerson.publicKey, g.id, KEY));
    await waitFor(() => expect(result.current.loadedWithKey).toBe(true));
    expect(result.current.dependants).toEqual([]);
    expect(childModeSessionStale({ unlocked: true, dependantsLoadedWithKey: true, childModeLive: false, sessionDependantId: kid.id, dependantIds: result.current.dependants.map(d => d.id) })).toBe(true);
  });
});

describe('useDependants.setDependantPersonaBackdrop', () => {
  beforeEach(async () => {
    await purgeAllUserData();
  });

  const EXTRA = '3'.repeat(64);
  const bd = (n: string) => ({ hash: n.repeat(64), blossomUrl: 'https://nostr.download', keyHex: n.repeat(64), updatedAt: 9 });

  async function setup() {
    const g = await seedGuardian(false);
    const { result } = renderHook(() => useDependants(g.naturalPerson.publicKey, g.id, KEY));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let dep!: Awaited<ReturnType<typeof result.current.addDependant>>;
    await act(async () => {
      dep = await result.current.addDependant('Robin', undefined, { deviceDerive: async () => ({
        naturalPerson: { publicKey: NP, privateKey: '' as const }, persona: { publicKey: PERSONA, privateKey: '' as const },
      }) });
    });
    await act(async () => {
      await result.current.addDependantPersona(dep.id, 'Games', undefined, { deviceDerive: async () => ({ publicKey: EXTRA, privateKey: '' as const }) });
    });
    return { g, result, dep };
  }

  it('stores the four fields on the persona, an extra and the NP, encrypted at rest', async () => {
    const { g, result, dep } = await setup();
    for (const [target, n] of [['persona', '1'], [EXTRA, '2'], ['natural-person', '3']] as const) {
      await act(async () => { await result.current.setDependantPersonaBackdrop(dep.id, target, bd(n)); });
    }
    const stored = (await getDependants(g.naturalPerson.publicKey, KEY))[0];
    expect(stored.persona).toMatchObject({ backdropHash: '1'.repeat(64), backdropKey: '1'.repeat(64), backdropBlossomUrl: 'https://nostr.download', backdropUpdatedAt: 9 });
    expect(stored.extraPersonas![0]).toMatchObject({ backdropHash: '2'.repeat(64) });
    expect(stored.naturalPerson).toMatchObject({ backdropHash: '3'.repeat(64) });
    // The avatar fields were not touched.
    expect(stored.persona.avatarHash).toBeUndefined();
  });

  it('reports the blob the slot pointed at before, from a FRESH read, and clears with null', async () => {
    const { g, result, dep } = await setup();
    let out!: Awaited<ReturnType<typeof result.current.setDependantPersonaBackdrop>>;
    await act(async () => { out = await result.current.setDependantPersonaBackdrop(dep.id, 'persona', bd('1')); });
    expect(out.previous).toBeUndefined();
    await act(async () => { out = await result.current.setDependantPersonaBackdrop(dep.id, 'persona', bd('2')); });
    expect(out.previous).toEqual({ hash: '1'.repeat(64), server: 'https://nostr.download' });
    await act(async () => { out = await result.current.setDependantPersonaBackdrop(dep.id, 'persona', null); });
    expect(out.previous).toEqual({ hash: '2'.repeat(64), server: 'https://nostr.download' });
    const stored = (await getDependants(g.naturalPerson.publicKey, KEY))[0];
    expect(stored.persona.backdropHash).toBeUndefined();
    expect(stored.persona.backdropKey).toBeUndefined();
    expect(stored.persona.backdropBlossomUrl).toBeUndefined();
  });

  it('records the digest of the picture that was sent with the pointer, clears it with the pointer, and never loses it to the other fields', async () => {
    const { g, result, dep } = await setup();
    await act(async () => { await result.current.setDependantPersonaBackdrop(dep.id, 'persona', { ...bd('1'), sentDigest: 'd'.repeat(64) }); });
    let stored = (await getDependants(g.naturalPerson.publicKey, KEY))[0];
    expect(stored.persona.backdropSentDigest).toBe('d'.repeat(64));
    await act(async () => { await result.current.setDependantPersonaBackdrop(dep.id, 'persona', null); });
    stored = (await getDependants(g.naturalPerson.publicKey, KEY))[0];
    expect(stored.persona.backdropSentDigest).toBeUndefined();
  });

  it('refuses an unknown dependant or slot rather than reporting a save that never happened', async () => {
    const { result, dep } = await setup();
    await act(async () => {
      await expect(result.current.setDependantPersonaBackdrop('f'.repeat(64), 'persona', bd('1'))).rejects.toThrow();
      await expect(result.current.setDependantPersonaBackdrop(dep.id, 'e'.repeat(64), bd('1'))).rejects.toThrow();
    });
  });

  it('refuses when there is no guardian pubkey', async () => {
    const { result } = renderHook(() => useDependants(undefined, undefined, KEY));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await expect(result.current.setDependantPersonaBackdrop('f'.repeat(64), 'persona', bd('1'))).rejects.toThrow();
    });
  });

  it('a setter captured before a lock saves nothing once the key is gone', async () => {
    const g = await seedGuardian(false);
    const { result, rerender } = renderHook(({ k }: { k: string | null }) => useDependants(g.naturalPerson.publicKey, g.id, k), { initialProps: { k: KEY as string | null } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let dep!: Awaited<ReturnType<typeof result.current.addDependant>>;
    await act(async () => {
      dep = await result.current.addDependant('Robin', undefined, { deviceDerive: async () => ({
        naturalPerson: { publicKey: NP, privateKey: '' as const }, persona: { publicKey: PERSONA, privateKey: '' as const },
      }) });
    });
    const stale = result.current.setDependantPersonaBackdrop;
    rerender({ k: null });
    await act(async () => {
      await expect(stale(dep.id, 'persona', bd('1'))).rejects.toThrow('Encryption key required');
    });
    const stored = (await getDependants(g.naturalPerson.publicKey, KEY))[0];
    expect(stored.persona.backdropHash).toBeUndefined();
  });

  it('clearing a slot that names nothing is a no-op success', async () => {
    const { result, dep } = await setup();
    let out!: Awaited<ReturnType<typeof result.current.setDependantPersonaBackdrop>>;
    await act(async () => { out = await result.current.setDependantPersonaBackdrop(dep.id, 'persona', null); });
    expect(out).toEqual({});
  });

  // Gap 2: every writer reads the record fresh in the dependant write queue, so
  // a setter held from an older render can no longer save its stale snapshot
  // over a field another setter just wrote.
  it('an avatar and a backdrop set on the same slot both land, fired together or from stale closures', async () => {
    const { g, result, dep } = await setup();
    const { setDependantPersonaAvatar: setAvatar, setDependantPersonaBackdrop: setBackdrop, updatePersonaVisibility, updateDependantName } = result.current;
    const av = { hash: '4'.repeat(64), blossomUrl: 'https://nostr.download', keyHex: '4'.repeat(64), updatedAt: 7 };
    await act(async () => {
      await Promise.all([setBackdrop(dep.id, 'persona', bd('1')), setAvatar(dep.id, 'persona', av)]);
    });
    // Same closures again, awaited one after the other: the second used to save
    // the pre-change snapshot it closed over.
    await act(async () => { await setBackdrop(dep.id, EXTRA, bd('2')); });
    await act(async () => { await updatePersonaVisibility(dep.id, EXTRA, false); });
    await act(async () => { await updateDependantName(dep.id, 'Robin B'); });
    const stored = (await getDependants(g.naturalPerson.publicKey, KEY))[0];
    expect(stored.persona).toMatchObject({ backdropHash: '1'.repeat(64), avatarHash: '4'.repeat(64), avatarKey: '4'.repeat(64) });
    expect(stored.extraPersonas![0].backdropHash).toBe('2'.repeat(64));
    expect(stored.hiddenOnPairedDeviceKeys).toEqual([EXTRA]);
    expect(stored.displayName).toBe('Robin B');
  });

  it('the avatar setter reports the avatar it replaced, and the clear reports what it cleared', async () => {
    const { result, dep } = await setup();
    const av = (n: string) => ({ hash: n.repeat(64), blossomUrl: 'https://nostr.download', keyHex: n.repeat(64), updatedAt: 7 });
    let out!: { previous?: { hash: string; server: string } };
    await act(async () => { out = await result.current.setDependantPersonaAvatar(dep.id, 'persona', av('5')); });
    expect(out.previous).toBeUndefined();
    await act(async () => { out = await result.current.setDependantPersonaAvatar(dep.id, 'persona', av('6')); });
    expect(out.previous).toEqual({ hash: '5'.repeat(64), server: 'https://nostr.download' });
    await act(async () => { out = await result.current.clearDependantPersonaAvatar(dep.id, 'persona'); });
    expect(out.previous).toEqual({ hash: '6'.repeat(64), server: 'https://nostr.download' });
    await act(async () => {
      await expect(result.current.setDependantPersonaAvatar(dep.id, 'e'.repeat(64), av('7'))).rejects.toThrow('Persona not found');
    });
  });
});
