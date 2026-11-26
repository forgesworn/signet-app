// The serialised fresh-read dependant writer (`mutateDependant`, db.ts).
// Real IndexedDB (fake-indexeddb) and real encryption throughout.
import { describe, it, expect, beforeEach } from 'vitest';
import { mutateDependant, saveDependant, deleteDependant, getDependants, purgeAllUserData, clearChildDevice } from './db';
import { mergeDependantWithLocal } from './dependants-sync';
import type { DependantIdentity } from '../types';

const KEY = 'k'.repeat(64);
const GUARDIAN = 'a'.repeat(64);
const ID = 'c'.repeat(64);
const PERSONA = 'd'.repeat(64);
const HASH_A = '1'.repeat(64);
const HASH_B = '2'.repeat(64);

function makeDep(overrides: Partial<DependantIdentity> = {}): DependantIdentity {
  return {
    id: ID,
    guardianPubkey: GUARDIAN,
    displayName: 'Kid',
    naturalPerson: { publicKey: ID, privateKey: '', displayName: 'Kid' },
    persona: { publicKey: PERSONA, privateKey: '', displayName: 'Kiddo' },
    derivationPath: `imported-view-${ID.slice(0, 8)}`,
    createdAt: 1000,
    autonomyStage: 'full-control',
    primaryKeypair: 'persona',
    naturalPersonActive: true,
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

const stored = async () => (await getDependants(GUARDIAN, KEY)).find(d => d.id === ID);

describe('mutateDependant', () => {
  beforeEach(async () => {
    await purgeAllUserData();
  });

  it('a sync merge and a backdrop write interleaved both land', async () => {
    await saveDependant(makeDep(), KEY);
    // The relay copy: a new family label, no backdrop (the wire never carries one).
    const remote = makeDep({ displayName: 'Robin', updatedAt: Date.now() + 60_000 });
    const gap = deferred();
    const syncStarted = deferred();

    // The merge reads the record, then waits (an async gap, as a relay fetch
    // or a decrypt would) before it returns the merged copy.
    const sync = mutateDependant(GUARDIAN, ID, KEY, async local => {
      syncStarted.resolve();
      await gap.promise;
      return mergeDependantWithLocal(remote, local, 12345);
    }, { create: true });
    await syncStarted.promise;
    // A backdrop save fired while the merge is mid-flight.
    const backdrop = mutateDependant(GUARDIAN, ID, KEY, dep => dep && {
      ...dep,
      persona: { ...dep.persona, backdropHash: HASH_A, backdropBlossomUrl: 'https://blossom.example', backdropUpdatedAt: 5 },
    });
    gap.resolve();
    await Promise.all([sync, backdrop]);

    const after = await stored();
    expect(after?.displayName).toBe('Robin');
    expect(after?.persona.backdropHash).toBe(HASH_A);
  });

  it('a backdrop write that started first is not undone by a sync merge behind it', async () => {
    await saveDependant(makeDep(), KEY);
    const remote = makeDep({ displayName: 'Robin', updatedAt: Date.now() + 60_000 });
    const gap = deferred();
    const started = deferred();
    const backdrop = mutateDependant(GUARDIAN, ID, KEY, async dep => {
      started.resolve();
      await gap.promise;
      return dep && { ...dep, persona: { ...dep.persona, backdropHash: HASH_A, backdropBlossomUrl: 'https://blossom.example' } };
    });
    await started.promise;
    const sync = mutateDependant(GUARDIAN, ID, KEY, local => mergeDependantWithLocal(remote, local, 12345), { create: true });
    gap.resolve();
    await Promise.all([backdrop, sync]);

    const after = await stored();
    expect(after?.displayName).toBe('Robin');
    expect(after?.persona.backdropHash).toBe(HASH_A);
  });

  it('an avatar write and a backdrop write on the same slot both land', async () => {
    await saveDependant(makeDep(), KEY);
    const gap = deferred();
    const started = deferred();
    const avatar = mutateDependant(GUARDIAN, ID, KEY, async dep => {
      started.resolve();
      await gap.promise;
      return dep && { ...dep, persona: { ...dep.persona, avatarHash: HASH_B, avatarBlossomUrl: 'https://blossom.example' } };
    });
    await started.promise;
    const backdrop = mutateDependant(GUARDIAN, ID, KEY, dep => dep && {
      ...dep,
      persona: { ...dep.persona, backdropHash: HASH_A, backdropBlossomUrl: 'https://blossom.example' },
    });
    gap.resolve();
    await Promise.all([avatar, backdrop]);

    const after = await stored();
    expect(after?.persona.avatarHash).toBe(HASH_B);
    expect(after?.persona.backdropHash).toBe(HASH_A);
  });

  it('never creates a record from null unless asked to', async () => {
    await expect(mutateDependant(GUARDIAN, ID, KEY, () => makeDep())).rejects.toThrow('Dependant not found');
    expect(await stored()).toBeUndefined();
    // A mutator that writes nothing for a missing record resolves null.
    expect(await mutateDependant(GUARDIAN, ID, KEY, dep => dep)).toBeNull();
    // The sync merges create dependants another device added.
    const created = await mutateDependant(GUARDIAN, ID, KEY, () => makeDep(), { create: true });
    expect(created?.id).toBe(ID);
    expect((await stored())?.displayName).toBe('Kid');
  });

  it('refuses a record of another guardian and a changed id', async () => {
    await saveDependant(makeDep(), KEY);
    await expect(mutateDependant('b'.repeat(64), ID, KEY, dep => dep)).rejects.toThrow('Dependant not found');
    await expect(mutateDependant(GUARDIAN, ID, KEY, dep => dep && { ...dep, id: 'e'.repeat(64) })).rejects.toThrow('cannot change its id');
  });

  it('throws, and never creates over it, when the stored record cannot be decrypted', async () => {
    await saveDependant(makeDep({ persona: { publicKey: PERSONA, privateKey: 'f'.repeat(64), displayName: 'Kiddo' } }), KEY);
    let called = false;
    await expect(mutateDependant(GUARDIAN, ID, 'x'.repeat(64), () => { called = true; return makeDep(); }, { create: true })).rejects.toThrow();
    expect(called).toBe(false);
    expect((await stored())?.persona.privateKey).toBe('f'.repeat(64));
  });

  it('refuses a nested write from a mutator without deadlocking the queue', async () => {
    await saveDependant(makeDep(), KEY);
    let nested: Promise<unknown> | undefined;
    const outer = mutateDependant(GUARDIAN, ID, KEY, dep => {
      nested = saveDependant(makeDep({ displayName: 'Nested' }), KEY).catch((e: unknown) => e);
      return dep && { ...dep, displayName: 'Outer' };
    });
    await expect(outer).resolves.toMatchObject({ displayName: 'Outer' });
    const err = await nested;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('not re-entrant');
    expect((await stored())?.displayName).toBe('Outer');
    // The queue is still alive: later writers of every kind run.
    await mutateDependant(GUARDIAN, ID, KEY, dep => dep && { ...dep, displayName: 'Later' });
    expect((await stored())?.displayName).toBe('Later');
    await clearChildDevice(ID);
    await deleteDependant(ID);
    expect(await stored()).toBeUndefined();
  });

  it('a mutator that throws writes nothing and leaves the queue running', async () => {
    await saveDependant(makeDep(), KEY);
    await expect(mutateDependant(GUARDIAN, ID, KEY, () => { throw new Error('nope'); })).rejects.toThrow('nope');
    expect((await stored())?.displayName).toBe('Kid');
    await mutateDependant(GUARDIAN, ID, KEY, dep => dep && { ...dep, displayName: 'After' });
    expect((await stored())?.displayName).toBe('After');
  });
});
