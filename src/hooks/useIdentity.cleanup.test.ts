// @vitest-environment jsdom
// Deleting an owner persona deletes its in-app avatar and card backdrop blobs.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useIdentity } from './useIdentity';
import * as db from '../lib/db';
import type { SignetIdentity, ExtraPersona } from '../types';
import { deleteOwnedBlob, type DeleteOutcome } from '../lib/blob-deletion';
import { AVATAR_UPLOADER_DOMAIN, BACKDROP_UPLOADER_DOMAIN } from '../lib/blossom-uploader';

const KEY = 'k'.repeat(64);
const NP = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);
const GAMES = 'c'.repeat(64);
const IMPORTED = 'd'.repeat(64);
const SERVER = 'https://nostr.download';
const h = (n: string) => n.repeat(64);

type Call = [domain: string, hash: string, server: string];

function extra(publicKey: string, n: { avatar: string; backdrop: string; share?: string }, more: Partial<ExtraPersona> = {}): ExtraPersona {
  return {
    publicKey, privateKey: '', displayName: publicKey === GAMES ? 'Games' : 'Old', derivationName: publicKey === GAMES ? 'persona-1' : '',
    avatarHash: h(n.avatar), avatarBlossomUrl: SERVER, avatarKey: h(n.avatar), avatarUpdatedAt: 1,
    backdropHash: h(n.backdrop), backdropBlossomUrl: SERVER, backdropKey: h(n.backdrop), backdropUpdatedAt: 1,
    ...(n.share ? { contactAvatarHash: h(n.share), contactAvatarBlossomUrl: SERVER, contactAvatarKey: h(n.share) } : {}),
    ...more,
  };
}

async function setup(deleteBlob: (...c: Call) => Promise<DeleteOutcome>, extras: ExtraPersona[]) {
  const identity: SignetIdentity = {
    id: NP, mnemonic: '', primaryKeypair: 'persona', isChild: false, createdAt: 1_700_000_000, backedUp: true,
    naturalPerson: { publicKey: NP, privateKey: '', displayName: '' },
    persona: { publicKey: PERSONA, privateKey: '', displayName: 'Me', avatarHash: h('4'), avatarBlossomUrl: SERVER, avatarKey: h('4') },
    extraPersonas: extras,
  };
  await db.saveIdentityEncrypted(identity, KEY);
  const hook = renderHook(({ k }: { k: string | null }) => useIdentity(k, { deleteBlob }), { initialProps: { k: KEY as string | null } });
  await waitFor(() => expect(hook.result.current.identity).not.toBeNull());
  return hook;
}

const stored = async () => (await db.loadIdentityDecrypted(NP, KEY))!;
const orphanHashes = async () => (await db.listBlobOrphanRows()).map(r => (r as { hash: string }).hash).sort();

describe('useIdentity.removeExtraPersona: blob cleanup', () => {
  beforeEach(async () => { await db.purgeAllUserData(); });

  it('deletes only that persona\'s avatar and backdrop, after it left the stored record; never its share copy', async () => {
    const calls: Array<[...Call, boolean]> = [];
    const del = vi.fn(async (d: string, hash: string, server: string): Promise<DeleteOutcome> => {
      calls.push([d, hash, server, !(await stored()).extraPersonas?.some(p => p.publicKey === GAMES)]);
      return 'deleted';
    });
    const hook = await setup(del, [extra(GAMES, { avatar: '6', backdrop: '7', share: '5' }), extra(IMPORTED, { avatar: '8', backdrop: '9' }, { imported: true })]);
    let out!: { deletion: Promise<void> };
    await act(async () => { out = await hook.result.current.removeExtraPersona(GAMES); });
    await out.deletion;
    expect(calls.map(c => `${c[0] === AVATAR_UPLOADER_DOMAIN ? 'avatar' : c[0] === BACKDROP_UPLOADER_DOMAIN ? 'backdrop' : c[0]}:${c[1][0]}`).sort())
      .toEqual(['avatar:6', 'backdrop:7']);
    expect(calls.every(c => c[2] === SERVER && c[3])).toBe(true);
    const rec = await stored();
    expect(rec.extraPersonas?.map(p => p.publicKey)).toEqual([IMPORTED]);
    expect(rec.persona.avatarHash).toBe(h('4'));
    expect(await orphanHashes()).toEqual([]);
  }, 60_000);

  it('an imported extra goes the same way', async () => {
    const del = vi.fn(async (..._c: Call): Promise<DeleteOutcome> => 'deleted');
    const hook = await setup(del, [extra(IMPORTED, { avatar: '8', backdrop: '9' }, { imported: true })]);
    let out!: { deletion: Promise<void> };
    await act(async () => { out = await hook.result.current.removeExtraPersona(IMPORTED); });
    await out.deletion;
    expect(del.mock.calls.map(c => c[1]).sort()).toEqual([h('8'), h('9')]);
  }, 60_000);

  it('R1 with the real deleter: a blob another slot still shows gets no DELETE', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const del = (domain: string, hash: string, server: string) => deleteOwnedBlob({ hash, server, domain, encryptionKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    // Games shares the persona's avatar bytes (same hash '4').
    const hook = await setup(del, [extra(GAMES, { avatar: '4', backdrop: '7' })]);
    let out!: { deletion: Promise<void> };
    await act(async () => { out = await hook.result.current.removeExtraPersona(GAMES); });
    await out.deletion;
    const deleted = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)
      .filter(c => c[1]?.method === 'DELETE').map(c => c[0].split('/').pop());
    expect(deleted).toEqual([h('7')]);
    expect(await orphanHashes()).toEqual([]);
  }, 90_000);

  it('a failed delete is recorded as an orphan; the persona is still gone', async () => {
    const del = vi.fn(async (): Promise<DeleteOutcome> => 'failed');
    const hook = await setup(del, [extra(GAMES, { avatar: '6', backdrop: '7' })]);
    let out!: { deletion: Promise<void> };
    await act(async () => { out = await hook.result.current.removeExtraPersona(GAMES); });
    await out.deletion;
    expect(await orphanHashes()).toEqual([h('6'), h('7')]);
    expect((await stored()).extraPersonas ?? []).toEqual([]);
  }, 60_000);

  it('a failing deleter never fails the delete', async () => {
    const del = vi.fn(async (): Promise<DeleteOutcome> => { throw new Error('boom'); });
    const hook = await setup(del, [extra(GAMES, { avatar: '6', backdrop: '7' })]);
    let out!: { deletion: Promise<void> };
    await act(async () => { out = await hook.result.current.removeExtraPersona(GAMES); });
    await expect(out.deletion).resolves.toBeUndefined();
    expect((await stored()).extraPersonas ?? []).toEqual([]);
  }, 60_000);
});
