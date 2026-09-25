import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { ContactOperation, ContactRecord } from '../types';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
});

const KEY = 'correct-horse-battery-staple';
const TIMEOUT = 45_000;
const CID = '0'.repeat(32);
const DEP = 'b'.repeat(64);

function op(overrides: Partial<ContactOperation> & { operationId: string }): ContactOperation {
  return {
    directoryId: 'owner',
    contactId: CID,
    actorPubkey: '1'.repeat(64),
    actorRole: 'owner',
    actorDeviceId: 'd'.repeat(32),
    logicalClock: 1,
    action: 'add',
    value: { type: 'person', displayName: 'Dave', tier: 'kith' },
    createdAt: 1_000,
    ...overrides,
  };
}

function record(): ContactRecord {
  return {
    directoryId: 'owner', contactId: CID, type: 'person', displayName: 'Dave', tier: 'kith',
    roles: [], identities: [], contactMethods: [], accessGrants: [], lifecycle: 'active',
    createdAt: 1_000, updatedAt: 1_000, createdByActorRole: 'owner', createdByOperationId: 'a'.repeat(32),
    vouches: [], ceilings: [], blocks: [],
    notes: 'private note',
  };
}

describe('contact operations v2 storage', () => {
  it('round-trips an operation and keeps its body off the clear record', async () => {
    const db = await import('./db');
    await db.saveContactOperationV2(op({ operationId: 'a'.repeat(32) }), KEY);

    const raw = await db.getDb();
    const stored = await raw.get('contactOpsV2', 'a'.repeat(32));
    expect(stored.directoryId).toBe('owner');
    expect(stored.logicalClock).toBe(1);
    expect(stored.encrypted).toBe(true);
    expect(stored.action).toBeUndefined();
    expect(stored.value).toBeUndefined();
    expect(stored.actorPubkey).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('Dave');

    const [loaded] = await db.listContactOperationsV2('owner', KEY);
    expect(loaded.action).toBe('add');
    expect(loaded.actorPubkey).toBe('1'.repeat(64));
    expect(loaded.value).toEqual({ type: 'person', displayName: 'Dave', tier: 'kith' });
  }, TIMEOUT);

  it('refuses to save without an encryption key', async () => {
    const db = await import('./db');
    await expect(db.saveContactOperationV2(op({ operationId: 'b'.repeat(32) }), '')).rejects.toThrow(/key/i);
  }, TIMEOUT);

  it('scopes a listing to one directory and lists every directory on demand', async () => {
    const db = await import('./db');
    await db.saveContactOperationV2(op({ operationId: 'c'.repeat(32) }), KEY);
    await db.saveContactOperationV2(op({ operationId: 'd'.repeat(32), directoryId: `dependant:${DEP}` }), KEY);
    expect(await db.listContactOperationsV2('owner', KEY)).toHaveLength(1);
    expect(await db.listContactOperationsV2(`dependant:${DEP}`, KEY)).toHaveLength(1);
    expect(await db.listAllContactOperationsV2(KEY)).toHaveLength(2);
  }, TIMEOUT);

  // M1: the clear routing fields are what the index and the reducer address a
  // row by, so the encrypted body must never be able to overwrite them.
  it('lets the clear routing fields win over a tampered encrypted body', async () => {
    const db = await import('./db');
    const real = op({ operationId: 'a1'.repeat(16) });
    await db.saveContactOperationV2(real, KEY);

    // Re-encrypt a body that claims to be a DIFFERENT operation in a different
    // directory, and put it back under the real row's clear key.
    const raw = await db.getDb();
    const stored = await raw.get('contactOpsV2', 'a1'.repeat(16));
    const crypto = await import('./crypto-store');
    const forged = await crypto.encryptSecret(JSON.stringify({
      operationId: 'b2'.repeat(16),
      directoryId: 'dependant:0',
      contactId: '9'.repeat(32),
      logicalClock: 99,
      createdAt: 99,
      actorPubkey: '1'.repeat(64),
      actorRole: 'owner',
      actorDeviceId: 'd'.repeat(32),
      action: 'add',
      value: { type: 'person', displayName: 'Mallory', tier: 'kin' },
    }), KEY);
    await raw.put('contactOpsV2', { ...stored, encryptedData: forged });

    const [loaded] = await db.listContactOperationsV2('owner', KEY);
    expect(loaded.operationId).toBe('a1'.repeat(16));
    expect(loaded.directoryId).toBe('owner');
    expect(loaded.contactId).toBe(CID);
    expect(loaded.logicalClock).toBe(1);
    expect(loaded.createdAt).toBe(1_000);
    // The body's own (sensitive) fields still come from the ciphertext.
    expect(loaded.value).toEqual({ type: 'person', displayName: 'Mallory', tier: 'kin' });
  }, TIMEOUT);

  it('drops an undecryptable or invalid row instead of throwing', async () => {
    const db = await import('./db');
    await db.saveContactOperationV2(op({ operationId: 'e'.repeat(32) }), KEY);
    const raw = await db.getDb();
    await raw.put('contactOpsV2', { operationId: 'f'.repeat(32), directoryId: 'owner', contactId: CID, logicalClock: 2, createdAt: 2, encrypted: true, encryptedData: 'not-base64-ciphertext' });
    const loaded = await db.listContactOperationsV2('owner', KEY);
    expect(loaded.map(o => o.operationId)).toEqual(['e'.repeat(32)]);
  }, TIMEOUT);

  // I2 perf fix: saveContactOperationsV2 batches the PBKDF2 derivation.
  describe('batch save (I2)', () => {
    it('round-trips a whole batch through the bulk save and both list readers', async () => {
      const db = await import('./db');
      const batch = Array.from({ length: 5 }, (_, i) => op({
        operationId: (i + 1).toString(16).padStart(32, '0'),
        logicalClock: i + 1,
        value: { type: 'person', displayName: `Row ${i}`, tier: 'kith' },
      }));
      await db.saveContactOperationsV2(batch, KEY);

      const raw = await db.getDb();
      const rows = await raw.getAll('contactOpsV2');
      expect(rows).toHaveLength(5);
      // Same per-row shape as a singular save — clear routing fields out,
      // body encrypted, nothing sensitive leaked into the clear record.
      for (const row of rows) {
        expect(row.encrypted).toBe(true);
        expect(row.value).toBeUndefined();
        expect(JSON.stringify(row)).not.toContain('Row');
      }

      const all = await db.listAllContactOperationsV2(KEY);
      expect(all.map(o => o.operationId).sort()).toEqual(batch.map(o => o.operationId).sort());
      const scoped = await db.listContactOperationsV2('owner', KEY);
      expect(scoped).toHaveLength(5);
      expect(scoped.find(o => o.operationId === batch[2].operationId)!.value)
        .toEqual({ type: 'person', displayName: 'Row 2', tier: 'kith' });
    }, TIMEOUT);

    it('is a no-op for an empty batch and still requires an encryption key', async () => {
      const db = await import('./db');
      await db.saveContactOperationsV2([], KEY); // no throw, nothing written
      expect(await db.listAllContactOperationsV2(KEY)).toHaveLength(0);
      await expect(db.saveContactOperationsV2([op({ operationId: 'a'.repeat(32) })], ''))
        .rejects.toThrow(/key/i);
    }, TIMEOUT);

    it('reads correctly when singular- and batch-saved rows share one store', async () => {
      const db = await import('./db');
      const single = op({ operationId: '1'.repeat(32), logicalClock: 1 });
      const batchOps = [
        op({ operationId: '2'.repeat(32), logicalClock: 2 }),
        op({ operationId: '3'.repeat(32), logicalClock: 3 }),
      ];
      // Interleaved on purpose — a batch row's shared salt must not affect
      // (or be affected by) a singularly-saved row's own independent salt.
      await db.saveContactOperationV2(single, KEY);
      await db.saveContactOperationsV2(batchOps, KEY);
      await db.saveContactOperationV2(op({ operationId: '4'.repeat(32), logicalClock: 4 }), KEY);

      const loaded = await db.listAllContactOperationsV2(KEY);
      expect(loaded.map(o => o.operationId).sort()).toEqual(['1'.repeat(32), '2'.repeat(32), '3'.repeat(32), '4'.repeat(32)].sort());
    }, TIMEOUT);

    // I2: the whole point — one PBKDF2 derivation per batch call, not one
    // per row. `vi.doMock` (not the hoisted `vi.mock`) applies from here
    // onward, matching this file's per-test `vi.resetModules()` isolation:
    // the dynamic `import('./db')` below re-resolves `aes-crypto` fresh,
    // picking up this mock.
    it('derives the key once per batch call, not once per row', async () => {
      vi.doMock('./aes-crypto', async (importOriginal) => {
        const actual = await importOriginal<typeof import('./aes-crypto')>();
        return { ...actual, deriveAesKey: vi.fn(actual.deriveAesKey) };
      });
      const aesCrypto = await import('./aes-crypto');
      const db = await import('./db');
      const deriveSpy = vi.mocked(aesCrypto.deriveAesKey);

      const batch = Array.from({ length: 6 }, (_, i) => op({
        operationId: (i + 5).toString(16).padStart(32, '0'),
        logicalClock: i + 1,
      }));
      await db.saveContactOperationsV2(batch, KEY);
      expect(deriveSpy).toHaveBeenCalledTimes(1);

      deriveSpy.mockClear();
      const loaded = await db.listAllContactOperationsV2(KEY);
      expect(loaded).toHaveLength(6);
      expect(deriveSpy).toHaveBeenCalledTimes(1);
    }, TIMEOUT);
  });
});

