import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { ChildRulesPayload } from './child-rules-wire';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
});

const KEY = 'k'.repeat(64);
const DEP = 'ef'.repeat(32);
const PERSONA = 'ab'.repeat(32);

function payload(updatedAt: number): ChildRulesPayload {
  return { v: 1, dependantId: DEP, stage: 'request-approve', ceilingKinds: [1, 7], rules: [], disconnectedApps: [], updatedAt };
}

describe('child rules cache (encrypted identity-store row)', () => {
  it('round-trips encrypted, is null when absent or under the wrong key, and is not an identity', async () => {
    const db = await import('./db');
    expect(await db.loadChildRulesCache(DEP, KEY)).toBeNull();
    await db.saveChildRulesCache(DEP, payload(5), KEY);
    expect(await db.loadChildRulesCache(DEP, KEY)).toEqual(payload(5));
    expect(await db.loadChildRulesCache(DEP, 'x'.repeat(64))).toBeNull();
    expect(await db.getAllIdentities()).toEqual([]);
    expect(await db.cleanupUnencryptedIdentities()).toBe(0);
    await db.clearChildRulesCache(DEP);
    expect(await db.loadChildRulesCache(DEP, KEY)).toBeNull();
  });

  it('a cached payload for another dependant is not returned', async () => {
    const db = await import('./db');
    await db.saveChildRulesCache(DEP, payload(5), KEY);
    expect(await db.loadChildRulesCache('cd'.repeat(32), KEY)).toBeNull();
  });
});

describe('paired-child record, heartwood-direct fields', () => {
  it('persists mode, rail, persona, relays and approvals; legacy saves carry none of them', async () => {
    const db = await import('./db');
    await db.savePairedChild({
      bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example`,
      clientKeypair: { publicKey: 'a1'.repeat(32), privateKey: 'b2'.repeat(32) },
      dependantPubkey: DEP, dependantName: 'Alice', pairedAt: 1, guardianPubkey: 'cd'.repeat(32),
      hasPaired: true, mode: 'heartwood-direct', railPubkey: '12'.repeat(32), personaPubkey: PERSONA,
      hwRelays: ['wss://hw.example'], railRelay: 'wss://rail.example',
      personas: [{ pubkey: PERSONA, name: 'Ally', role: 'persona' }],
    }, KEY);
    const r = await db.loadPairedChild(DEP, KEY);
    expect(r).toMatchObject({ mode: 'heartwood-direct', railPubkey: '12'.repeat(32), personaPubkey: PERSONA,
      hwRelays: ['wss://hw.example'], railRelay: 'wss://rail.example', hasPaired: true });
    await db.setPairedChildIdentityApprovals(DEP, { ['34'.repeat(32)]: 'approved' });
    expect((await db.loadPairedChild(DEP, KEY))?.identityApprovals).toEqual({ ['34'.repeat(32)]: 'approved' });

    await db.savePairedChild({
      bunkerUri: 'bunker://' + 'cd'.repeat(32) + '?relay=wss%3A%2F%2Fr.example&secret=s',
      clientKeypair: { publicKey: 'a1'.repeat(32), privateKey: 'b2'.repeat(32) },
      dependantPubkey: '56'.repeat(32), dependantName: 'Bob', pairedAt: 1,
    }, KEY);
    const legacy = await db.loadPairedChild('56'.repeat(32), KEY);
    expect(legacy?.mode).toBeUndefined();
    expect(legacy?.personaPubkey).toBeUndefined();
  });

  it('refuses a direct record with a malformed persona or relay', async () => {
    const db = await import('./db');
    const base = {
      bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example`,
      clientKeypair: { publicKey: 'a1'.repeat(32), privateKey: 'b2'.repeat(32) },
      dependantPubkey: DEP, dependantName: 'Alice', pairedAt: 1, mode: 'heartwood-direct' as const,
      railPubkey: '12'.repeat(32), hwRelays: ['wss://hw.example'], railRelay: 'wss://rail.example',
    };
    await expect(db.savePairedChild({ ...base, personaPubkey: 'AB'.repeat(32) }, KEY)).rejects.toThrow();
    await expect(db.savePairedChild({ ...base, personaPubkey: PERSONA, railRelay: 'ws://evil.example' }, KEY)).rejects.toThrow();
  });
});
