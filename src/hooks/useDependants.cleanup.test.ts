// @vitest-environment jsdom
// Blob and row cleanup on removal and on unpair (gap 1).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { openDB } from 'idb';
import { useDependants } from './useDependants';
import { saveIdentityEncrypted, getDependants, purgeAllUserData, setCardBackdrop, listBlobOrphanRows } from '../lib/db';
import { createNewIdentity } from '../lib/signet';
import type { SignetIdentity } from '../types';
import { deleteOwnedBlob, type DeleteOutcome } from '../lib/blob-deletion';
import { AVATAR_UPLOADER_DOMAIN, BACKDROP_UPLOADER_DOMAIN } from '../lib/blossom-uploader';

const KEY = 'a'.repeat(64);
const NP = '1'.repeat(64);
const PERSONA = '2'.repeat(64);
const EXTRA = '3'.repeat(64);
const SERVER = 'https://nostr.download';
const h = (n: string) => n.repeat(64);
const av = (n: string) => ({ hash: h(n), blossomUrl: SERVER, keyHex: h(n), updatedAt: 7 });
const bd = (n: string) => ({ hash: h(n), blossomUrl: SERVER, keyHex: h(n), updatedAt: 9, sentDigest: 'd'.repeat(64) });

async function seedGuardian(): Promise<SignetIdentity> {
  const id = createNewIdentity('Guardian', 'natural-person', false);
  const identity: SignetIdentity = { ...id, mnemonic: '', naturalPerson: { ...id.naturalPerson, privateKey: '' }, persona: { ...id.persona, privateKey: '' } };
  await saveIdentityEncrypted(identity, KEY);
  return identity;
}

type Call = [domain: string, hash: string, server: string];

/**
 * A dependant "Robin" with a persona, an extra and a real-name slot, each
 * holding an avatar and a backdrop pointer (distinct hashes 4/5, 6/7, 8/9).
 */
async function setup(deleteBlob: (...c: Call) => Promise<DeleteOutcome>) {
  const g = await seedGuardian();
  const hook = renderHook(({ k }: { k: string | null }) => useDependants(g.naturalPerson.publicKey, g.id, k, { deleteBlob }), { initialProps: { k: KEY as string | null } });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  let dep!: Awaited<ReturnType<typeof hook.result.current.addDependant>>;
  await act(async () => {
    dep = await hook.result.current.addDependant('Robin', undefined, { deviceDerive: async () => ({
      naturalPerson: { publicKey: NP, privateKey: '' as const }, persona: { publicKey: PERSONA, privateKey: '' as const },
    }) });
  });
  await act(async () => {
    await hook.result.current.addDependantPersona(dep.id, 'Games', undefined, { deviceDerive: async () => ({ publicKey: EXTRA, privateKey: '' as const }) });
    // A backdrop pointer is only ever saved for a dependant with a paired phone.
    await hook.result.current.mutateDependantRecord(dep.id, KEY, d => d && ({
      ...d, bunkerEndpoint: { publicKey: 'e'.repeat(64), privateKey: 'f'.repeat(64), createdAt: 1, authorizedClientPubkey: 'c'.repeat(64) },
    }));
  });
  for (const [target, a, b] of [['persona', '4', '5'], [EXTRA, '6', '7'], ['natural-person', '8', '9']] as const) {
    await act(async () => {
      await hook.result.current.setDependantPersonaAvatar(dep.id, target, av(a));
      await hook.result.current.setDependantPersonaBackdrop(dep.id, target, bd(b));
    });
  }
  return { g, hook, dep };
}

const orphanHashes = async () => (await listBlobOrphanRows()).map(r => (r as { hash: string }).hash).sort();
const stored = async (g: SignetIdentity) => (await getDependants(g.naturalPerson.publicKey, KEY))[0];