describe('contact records v2 storage', () => {
  it('round-trips a record with its body encrypted', async () => {
    const db = await import('./db');
    await db.saveContactRecordV2(record(), KEY);
    const raw = await db.getDb();
    const stored = await raw.get('contactRecordsV2', ['owner', CID]);
    expect(stored.encrypted).toBe(true);
    expect(stored.updatedAt).toBe(1_000);
    expect(stored.displayName).toBeUndefined();
    expect(stored.tier).toBeUndefined();
    expect(stored.identities).toBeUndefined();
    expect(stored.notes).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('private note');

    const [loaded] = await db.listContactRecordsV2('owner', KEY);
    expect(loaded.displayName).toBe('Dave');
    expect(loaded.notes).toBe('private note');
    expect(loaded.contactId).toBe(CID);
  }, TIMEOUT);

  it('lets the clear routing fields win over a tampered encrypted record body', async () => {
    const db = await import('./db');
    await db.saveContactRecordV2(record(), KEY);
    const raw = await db.getDb();
    const stored = await raw.get('contactRecordsV2', ['owner', CID]);
    const crypto = await import('./crypto-store');
    const forged = await crypto.encryptSecret(JSON.stringify({
      ...record(), directoryId: 'quarantine', contactId: '9'.repeat(32), createdAt: 9, updatedAt: 9,
    }), KEY);
    await raw.put('contactRecordsV2', { ...stored, encryptedData: forged });

    const [loaded] = await db.listContactRecordsV2('owner', KEY);
    expect(loaded.directoryId).toBe('owner');
    expect(loaded.contactId).toBe(CID);
    expect(loaded.updatedAt).toBe(1_000);
  }, TIMEOUT);

  it('deletes one record by its composite key', async () => {
    const db = await import('./db');
    await db.saveContactRecordV2(record(), KEY);
    await db.deleteContactRecordV2('owner', CID);
    expect(await db.listContactRecordsV2('owner', KEY)).toHaveLength(0);
  }, TIMEOUT);

  it('drops a decrypted record whose body is missing or has a malformed vouches field', async () => {
    const db = await import('./db');
    await db.saveContactRecordV2(record(), KEY);

    const missingVouches = record();
    // @ts-expect-error deliberately malformed for the test
    delete missingVouches.vouches;
    missingVouches.contactId = '1'.repeat(32);
    await db.saveContactRecordV2(missingVouches, KEY);

    const malformedVouches = record();
    malformedVouches.contactId = '2'.repeat(32);
    // @ts-expect-error deliberately malformed for the test
    malformedVouches.vouches = 'x';
    await db.saveContactRecordV2(malformedVouches, KEY);

    const loaded = await db.listContactRecordsV2('owner', KEY);
    expect(loaded.map(r => r.contactId)).toEqual([CID]);
  }, TIMEOUT);
});

