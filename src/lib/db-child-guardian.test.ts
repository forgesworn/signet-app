import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { buildPersonaFirstDependant } from './dependant-record';
import type { DependantIdentity } from '../types';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
});

const KEY = 'k'.repeat(64);
const GUARDIAN = 'f'.repeat(64);
const DEP = 'ef'.repeat(32);

function makeDep(): DependantIdentity {
  return buildPersonaFirstDependant({
    guardianPubkey: GUARDIAN, enteredName: 'Lily', derivationPath: 'dependant-0',
    naturalPerson: { publicKey: getPublicKey(generateSecretKey()), privateKey: '' },
    persona: { publicKey: getPublicKey(generateSecretKey()), privateKey: '' },
    createdAt: 1_700_000_000,
  });
}

const CD = { mode: 'heartwood-direct' as const, slotLabel: 'signet:child-device:v2:x', secretFingerprint: 'ab'.repeat(32), slotIndex: 3,
  clientPubkey: 'c'.repeat(64), boundPersona: 'd'.repeat(64), pairedAt: 1, railRelay: 'wss://rail.example.com' };

describe('A25: childDevice survives generic saves; cleared only by clearChildDevice', () => {
  it('a save without childDevice keeps the stored one', async () => {
    const db = await import('./db');
    const dep = makeDep();
    await db.saveDependant({ ...dep, childDevice: CD, bunkerEndpoint: { publicKey: 'e'.repeat(64), privateKey: '1'.repeat(64), createdAt: 1, authorizedClientPubkey: CD.clientPubkey } }, KEY);
    const { childDevice: _c, ...generic } = (await db.getDependants(GUARDIAN, KEY))[0];
    void _c;
    await db.saveDependant({ ...generic, displayName: 'Lil' }, KEY);
    const after = (await db.getDependants(GUARDIAN, KEY))[0];
    expect(after.displayName).toBe('Lil');
    expect(after.childDevice).toEqual(CD);
  });
  it('clearChildDevice removes it and the matching authorizedClientPubkey', async () => {
    const db = await import('./db');
    const dep = makeDep();
    await db.saveDependant({ ...dep, childDevice: CD, bunkerEndpoint: { publicKey: 'e'.repeat(64), privateKey: '1'.repeat(64), createdAt: 1, authorizedClientPubkey: CD.clientPubkey } }, KEY);
    await db.clearChildDevice(dep.id);
    const after = (await db.getDependants(GUARDIAN, KEY))[0];
    expect(after.childDevice).toBeUndefined();
    expect(after.bunkerEndpoint?.authorizedClientPubkey).toBeUndefined();
    expect(after.bunkerEndpoint?.privateKey).toBe('1'.repeat(64));
  });
});

describe('guardian-local child-direct rows', () => {
  it('approved-once kinds round-trip encrypted and drop malformed entries', async () => {
    const db = await import('./db');
    expect(await db.loadChildApprovedOnce(KEY)).toEqual({});
    await db.saveChildApprovedOnce({ [DEP]: [{ kind: 7, until: 100 }, { kind: 70000, until: 1 } as never] }, KEY);
    expect(await db.loadChildApprovedOnce(KEY)).toEqual({ [DEP]: [{ kind: 7, until: 100 }] });
    expect(await db.loadChildApprovedOnce('x'.repeat(64))).toEqual({});
    expect(await db.getAllIdentities()).toEqual([]);
    expect(await db.cleanupUnencryptedIdentities()).toBe(0);
  });
  it('ask history round-trips', async () => {
    const db = await import('./db');
    expect(await db.loadChildAskHistory(KEY)).toEqual([]);
    await db.saveChildAskHistory([{ a: 1 }], KEY);
    expect(await db.loadChildAskHistory(KEY)).toEqual([{ a: 1 }]);
  });
  it('A24: pending revokes add (deduped), list and remove', async () => {
    const db = await import('./db');
    const rec = { label: 'signet:child-device:v2:x', slotIndex: 4, secretFingerprint: 'ab'.repeat(32), dependantId: DEP };
    await db.addPendingChildRevoke(rec, KEY);
    await db.addPendingChildRevoke(rec, KEY);
    expect(await db.listPendingChildRevokes(KEY)).toEqual([rec]);
    await db.removePendingChildRevoke({ slotIndex: 4, secretFingerprint: 'AB'.repeat(32) }, KEY);
    expect(await db.listPendingChildRevokes(KEY)).toEqual([]);
  });
});
