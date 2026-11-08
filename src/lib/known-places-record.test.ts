// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { buildSignInKnownPlace, recordKnownPlace } from './known-places-record';
import * as db from './db';

const PK = 'a'.repeat(64);
const base = {
  origin: 'https://game.example',
  pubkey: PK,
  siteName: 'Game',
  channel: 'phone-app' as const,
  signer: 'local' as const,
  pictureShared: false,
};

describe('buildSignInKnownPlace', () => {
  it('keys the row by origin and records what was shared', () => {
    expect(buildSignInKnownPlace({ ...base, consumerDisplayName: 'My game', nativePackage: 'com.game', handleShared: 'Burner', pictureShared: true })).toEqual({
      placeKey: 'https://game.example',
      pubkey: PK,
      kind: 'sign-in',
      name: 'Game',
      alias: 'My game',
      origin: 'https://game.example',
      nativePackage: 'com.game',
      channel: 'phone-app',
      signer: 'local',
      shared: { handle: true, picture: true },
    });
  });

  it('omits alias and nativePackage when absent, and reads no handle as not shared', () => {
    const row = buildSignInKnownPlace({ ...base, nativePackage: null, handleShared: undefined });
    expect(row).not.toHaveProperty('alias');
    expect(row).not.toHaveProperty('nativePackage');
    expect(row.shared).toEqual({ handle: false, picture: false });
  });
});

describe('recordKnownPlace', () => {
  it('writes a row (both delivery paths share this builder + writer)', async () => {
    await db.purgeAllUserData();
    expect(await recordKnownPlace(buildSignInKnownPlace(base))).toBe(true);
    expect(await recordKnownPlace(buildSignInKnownPlace({ ...base, channel: 'browser' }))).toBe(true);
    const rows = await db.listKnownPlaces();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ uses: 2, channel: 'browser' });
  });

  it('never throws: a storage failure or a bad key is just false', async () => {
    expect(await recordKnownPlace({ ...buildSignInKnownPlace(base), pubkey: 'nope' })).toBe(false);
    const spy = vi.spyOn(db, 'upsertKnownPlace').mockRejectedValueOnce(new Error('quota'));
    expect(await recordKnownPlace(buildSignInKnownPlace(base))).toBe(false);
    spy.mockRestore();
  });
});