describe('import markers and legacy readers', () => {
  it('records and lists import source keys idempotently', async () => {
    const db = await import('./db');
    await db.markContactImportSources(['contact:aa', 'ken:bb'], 1_000);
    await db.markContactImportSources(['contact:aa'], 2_000);
    const sources = await db.listContactImportSources();
    expect(sources.sort()).toEqual(['contact:aa', 'ken:bb']);
  }, TIMEOUT);

  it('reads every legacy contact and ken row across owners', async () => {
    const db = await import('./db');
    await db.saveContact({ pubkey: '1'.repeat(64), ownerPubkey: 'a'.repeat(64), displayName: 'A', sharedSecret: 'secret-a', verifiedAt: 5 }, KEY);
    await db.saveContact({ pubkey: '2'.repeat(64), ownerPubkey: 'b'.repeat(64), displayName: 'B', sharedSecret: 'secret-b', verifiedAt: 6 }, KEY);
    await db.saveKen({ pubkey: '3'.repeat(64), ownerPubkey: 'a'.repeat(64), tier: 'ken', addedAt: 7, provenance: { source: 'manual', locator: 'x', confirmedAt: 7 } });

    const contacts = await db.getAllContacts(KEY);
    expect(contacts).toHaveLength(2);
    expect(contacts.find(c => c.pubkey === '1'.repeat(64))!.sharedSecret).toBe('secret-a');
    expect(await db.getAllKens()).toHaveLength(1);
  }, TIMEOUT);

  // M3: never hand ciphertext back as if it were the plaintext secret — the
  // import would store it as direct evidence and it would read as verified.
  it('omits sharedSecret entirely when it will not decrypt', async () => {
    const db = await import('./db');
    await db.saveContact({ pubkey: '4'.repeat(64), ownerPubkey: 'a'.repeat(64), displayName: 'C', sharedSecret: 'secret-c', verifiedAt: 8 }, KEY);
    const [row] = await db.getAllContacts('a-completely-different-key');
    expect(row.pubkey).toBe('4'.repeat(64));
    expect('sharedSecret' in row).toBe(false);
  }, TIMEOUT);

  it('lists only string source keys', async () => {
    const db = await import('./db');
    await db.markContactImportSources(['contact:cc'], 1_000);
    const raw = await db.getDb();
    await raw.put('contactImportSources', { sourceKey: 42, importedAt: 1 });
    expect(await db.listContactImportSources()).toEqual(['contact:cc']);
  }, TIMEOUT);
});