describe('removeDependant: blob cleanup', () => {
  beforeEach(async () => { await purgeAllUserData(); });

  it('deletes every slot\'s avatar AND backdrop blob, only after the record is gone', async () => {
    const seenAfterDelete: boolean[] = [];
    let g!: SignetIdentity;
    const calls: Call[] = [];
    const del = vi.fn(async (...c: Call): Promise<DeleteOutcome> => {
      calls.push(c);
      seenAfterDelete.push((await getDependants(g.naturalPerson.publicKey, KEY)).length === 0);
      return 'deleted';
    });
    const s = await setup(del);
    g = s.g;
    let out!: Awaited<ReturnType<typeof s.hook.result.current.removeDependant>>;
    await act(async () => { out = await s.hook.result.current.removeDependant(s.dep.id); });
    await out.deletion;

    expect(calls.map(c => `${c[0] === AVATAR_UPLOADER_DOMAIN ? 'avatar' : c[0] === BACKDROP_UPLOADER_DOMAIN ? 'backdrop' : '?'}:${c[1][0]}`).sort())
      .toEqual(['avatar:4', 'avatar:6', 'avatar:8', 'backdrop:5', 'backdrop:7', 'backdrop:9']);
    expect(calls.every(c => c[2] === SERVER)).toBe(true);
    expect(seenAfterDelete.every(Boolean)).toBe(true);
    expect(await orphanHashes()).toEqual([]);
  }, 60_000);

  it('collects a blob saved while the removal was under way (read inside the deleting step, not before)', async () => {
    const calls: Call[] = [];
    const del = vi.fn(async (...c: Call): Promise<DeleteOutcome> => { calls.push(c); return 'deleted'; });
    const s = await setup(del);
    let out!: Awaited<ReturnType<typeof s.hook.result.current.removeDependant>>;
    await act(async () => {
      const removing = s.hook.result.current.removeDependant(s.dep.id);
      // Queued behind the removal's own read, so it lands before the row is deleted.
      const saving = s.hook.result.current.setDependantPersonaAvatar(s.dep.id, 'persona', av('a'));
      await saving;
      out = await removing;
    });
    await out.deletion;
    expect(calls.map(c => c[1])).toContain(h('a'));
    expect(await orphanHashes()).toEqual([]);
  }, 60_000);

  it('keeps a blob the deleter reports as still referenced (R1), and records nothing for it', async () => {
    const del = vi.fn(async (_d: string, hash: string): Promise<DeleteOutcome> => (hash === h('5') ? 'kept' : 'deleted'));
    const s = await setup(del);
    let out!: Awaited<ReturnType<typeof s.hook.result.current.removeDependant>>;
    await act(async () => { out = await s.hook.result.current.removeDependant(s.dep.id); });
    await out.deletion;
    expect(del).toHaveBeenCalledTimes(6);
    expect(await orphanHashes()).toEqual([]);
  }, 60_000);

  it('R1 with the real deleter: a blob another stored dependant still references never gets a DELETE; the rest do', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const del = (domain: string, hash: string, server: string) => deleteOwnedBlob({ hash, server, domain, encryptionKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    const s = await setup(del);
    // A second dependant whose persona shares Robin's persona avatar bytes (same hash).
    let sam!: Awaited<ReturnType<typeof s.hook.result.current.addDependant>>;
    await act(async () => {
      sam = await s.hook.result.current.addDependant('Sam', undefined, { deviceDerive: async () => ({
        naturalPerson: { publicKey: 'd'.repeat(64), privateKey: '' as const }, persona: { publicKey: 'e'.repeat(64), privateKey: '' as const },
      }) });
    });
    await act(async () => { await s.hook.result.current.setDependantPersonaAvatar(sam.id, 'persona', av('4')); });
    let out!: Awaited<ReturnType<typeof s.hook.result.current.removeDependant>>;
    await act(async () => { out = await s.hook.result.current.removeDependant(s.dep.id); });
    await out.deletion;
    const deletedHashes = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)
      .filter(c => c[1]?.method === 'DELETE').map(c => c[0].split('/').pop()).sort();
    expect(deletedHashes).toEqual(['5', '6', '7', '8', '9'].map(h).sort());
    expect(deletedHashes).not.toContain(h('4'));
    expect(await orphanHashes()).toEqual([]);
  }, 90_000);

  it('the handover path (keepBlobs) deletes nothing but still removes the record', async () => {
    const del = vi.fn(async (): Promise<DeleteOutcome> => 'deleted');
    const s = await setup(del);
    let out!: Awaited<ReturnType<typeof s.hook.result.current.removeDependant>>;
    await act(async () => { out = await s.hook.result.current.removeDependant(s.dep.id, { keepBlobs: true }); });
    await out.deletion;
    expect(del).not.toHaveBeenCalled();
    expect(await getDependants(s.g.naturalPerson.publicKey, KEY)).toEqual([]);
    expect(await orphanHashes()).toEqual([]);
  }, 60_000);

  it('a lock that lands mid-removal records the blobs it could not delete as orphans', async () => {
    let rerender!: (p: { k: string | null }) => void;
    const del = vi.fn(async (): Promise<DeleteOutcome> => {
      // The lock lands while the first delete is in flight: the deleter answers `kept` (no key).
      await act(async () => { rerender({ k: null }); });
      return 'kept';
    });
    const s = await setup(del);
    rerender = s.hook.rerender;
    // Not wrapped in act: the lock's re-render has to flush its effect mid-removal.
    const out = await s.hook.result.current.removeDependant(s.dep.id);
    await out.deletion;
    expect(del).toHaveBeenCalledTimes(1);
    expect(await orphanHashes()).toEqual(['4', '5', '6', '7', '8', '9'].map(h).sort());
  }, 60_000);

  it('a failed delete is recorded for the sweep and never fails the removal', async () => {
    const del = vi.fn(async (_d: string, hash: string): Promise<DeleteOutcome> => (hash === h('7') ? 'failed' : 'deleted'));
    const s = await setup(del);
    let out!: Awaited<ReturnType<typeof s.hook.result.current.removeDependant>>;
    await act(async () => { out = await s.hook.result.current.removeDependant(s.dep.id); });
    await out.deletion;
    expect(await orphanHashes()).toEqual([h('7')]);
    expect(await getDependants(s.g.naturalPerson.publicKey, KEY)).toEqual([]);
  }, 60_000);
});

