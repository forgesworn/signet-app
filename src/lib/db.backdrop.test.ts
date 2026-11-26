import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

// A fully isolated IndexedDB per test, and a fresh db singleton.
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
});

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const jpeg = (t: string) => new Blob([t], { type: 'image/jpeg' });

describe('card backdrop rows, against a real store', () => {
  it('the guardian row round-trips its blob and hash, and deletes', async () => {
    const db = await import('./db');
    expect(await db.getGuardianBackdrop(A)).toBeNull();
    await db.setGuardianBackdrop(A, jpeg('g'), 'h'.repeat(64));
    const got = await db.getGuardianBackdrop(A);
    expect(got?.hash).toBe('h'.repeat(64));
    expect(got?.blob).toBeInstanceOf(Blob);
    expect(got?.blob.size).toBe(1);
    await db.deleteGuardianBackdrop(A);
    expect(await db.getGuardianBackdrop(A)).toBeNull();
  });

  it('the guardian row and the child\'s own row for one pubkey are independent', async () => {
    const db = await import('./db');
    await db.setCardBackdrop(A, jpeg('own'));
    await db.setGuardianBackdrop(A, jpeg('guardian'), 'h'.repeat(64));
    expect((await db.getCardBackdrop(A))?.size).toBe(3);
    expect((await db.getGuardianBackdrop(A))?.blob.size).toBe(8);
    await db.deleteGuardianBackdrop(A);
    expect(await db.getCardBackdrop(A)).not.toBeNull();
    await db.setGuardianBackdrop(A, jpeg('guardian'), 'h'.repeat(64));
    await db.deleteCardBackdrop(A);
    expect(await db.getGuardianBackdrop(A)).not.toBeNull();
  });

  it('ignores a guardian row that has no hash or no blob', async () => {
    const db = await import('./db');
    const raw = await db.getDb();
    await raw.put('preferences', { id: `backdrop-guardian:${A}`, blob: jpeg('x') });
    expect(await db.getGuardianBackdrop(A)).toBeNull();
    await raw.put('preferences', { id: `backdrop-guardian:${B}`, hash: 'h' });
    expect(await db.getGuardianBackdrop(B)).toBeNull();
  });

  it('lists each kind\'s pubkeys by its own prefix, never mixing the two or picking up other preference rows', async () => {
    const db = await import('./db');
    const raw = await db.getDb();
    await raw.put('preferences', { id: 'current', theme: 'dark' });
    await raw.put('preferences', { id: 'backdrops-not-ours', x: 1 });
    await db.setCardBackdrop(A, jpeg('own'));
    await db.setCardBackdrop(B, jpeg('own'));
    await db.setGuardianBackdrop(B, jpeg('g'), 'h'.repeat(64));
    await db.setGuardianBackdrop(C, jpeg('g'), 'h'.repeat(64));
    const rows = await db.listBackdropRowPubkeys();
    expect([...rows.own].sort()).toEqual([A, B]);
    expect([...rows.guardian].sort()).toEqual([B, C]);
  });

  it('lists nothing on an empty store', async () => {
    const db = await import('./db');
    expect(await db.listBackdropRowPubkeys()).toEqual({ own: [], guardian: [] });
  });

  it('a full purge of user data removes both kinds', async () => {
    const db = await import('./db');
    await db.setCardBackdrop(A, jpeg('own'));
    await db.setGuardianBackdrop(A, jpeg('g'), 'h'.repeat(64));
    await db.purgeAllUserData();
    expect(await db.listBackdropRowPubkeys()).toEqual({ own: [], guardian: [] });
  });
});