function validOp(operationId = 'e'.repeat(32)): ContactOperation {
  return op({ operationId });
}

describe('write-side operation validation (R-10)', () => {
  it('refuses to save an operation the reducer would drop', async () => {
    const db = await import('./db');
    const bad = { ...validOp(), operationId: 'not-hex' };
    await expect(db.saveContactOperationV2(bad as never, KEY)).rejects.toThrow(/invalid/i);
    expect(await db.listAllContactOperationsV2(KEY)).toHaveLength(0);
  }, TIMEOUT);

  it('refuses a whole batch containing one invalid operation, writing none of it', async () => {
    const db = await import('./db');
    await expect(
      db.saveContactOperationsV2([validOp(), { ...validOp(), directoryId: 'dependant:0' } as never], KEY),
    ).rejects.toThrow(/invalid/i);
    expect(await db.listAllContactOperationsV2(KEY)).toHaveLength(0);
  }, TIMEOUT);

  it('still saves a valid operation and a valid batch', async () => {
    const db = await import('./db');
    await db.saveContactOperationV2(validOp(), KEY);
    await db.saveContactOperationsV2([validOp('8'.repeat(32))], KEY);
    expect(await db.listAllContactOperationsV2(KEY)).toHaveLength(2);
  }, TIMEOUT);
});