describe('removeDependantExtraPersona: blob cleanup', () => {
  beforeEach(async () => { await purgeAllUserData(); });

  it('deletes only that persona\'s avatar and backdrop, after it left the record', async () => {
    let g!: SignetIdentity;
    const calls: Array<[string, string, boolean]> = [];
    const del = vi.fn(async (d: string, hash: string): Promise<DeleteOutcome> => {
      const extras = (await stored(g)).extraPersonas ?? [];
      calls.push([d, hash, extras.length === 0]);
      return 'deleted';
    });
    const s = await setup(del);
    g = s.g;
    let out!: Awaited<ReturnType<typeof s.hook.result.current.removeDependantExtraPersona>>;
    await act(async () => { out = await s.hook.result.current.removeDependantExtraPersona(s.dep.id, EXTRA); });
    await out.deletion;
    expect(calls.map(c => c[1]).sort()).toEqual([h('6'), h('7')]);
    expect(calls.every(c => c[2])).toBe(true);
    const rec = await stored(g);
    expect(rec.persona.avatarHash).toBe(h('4'));
    expect(rec.persona.backdropHash).toBe(h('5'));
  }, 60_000);
});

describe('unpair: sent backdrops', () => {
  beforeEach(async () => { await purgeAllUserData(); });

  async function ownRows(): Promise<string[]> {
    const raw = await openDB('my-signet');
    try { return (await raw.getAllKeys('preferences')).filter((k): k is string => typeof k === 'string' && k.startsWith('backdrop:')).sort(); }
    finally { raw.close(); }
  }

  async function expectBackdropsCleared(g: SignetIdentity) {
    const rec = await stored(g);
    for (const slot of [rec.naturalPerson, rec.persona, rec.extraPersonas![0]]) {
      expect(slot).toMatchObject({ backdropHash: undefined, backdropBlossomUrl: undefined, backdropKey: undefined, backdropUpdatedAt: undefined, backdropSentDigest: undefined });
    }
    // Avatars are untouched.
    expect(rec.persona.avatarHash).toBe(h('4'));
    expect(rec.extraPersonas![0].avatarHash).toBe(h('6'));
    expect(rec.naturalPerson.avatarHash).toBe(h('8'));
  }

  it('direct-to-Heartwood unpair (clearDependantBackdrops): clears every pointer, deletes only backdrop blobs, keeps the guardian\'s own rows', async () => {
    const calls: Call[] = [];
    const del = vi.fn(async (...c: Call): Promise<DeleteOutcome> => { calls.push(c); return 'deleted'; });
    const s = await setup(del);
    for (const pk of [PERSONA, EXTRA, NP]) await setCardBackdrop(pk, new Blob(['x'], { type: 'image/jpeg' }));
    await act(async () => { await s.hook.result.current.clearDependantBackdrops(s.dep.id); });
    await waitFor(() => expect(calls.length).toBe(3));
    expect(calls.map(c => c[1]).sort()).toEqual([h('5'), h('7'), h('9')]);
    expect(calls.every(c => c[0] === BACKDROP_UPLOADER_DOMAIN)).toBe(true);
    await expectBackdropsCleared(s.g);
    expect(await ownRows()).toEqual([`backdrop:${NP}`, `backdrop:${PERSONA}`, `backdrop:${EXTRA}`].sort());
  }, 60_000);

  it('legacy phone-paired unpair (clearDependantBunkerEndpoint): drops the endpoint and the same pointers and blobs', async () => {
    const calls: Call[] = [];
    const del = vi.fn(async (...c: Call): Promise<DeleteOutcome> => { calls.push(c); return 'deleted'; });
    const s = await setup(del);
    for (const pk of [PERSONA, EXTRA, NP]) await setCardBackdrop(pk, new Blob(['x'], { type: 'image/jpeg' }));
    await act(async () => {
      await s.hook.result.current.mutateDependantRecord(s.dep.id, KEY, d => d && ({
        ...d, bunkerEndpoint: { publicKey: 'e'.repeat(64), privateKey: 'f'.repeat(64), createdAt: 1, authorizedClientPubkey: 'c'.repeat(64) },
      }));
    });
    expect((await stored(s.g)).bunkerEndpoint).toBeDefined();
    await act(async () => { await s.hook.result.current.clearDependantBunkerEndpoint(s.dep.id, KEY); });
    await waitFor(() => expect(calls.length).toBe(3));
    expect(calls.map(c => c[1]).sort()).toEqual([h('5'), h('7'), h('9')]);
    expect((await stored(s.g)).bunkerEndpoint).toBeUndefined();
    await expectBackdropsCleared(s.g);
    expect(await ownRows()).toHaveLength(3);
  }, 60_000);

  it('an unpair outranks a backdrop upload still in flight: it saves no pointer afterwards', async () => {
    const del = vi.fn(async (): Promise<DeleteOutcome> => 'deleted');
    const s = await setup(del);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { sendBackdropToChild } = await import('../lib/backdrop-send');
    const sending = sendBackdropToChild(new Blob(['pic']), {
      slotKey: `${s.dep.id}:persona`, encryptionKey: KEY, getKey: () => KEY, blossomUrl: SERVER, blossomConsent: true,
      upload: async () => { await gate; return { hash: h('a'), blossomUrl: SERVER, keyHex: h('a'), updatedAt: 1 }; },
      saveSlot: (meta, digest) => s.hook.result.current.setDependantPersonaBackdrop(s.dep.id, 'persona', meta ? { ...meta, sentDigest: digest } : null),
      deleteBlob: del,
    });
    await act(async () => { await s.hook.result.current.clearDependantBackdrops(s.dep.id); });
    release();
    const res = await sending;
    expect(res.ok).toBe(false);
    expect((await stored(s.g)).persona.backdropHash).toBeUndefined();
  }, 60_000);

  it('a dependant that never sent a backdrop is left alone (nothing written, nothing deleted)', async () => {
    const del = vi.fn(async (): Promise<DeleteOutcome> => 'deleted');
    const s = await setup(del);
    await act(async () => { await s.hook.result.current.clearDependantBackdrops(s.dep.id); });
    del.mockClear();
    const before = await stored(s.g);
    await act(async () => { await s.hook.result.current.clearDependantBackdrops(s.dep.id); });
    expect(del).not.toHaveBeenCalled();
    expect((await stored(s.g)).updatedAt).toBe(before.updatedAt);
  }, 60_000);
});
