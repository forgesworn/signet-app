// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useDependants } from './useDependants';
import { saveIdentityEncrypted, saveDependant, getDependants, purgeAllUserData } from '../lib/db';
import { createNewIdentity } from '../lib/signet';
import type { SignetIdentity, DependantIdentity } from '../types';

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
  });
});
