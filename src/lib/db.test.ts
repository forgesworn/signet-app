import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { SignetIdentity, IdentityDocument, StoredCredential, AppGrantV2 } from '../types';
import { CONTACT_GRANT_V2_CAP, MAX_APP_LABELS_PER_GRANT } from '../types';

// Give each test a fully isolated IndexedDB instance by replacing the global
// before each test and resetting the module registry so the db singleton is fresh.
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
});

async function freshDb() {
  return await import('./db');
}

function makeIdentity(overrides: Partial<SignetIdentity> = {}): SignetIdentity {
  return {
    id: 'aabbccdd'.repeat(8),
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    naturalPerson: {
      publicKey: 'aabbccdd'.repeat(8),
      privateKey: '1122334455667788'.repeat(4),
      displayName: 'Alice Test',
    },
    persona: {
      publicKey: 'eeff0011'.repeat(8),
      privateKey: '99aabbccddee0011'.repeat(4),
      displayName: 'Anon Test',
    },
    primaryKeypair: 'natural-person',
    isChild: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

const PASSPHRASE = 'correct-horse-battery-staple';

// PBKDF2 at 600k iterations is intentionally slow.
// Node runs it in ~150ms but we use a generous timeout in case of CI variance.
const TIMEOUT = 45_000;

// Opens a raw IDB connection with the same schema as db.ts.
// Used to write records that bypass saveIdentityEncrypted.
async function rawOpen() {
  const { openDB } = await import('idb');
  return openDB('my-signet', 25, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('identity')) d.createObjectStore('identity', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('contacts')) {
        const c = d.createObjectStore('contacts', { keyPath: 'pubkey' });
        c.createIndex('ownerPubkey', 'ownerPubkey');
        c.createIndex('groupId', 'groupId');
      }
      if (!d.objectStoreNames.contains('child-settings')) d.createObjectStore('child-settings', { keyPath: 'childPubkey' });
      if (!d.objectStoreNames.contains('preferences')) d.createObjectStore('preferences', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('documents')) {
        const docs = d.createObjectStore('documents', { keyPath: 'id' });
        docs.createIndex('ownerPubkey', 'ownerPubkey');
      }
      if (!d.objectStoreNames.contains('credentials')) {
        const creds = d.createObjectStore('credentials', { keyPath: 'id' });
        creds.createIndex('documentId', 'documentId');
      }
      if (!d.objectStoreNames.contains('authorizedSites')) {
        const sites = d.createObjectStore('authorizedSites', { keyPath: 'id' });
        sites.createIndex('origin', 'origin');
      }
      if (!d.objectStoreNames.contains('originPolicies')) {
        d.createObjectStore('originPolicies', { keyPath: 'origin' });
      }
      if (!d.objectStoreNames.contains('connectedClients')) {
        d.createObjectStore('connectedClients', { keyPath: 'clientPubkey' });
      }
      if (!d.objectStoreNames.contains('grants')) {
        const g = d.createObjectStore('grants', { keyPath: ['dependantId', 'scope', 'origin'] });
        g.createIndex('dependantId', 'dependantId');
      }
      if (!d.objectStoreNames.contains('pairedChild')) {
        d.createObjectStore('pairedChild', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('pairedChildStatus')) {
        d.createObjectStore('pairedChildStatus', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('pairedChildPersonaRevision')) {
        d.createObjectStore('pairedChildPersonaRevision', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('professionalRegistry')) {
        d.createObjectStore('professionalRegistry', { keyPath: 'canonicalKey' });
      }
      if (!d.objectStoreNames.contains('professionalSignetJson')) {
        d.createObjectStore('professionalSignetJson', { keyPath: 'canonicalDomain' });
      }
      if (!d.objectStoreNames.contains('proDirectorySeen')) {
        d.createObjectStore('proDirectorySeen', { keyPath: 'leadPubkey' });
      }
      if (!d.objectStoreNames.contains('publicProfileSignAuth')) {
        d.createObjectStore('publicProfileSignAuth', {
          keyPath: ['depId', 'personaPubkey', 'kidClientPubkey', 'kind'],
        });
      }
      if (!d.objectStoreNames.contains('ken')) {
        const ken = d.createObjectStore('ken', { keyPath: 'pubkey' });
        ken.createIndex('ownerPubkey', 'ownerPubkey');
      }
      if (!d.objectStoreNames.contains('contactAvatars')) {
        d.createObjectStore('contactAvatars', { keyPath: 'pubkey' });
      }
      if (!d.objectStoreNames.contains('gracePeriodState')) {
        d.createObjectStore('gracePeriodState', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('graceKey')) {
        d.createObjectStore('graceKey', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('companionGrants')) {
        d.createObjectStore('companionGrants', { keyPath: 'appPubkey' });
      }
      if (!d.objectStoreNames.contains('syncCache')) {
        d.createObjectStore('syncCache', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('syncSeen')) {
        d.createObjectStore('syncSeen', { keyPath: 'dTag' });
      }
      if (!d.objectStoreNames.contains('contactRecordsV2')) {
        const records = d.createObjectStore('contactRecordsV2', { keyPath: ['directoryId', 'contactId'] });
        records.createIndex('directoryId', 'directoryId');
      }
      if (!d.objectStoreNames.contains('contactOpsV2')) {
        const ops = d.createObjectStore('contactOpsV2', { keyPath: 'operationId' });
        ops.createIndex('directoryId', 'directoryId');
        ops.createIndex('directoryContact', ['directoryId', 'contactId']);
      }
      if (!d.objectStoreNames.contains('contactImportSources')) {
        d.createObjectStore('contactImportSources', { keyPath: 'sourceKey' });
      }
      if (!d.objectStoreNames.contains('contactGrantsV2')) {
        const grantsV2 = d.createObjectStore('contactGrantsV2', { keyPath: 'grantId' });
        grantsV2.createIndex('by-directory', 'directoryId');
        grantsV2.createIndex('by-app', 'appPubkey');
      }
    },
  });
}

describe('Identity encrypted round-trip', () => {
  it('saves and loads decrypted identity preserving private keys and mnemonic', async () => {
    const db = await freshDb();
    const identity = makeIdentity();
    await db.saveIdentityEncrypted(identity, PASSPHRASE);
    const loaded = await db.loadIdentityDecrypted(identity.id, PASSPHRASE);
    expect(loaded).toBeDefined();
    expect(loaded!.naturalPerson.privateKey).toBe(identity.naturalPerson.privateKey);
    expect(loaded!.persona.privateKey).toBe(identity.persona.privateKey);
    expect(loaded!.mnemonic).toBe(identity.mnemonic);
    expect(loaded!.encrypted).toBe(false);
  }, TIMEOUT);

  it('rejects a passphrase shorter than 8 characters', async () => {
    const db = await freshDb();
    await expect(db.saveIdentityEncrypted(makeIdentity(), 'short')).rejects.toThrow();
  }, TIMEOUT);

  it('throws when loading a record without encrypted: true', async () => {
    // Write a raw record without going through saveIdentityEncrypted
    const identity = makeIdentity({ encrypted: false });
    const raw = await rawOpen();
    await raw.put('identity', identity);
    raw.close();

    // Reset modules so db.ts gets a fresh singleton (same global indexedDB, same data)
    vi.resetModules();
    const db = await import('./db');
    await expect(db.loadIdentityDecrypted(identity.id, PASSPHRASE)).rejects.toThrow(/not encrypted/);
  }, TIMEOUT);

  it('returns undefined for a non-existent identity', async () => {
    const db = await freshDb();
    const result = await db.loadIdentityDecrypted('deadbeef'.repeat(8), PASSPHRASE);
    expect(result).toBeUndefined();
  }, TIMEOUT);

  it('encrypts and decrypts extraPersonas private keys', async () => {
    const db = await freshDb();
    const extraPriv = 'ff00ff00'.repeat(8);
    const identity = makeIdentity({
      extraPersonas: [{
        publicKey: 'dd00dd00'.repeat(8),
        privateKey: extraPriv,
        displayName: 'Sidekick',
        derivationName: 'persona-1',
      }],
    });
    await db.saveIdentityEncrypted(identity, PASSPHRASE);

    // Verify the raw stored record has encrypted (not plaintext) private key
    const raw = await rawOpen();
    const stored = await raw.get('identity', identity.id);
    raw.close();
    expect(stored.extraPersonas[0].privateKey).not.toBe(extraPriv);
    expect(stored.extraPersonas[0].privateKey.length).toBeGreaterThan(0);

    // Verify round-trip decryption
    vi.resetModules();
    const db2 = await import('./db');
    const loaded = await db2.loadIdentityDecrypted(identity.id, PASSPHRASE);
    expect(loaded).toBeDefined();
    expect(loaded!.extraPersonas).toHaveLength(1);
    expect(loaded!.extraPersonas![0].privateKey).toBe(extraPriv);
    expect(loaded!.extraPersonas![0].displayName).toBe('Sidekick');
    expect(loaded!.extraPersonas![0].publicKey).toBe('dd00dd00'.repeat(8));
  }, TIMEOUT);

  it('encrypts avatarKey on every persona slot and decrypts back', async () => {
    // Per-persona avatars (2026-05-16). `avatarKey` is the AES key used to
    // decrypt the Blossom blob — sensitive, encrypted at rest, same pattern
    // as `privateKey`. `avatarHash` and `avatarBlossomUrl` are routing
    // fields that stay clear so a locked-mode read can still resolve them.
    const db = await freshDb();
    const npAvatarKey = 'a'.repeat(64);
    const personaAvatarKey = 'b'.repeat(64);
    const extraAvatarKey = 'c'.repeat(64);
    const identity = makeIdentity({
      naturalPerson: {
        publicKey: '11'.repeat(32),
        privateKey: '22'.repeat(32),
        displayName: 'Alex',
        avatarHash: 'd'.repeat(64),
        avatarBlossomUrl: 'https://blossom.example.com',
        avatarKey: npAvatarKey,
        avatarUpdatedAt: 1234567890,
      },
      persona: {
        publicKey: '33'.repeat(32),
        privateKey: '44'.repeat(32),
        displayName: 'Alex (anon)',
        avatarHash: 'e'.repeat(64),
        avatarBlossomUrl: 'https://blossom.example.com',
        avatarKey: personaAvatarKey,
        avatarUpdatedAt: 1234567891,
      },
      extraPersonas: [{
        publicKey: '55'.repeat(32),
        privateKey: '66'.repeat(32),
        displayName: 'Gaming',
        derivationName: 'persona-1',
        avatarHash: 'f'.repeat(64),
        avatarBlossomUrl: 'https://blossom.example.com',
        avatarKey: extraAvatarKey,
        avatarUpdatedAt: 1234567892,
      }],
    });
    await db.saveIdentityEncrypted(identity, PASSPHRASE);

    // Raw record: avatarKey fields should NOT contain the plaintext keys.
    const raw = await rawOpen();
    const stored = await raw.get('identity', identity.id);
    raw.close();
    expect(stored.naturalPerson.avatarKey).toBeDefined();
    expect(stored.naturalPerson.avatarKey).not.toBe(npAvatarKey);
    expect(stored.persona.avatarKey).not.toBe(personaAvatarKey);
    expect(stored.extraPersonas[0].avatarKey).not.toBe(extraAvatarKey);
    // Routing fields stay clear (so the UI can resolve them while locked).
    expect(stored.naturalPerson.avatarHash).toBe('d'.repeat(64));
    expect(stored.naturalPerson.avatarBlossomUrl).toBe('https://blossom.example.com');
    expect(stored.naturalPerson.avatarUpdatedAt).toBe(1234567890);

    // Round-trip: decrypted record matches input.
    vi.resetModules();
    const db2 = await import('./db');
    const loaded = await db2.loadIdentityDecrypted(identity.id, PASSPHRASE);
    expect(loaded).toBeDefined();
    expect(loaded!.naturalPerson.avatarKey).toBe(npAvatarKey);
    expect(loaded!.naturalPerson.avatarHash).toBe('d'.repeat(64));
    expect(loaded!.naturalPerson.avatarBlossomUrl).toBe('https://blossom.example.com');
    expect(loaded!.naturalPerson.avatarUpdatedAt).toBe(1234567890);
    expect(loaded!.persona.avatarKey).toBe(personaAvatarKey);
    expect(loaded!.extraPersonas![0].avatarKey).toBe(extraAvatarKey);
  }, TIMEOUT);

  it('leaves avatarKey undefined when no avatar is set (no encrypt-of-empty)', async () => {
    // Personas without an avatar should round-trip with avatarKey === undefined,
    // not encrypted-empty-string. Otherwise `loadIdentityDecrypted` would
    // try to decrypt a non-existent payload and pollute the field.
    const db = await freshDb();
    const identity = makeIdentity(); // makeIdentity doesn't set avatar fields
    await db.saveIdentityEncrypted(identity, PASSPHRASE);

    const raw = await rawOpen();
    const stored = await raw.get('identity', identity.id);
    raw.close();
    expect(stored.naturalPerson.avatarKey).toBeUndefined();
    expect(stored.persona.avatarKey).toBeUndefined();

    vi.resetModules();
    const db2 = await import('./db');
    const loaded = await db2.loadIdentityDecrypted(identity.id, PASSPHRASE);
    expect(loaded!.naturalPerson.avatarKey).toBeUndefined();
    expect(loaded!.persona.avatarKey).toBeUndefined();
  }, TIMEOUT);

  it('encrypts professionalPersona.privateKey at rest and decrypts it back (security audit 2026-06-15)', async () => {
    // The Pro key's canonical store is a separate encrypted row, but the type
    // permits a privateKey on the identity object and several callbacks spread
    // professionalPersona through saveIdentityEncrypted. This guards against a
    // future path writing a cleartext Pro key to IndexedDB.
    const db = await freshDb();
    const proPriv = 'ab12cd34'.repeat(8);
    const identity = makeIdentity({
      professionalPersona: {
        publicKey: '77'.repeat(32),
        privateKey: proPriv,
        displayName: 'Dr Alice',
      },
    });
    await db.saveIdentityEncrypted(identity, PASSPHRASE);

    // Raw stored record must NOT contain the plaintext Pro private key.
    const raw = await rawOpen();
    const stored = await raw.get('identity', identity.id);
    raw.close();
    expect(stored.professionalPersona).toBeDefined();
    expect(stored.professionalPersona.privateKey).not.toBe(proPriv);
    expect(stored.professionalPersona.privateKey.length).toBeGreaterThan(0);
    // Non-secret fields stay clear.
    expect(stored.professionalPersona.publicKey).toBe('77'.repeat(32));
    expect(stored.professionalPersona.displayName).toBe('Dr Alice');

    // Round-trip decrypts back to the original key.
    vi.resetModules();
    const db2 = await import('./db');
    const loaded = await db2.loadIdentityDecrypted(identity.id, PASSPHRASE);
    expect(loaded!.professionalPersona).toBeDefined();
    expect(loaded!.professionalPersona!.privateKey).toBe(proPriv);
    expect(loaded!.professionalPersona!.publicKey).toBe('77'.repeat(32));
    expect(loaded!.professionalPersona!.displayName).toBe('Dr Alice');
  }, TIMEOUT);

  it('leaves professionalPersona undefined when the identity has no Pro slot', async () => {
    const db = await freshDb();
    const identity = makeIdentity(); // no professionalPersona
    await db.saveIdentityEncrypted(identity, PASSPHRASE);
    const raw = await rawOpen();
    const stored = await raw.get('identity', identity.id);
    raw.close();
    expect(stored.professionalPersona).toBeUndefined();

    vi.resetModules();
    const db2 = await import('./db');
    const loaded = await db2.loadIdentityDecrypted(identity.id, PASSPHRASE);
    expect(loaded!.professionalPersona).toBeUndefined();
  }, TIMEOUT);
});

describe('Bunker secret', () => {
  it('saves and loads a bunker secret round-trip', async () => {
    const db = await freshDb();
    const secret = 'a'.repeat(64);
    await db.saveBunkerSecret(secret, PASSPHRASE);
    const loaded = await db.loadBunkerSecret(PASSPHRASE);
    expect(loaded).toBe(secret);
  }, TIMEOUT);

  it('returns null when the wrong key is used', async () => {
    const db = await freshDb();
    await db.saveBunkerSecret('b'.repeat(64), PASSPHRASE);
    const result = await db.loadBunkerSecret('wrong-passphrase-here');
    expect(result).toBeNull();
  }, TIMEOUT);

  it('returns null when no secret has been stored', async () => {
    const db = await freshDb();
    const result = await db.loadBunkerSecret(PASSPHRASE);
    expect(result).toBeNull();
  }, TIMEOUT);

  it('deleteBunkerSecret removes the record so loadBunkerSecret returns null', async () => {
    const db = await freshDb();
    await db.saveBunkerSecret('c'.repeat(64), PASSPHRASE);
    await db.deleteBunkerSecret();
    const result = await db.loadBunkerSecret(PASSPHRASE);
    expect(result).toBeNull();
  }, TIMEOUT);
});

describe('Heartwood operator credential (C3 §5)', () => {
  const cred = {
    skHex: '7f3c9a1e2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a3c5e7b9d2f4a6c8e0b1d3f5a',
    pubHex: 'c'.repeat(64),
    deviceHex: 'a'.repeat(63) + 'b',
    relays: ['wss://relay.one.example', 'wss://relay.two.example'],
    importedAt: 1_755_300_000,
  };

  it('saves and loads the credential round-trip', async () => {
    const db = await freshDb();
    await db.saveHeartwoodOperator(cred, PASSPHRASE);
    const loaded = await db.loadHeartwoodOperator(PASSPHRASE);
    expect(loaded).toEqual(cred);
  }, TIMEOUT);

  it('stores the whole credential encrypted — no cleartext skHex/deviceHex/relays in the row', async () => {
    const db = await freshDb();
    await db.saveHeartwoodOperator(cred, PASSPHRASE);
    const raw = await rawOpen();
    const row = await raw.get('identity', 'heartwoodOperator') as Record<string, unknown>;
    raw.close();
    expect(row).toBeTruthy();
    expect(typeof row.secret).toBe('string');
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(cred.skHex);
    expect(serialised).not.toContain(cred.deviceHex);
    expect(serialised).not.toContain('relay.one.example');
    expect(row.skHex).toBeUndefined();
  }, TIMEOUT);

  it('returns null with the wrong key', async () => {
    const db = await freshDb();
    await db.saveHeartwoodOperator(cred, PASSPHRASE);
    expect(await db.loadHeartwoodOperator('wrong-passphrase-here')).toBeNull();
  }, TIMEOUT);

  it('returns null when nothing has been stored', async () => {
    const db = await freshDb();
    expect(await db.loadHeartwoodOperator(PASSPHRASE)).toBeNull();
  }, TIMEOUT);

  it('returns null when the decrypted payload is not a well-formed credential', async () => {
    const db = await freshDb();
    const secret = await db.encryptSecret(JSON.stringify({ skHex: 'nope' }), PASSPHRASE);
    const raw = await rawOpen();
    await raw.put('identity', { id: 'heartwoodOperator', secret });
    raw.close();
    expect(await db.loadHeartwoodOperator(PASSPHRASE)).toBeNull();
  }, TIMEOUT);

  it('overwrites on re-save (single row)', async () => {
    const db = await freshDb();
    await db.saveHeartwoodOperator(cred, PASSPHRASE);
    await db.saveHeartwoodOperator({ ...cred, deviceHex: 'f'.repeat(64) }, PASSPHRASE);
    const loaded = await db.loadHeartwoodOperator(PASSPHRASE);
    expect(loaded?.deviceHex).toBe('f'.repeat(64));
    const raw = await rawOpen();
    expect(await raw.count('identity')).toBe(1);
    raw.close();
  }, TIMEOUT);

  it('deleteHeartwoodOperator removes the row so load returns null', async () => {
    const db = await freshDb();
    await db.saveHeartwoodOperator(cred, PASSPHRASE);
    await db.deleteHeartwoodOperator();
    expect(await db.loadHeartwoodOperator(PASSPHRASE)).toBeNull();
  }, TIMEOUT);

  it('is excluded from getAllIdentities and survives cleanupUnencryptedIdentities', async () => {
    const db = await freshDb();
    const identity = makeIdentity();
    await db.saveIdentityEncrypted(identity, PASSPHRASE);
    await db.saveHeartwoodOperator(cred, PASSPHRASE);

    const all = await db.getAllIdentities();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(identity.id);

    // The row carries `secret` (not `encrypted: true`), so the plaintext
    // sweeper must skip it by id, like bunkerSecret.
    expect(await db.cleanupUnencryptedIdentities()).toBe(0);
    expect(await db.loadHeartwoodOperator(PASSPHRASE)).toEqual(cred);
  }, TIMEOUT);

  it('purgeAllUserData clears the credential', async () => {
    const db = await freshDb();
    await db.saveHeartwoodOperator(cred, PASSPHRASE);
    await db.purgeAllUserData();
    expect(await db.loadHeartwoodOperator(PASSPHRASE)).toBeNull();
  }, TIMEOUT);
});

describe('cleanupUnencryptedIdentities', () => {
  it('removes unencrypted identity records', async () => {
    const identity = makeIdentity({ encrypted: false });
    const raw = await rawOpen();
    await raw.put('identity', identity);
    raw.close();

    vi.resetModules();
    const db = await import('./db');
    const removed = await db.cleanupUnencryptedIdentities();
    expect(removed).toBe(1);

    const all = await db.getAllIdentities();
    expect(all).toHaveLength(0);
  }, TIMEOUT);

  it('does NOT remove the bunker secret record (regression: cleanup bug)', async () => {
    const db = await freshDb();
    await db.saveBunkerSecret('a'.repeat(64), PASSPHRASE);
    const removed = await db.cleanupUnencryptedIdentities();
    expect(removed).toBe(0);
    const loaded = await db.loadBunkerSecret(PASSPHRASE);
    expect(loaded).toBe('a'.repeat(64));
  }, TIMEOUT);

  it('returns 0 when all stored identities are encrypted', async () => {
    const db = await freshDb();
    await db.saveIdentityEncrypted(makeIdentity(), PASSPHRASE);
    const removed = await db.cleanupUnencryptedIdentities();
    expect(removed).toBe(0);
  }, TIMEOUT);
});

// 2026-07-02 audit: getAllIdentities() must return only real user
// SignetIdentity rows — not the bunkerSecret/professionalPersona marker
// rows, and not dependant:-prefixed DependantIdentity rows (which also
// carry a `naturalPerson` slot, so a shape-only filter can't exclude them).
describe('getAllIdentities — excludes non-identity rows', () => {
  it('excludes the bunkerSecret and professionalPersona marker rows', async () => {
    const db = await freshDb();
    const identity = makeIdentity();
    await db.saveIdentityEncrypted(identity, PASSPHRASE);
    await db.saveBunkerSecret('a'.repeat(64), PASSPHRASE);
    await db.saveProPersonaEncrypted('b'.repeat(64), PASSPHRASE);

    const all = await db.getAllIdentities();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(identity.id);
  }, TIMEOUT);

  it('excludes dependant:-prefixed DependantIdentity rows', async () => {
    const db = await freshDb();
    const identity = makeIdentity();
    await db.saveIdentityEncrypted(identity, PASSPHRASE);

    const dep = {
      id: 'd'.repeat(64),
      guardianPubkey: identity.id,
      displayName: 'Kid',
      naturalPerson: { publicKey: 'd'.repeat(64), privateKey: '1'.repeat(64), displayName: 'Kid' },
      persona: { publicKey: 'e'.repeat(64), privateKey: '2'.repeat(64), displayName: 'Kid (anon)' },
      derivationPath: 'dependant-0',
      createdAt: Math.floor(Date.now() / 1000),
      autonomyStage: 'request-approve' as const,
      primaryKeypair: 'natural-person' as const,
    };
    await db.saveDependant(dep as unknown as Parameters<typeof db.saveDependant>[0], PASSPHRASE);

    const all = await db.getAllIdentities();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(identity.id);
  }, TIMEOUT);
});

describe('Preferences', () => {
  it('returns defaults when nothing has been saved', async () => {
    const db = await freshDb();
    const prefs = await db.getPreferences();
    expect(prefs.id).toBe('current');
    expect(prefs.theme).toBe('system');
  }, TIMEOUT);

  it('saves and loads preferences', async () => {
    const db = await freshDb();
    await db.savePreferences({ id: 'current', theme: 'dark', relayUrl: 'wss://relay.example.com' });
    const loaded = await db.getPreferences();
    expect(loaded.theme).toBe('dark');
    expect(loaded.relayUrl).toBe('wss://relay.example.com');
  }, TIMEOUT);
});

// M1 (2026-07-02 audit): AppPreferences.bunkerUri carries a reusable
// bunker://...&secret=... NIP-46 reauth secret — must be encrypted at
// rest, matching the sibling saveBunkerSecret / PairedChildRecord.bunkerUri
// conventions.
describe('bunkerUri encrypted at rest (M1)', () => {
  const KEY = 'test-encryption-key-min-8';
  const PLAINTEXT_URI = 'bunker://' + 'a'.repeat(64) + '?relay=wss://relay.example&secret=deadbeef00112233';

  it('round-trips through encrypt-on-save / decrypt-on-load', async () => {
    const db = await freshDb();
    await db.savePreferences({ id: 'current', theme: 'system', bunkerUri: PLAINTEXT_URI }, KEY);
    const decrypted = await db.getPreferences(KEY);
    expect(decrypted.bunkerUri).toBe(PLAINTEXT_URI);
  }, TIMEOUT);

  it('never writes the plaintext secret to the underlying IDB record', async () => {
    const db = await freshDb();
    await db.savePreferences({ id: 'current', theme: 'system', bunkerUri: PLAINTEXT_URI }, KEY);

    // Bypass the wrapper and inspect the raw stored record.
    const { openDB } = await import('idb');
    const raw = await openDB('my-signet');
    const record = await raw.get('preferences', 'current');
    raw.close();

    expect(record.bunkerUri).not.toBe(PLAINTEXT_URI);
    expect(record.bunkerUri).not.toContain('secret=deadbeef00112233');
  }, TIMEOUT);

  it('refuses to persist a plaintext bunkerUri when no key is supplied — preserves existing ciphertext instead', async () => {
    const db = await freshDb();
    await db.savePreferences({ id: 'current', theme: 'system', bunkerUri: PLAINTEXT_URI }, KEY);

    // Simulate an unrelated setter (setTheme etc.) spreading the decrypted
    // in-memory preferences object through without a key.
    const decrypted = await db.getPreferences(KEY);
    await db.savePreferences({ ...decrypted, theme: 'dark' });

    const reDecrypted = await db.getPreferences(KEY);
    expect(reDecrypted.bunkerUri).toBe(PLAINTEXT_URI); // unchanged, still decryptable
    expect(reDecrypted.theme).toBe('dark');
  }, TIMEOUT);

  it('getPreferences without a key returns an opaque (non-plaintext) value, not the raw secret', async () => {
    const db = await freshDb();
    await db.savePreferences({ id: 'current', theme: 'system', bunkerUri: PLAINTEXT_URI }, KEY);
    const raw = await db.getPreferences();
    expect(raw.bunkerUri).not.toBe(PLAINTEXT_URI);
  }, TIMEOUT);

  it('an explicit clear (bunkerUri: undefined) always works, with or without a key', async () => {
    const db = await freshDb();
    await db.savePreferences({ id: 'current', theme: 'system', bunkerUri: PLAINTEXT_URI }, KEY);
    await db.savePreferences({ id: 'current', theme: 'system', bunkerUri: undefined });
    const loaded = await db.getPreferences(KEY);
    expect(loaded.bunkerUri).toBeUndefined();
  }, TIMEOUT);

  describe('migrateCleartextBunkerUri', () => {
    it('encrypts a pre-existing legacy cleartext bunkerUri', async () => {
      const db = await freshDb();
      // Force schema creation before opening raw (fresh fake-indexeddb has
      // no stores until getDB() runs once).
      await db.getPreferences();
      // Simulate a pre-M1 record written directly (bypassing the now-guarded wrapper).
      const { openDB } = await import('idb');
      const raw = await openDB('my-signet');
      await raw.put('preferences', { id: 'current', theme: 'system', bunkerUri: PLAINTEXT_URI });
      raw.close();

      await db.migrateCleartextBunkerUri(KEY);

      const rawAfter = await openDB('my-signet');
      const recordAfter = await rawAfter.get('preferences', 'current');
      rawAfter.close();
      expect(recordAfter.bunkerUri).not.toBe(PLAINTEXT_URI);

      const decrypted = await db.getPreferences(KEY);
      expect(decrypted.bunkerUri).toBe(PLAINTEXT_URI);
    }, TIMEOUT);

    it('is a no-op when bunkerUri is already encrypted', async () => {
      const db = await freshDb();
      await db.savePreferences({ id: 'current', theme: 'system', bunkerUri: PLAINTEXT_URI }, KEY);
      const before = await db.getPreferences(KEY);

      await db.migrateCleartextBunkerUri(KEY); // should be a no-op

      const after = await db.getPreferences(KEY);
      expect(after.bunkerUri).toBe(before.bunkerUri);
    }, TIMEOUT);

    it('is a no-op when bunkerUri is absent', async () => {
      const db = await freshDb();
      await db.savePreferences({ id: 'current', theme: 'system' });
      await expect(db.migrateCleartextBunkerUri(KEY)).resolves.not.toThrow();
    }, TIMEOUT);
  });
});

const TEST_KEY = 'test-encryption-key-min-8';

function makeDoc(overrides: Partial<IdentityDocument> & Pick<IdentityDocument, 'id' | 'ownerPubkey'>): IdentityDocument {
  return {
    country: 'GB',
    documentType: 'passport',
    fullName: 'Alice Smith',
    dateOfBirth: '1990-05-15',
    documentNumber: 'AB123456',
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    ...overrides,
  };
}

function makeCredential(overrides: Partial<StoredCredential> & { id: string }): StoredCredential {
  return {
    documentId: 'doc-1',
    keypairType: 'natural-person',
    event: '{"kind":30470,"content":"verified"}',
    verifierPubkey: 'a'.repeat(64),
    verifiedAt: 1_700_000_000,
    verifierStatus: 'confirmed',
    ...overrides,
  };
}

describe('Document encryption at rest', () => {
  it('saves encrypted and loads decrypted with correct key', async () => {
    const db = await freshDb();
    const doc = makeDoc({ id: 'doc-1', ownerPubkey: 'owner1' });
    await db.saveDocument(doc, TEST_KEY);
    const loaded = await db.getDocument('doc-1', TEST_KEY);
    expect(loaded).toBeDefined();
    expect(loaded!.fullName).toBe('Alice Smith');
    expect(loaded!.dateOfBirth).toBe('1990-05-15');
    expect(loaded!.documentNumber).toBe('AB123456');
    expect(loaded!.country).toBe('GB');
    expect(loaded!.documentType).toBe('passport');
    expect(loaded!.id).toBe('doc-1');
    expect(loaded!.ownerPubkey).toBe('owner1');
    expect(loaded!.createdAt).toBe(1_000_000);
    expect(loaded!.updatedAt).toBe(1_000_000);
  }, TIMEOUT);

  it('stores sensitive fields encrypted in IndexedDB', async () => {
    const db = await freshDb();
    const doc = makeDoc({ id: 'doc-2', ownerPubkey: 'owner1' });
    await db.saveDocument(doc, TEST_KEY);
    // Load WITHOUT encryption key — raw record
    const raw = await db.getDocument('doc-2');
    expect(raw).toBeDefined();
    expect((raw as unknown as Record<string, unknown>).encrypted).toBe(true);
    expect((raw as unknown as Record<string, unknown>).encryptedData).toBeDefined();
    expect(raw!.fullName).toBeUndefined();
  }, TIMEOUT);

  it('getDocumentsByOwner returns decrypted documents', async () => {
    const db = await freshDb();
    await db.saveDocument(makeDoc({ id: 'doc-3', ownerPubkey: 'owner2' }), TEST_KEY);
    await db.saveDocument(makeDoc({ id: 'doc-4', ownerPubkey: 'owner2', fullName: 'Bob Jones' }), TEST_KEY);
    const docs = await db.getDocumentsByOwner('owner2', TEST_KEY);
    expect(docs).toHaveLength(2);
    expect(docs[0].fullName).toBeDefined();
    expect(docs[1].fullName).toBeDefined();
    const names = docs.map(d => d.fullName).sort();
    expect(names).toEqual(['Alice Smith', 'Bob Jones']);
  }, TIMEOUT);

  it('loads legacy unencrypted documents without error', async () => {
    const db = await freshDb();
    // M2 (2026-07-02 audit): saveDocument now requires a key, so a legacy
    // pre-encryption record can no longer be created via the wrapper —
    // write it directly to simulate a record from before this fix shipped.
    await db.saveDocument(makeDoc({ id: 'doc-warm-schema', ownerPubkey: 'owner3' }), TEST_KEY); // force schema creation
    const { openDB } = await import('idb');
    const raw = await openDB('my-signet');
    await raw.put('documents', makeDoc({ id: 'doc-5', ownerPubkey: 'owner3' }));
    raw.close();
    // Load WITH key — should fall back to raw record
    const loaded = await db.getDocument('doc-5', TEST_KEY);
    expect(loaded).toBeDefined();
    expect(loaded!.fullName).toBe('Alice Smith');
    expect(loaded!.documentNumber).toBe('AB123456');
  }, TIMEOUT);

  it('throws on wrong decryption key', async () => {
    const db = await freshDb();
    await db.saveDocument(makeDoc({ id: 'doc-6', ownerPubkey: 'owner4' }), TEST_KEY);
    await expect(db.getDocument('doc-6', 'wrong-key-here!!')).rejects.toThrow();
  }, TIMEOUT);
});

describe('Credential encryption at rest', () => {
  it('saves encrypted and loads decrypted with correct key', async () => {
    const db = await freshDb();
    const cred = makeCredential({ id: 'cred-1' });
    await db.saveCredential(cred, TEST_KEY);
    const loaded = await db.getCredential('cred-1', TEST_KEY);
    expect(loaded).toBeDefined();
    expect(loaded!.event).toBe('{"kind":30470,"content":"verified"}');
    expect(loaded!.documentId).toBe('doc-1');
    expect(loaded!.keypairType).toBe('natural-person');
    expect(loaded!.verifierPubkey).toBe('a'.repeat(64));
    expect(loaded!.verifiedAt).toBe(1_700_000_000);
    expect(loaded!.verifierStatus).toBe('confirmed');
  }, TIMEOUT);

  it('stores sensitive fields encrypted in IndexedDB', async () => {
    const db = await freshDb();
    await db.saveCredential(makeCredential({ id: 'cred-2' }), TEST_KEY);
    // Load WITHOUT key — raw record
    const raw = await db.getCredential('cred-2');
    expect(raw).toBeDefined();
    expect((raw as unknown as Record<string, unknown>).encrypted).toBe(true);
    expect((raw as unknown as Record<string, unknown>).encryptedData).toBeDefined();
    expect(raw!.event).toBeUndefined();
  }, TIMEOUT);

  it('getAllCredentials returns decrypted credentials', async () => {
    const db = await freshDb();
    await db.saveCredential(makeCredential({ id: 'cred-3' }), TEST_KEY);
    await db.saveCredential(makeCredential({ id: 'cred-4', event: '{"kind":30470,"content":"second"}' }), TEST_KEY);
    const creds = await db.getAllCredentials(TEST_KEY);
    expect(creds).toHaveLength(2);
    expect(creds.every(c => c.event !== undefined)).toBe(true);
  }, TIMEOUT);

  it('getCredentialsByDocument returns decrypted credentials', async () => {
    const db = await freshDb();
    await db.saveCredential(makeCredential({ id: 'cred-5', documentId: 'doc-x' }), TEST_KEY);
    await db.saveCredential(makeCredential({ id: 'cred-6', documentId: 'doc-x' }), TEST_KEY);
    const creds = await db.getCredentialsByDocument('doc-x', TEST_KEY);
    expect(creds).toHaveLength(2);
    expect(creds[0].event).toBeDefined();
    expect(creds[1].event).toBeDefined();
  }, TIMEOUT);

  it('loads legacy unencrypted credentials without error', async () => {
    const db = await freshDb();
    // M2 (2026-07-02 audit): saveCredential now requires a key, so a legacy
    // pre-encryption record can no longer be created via the wrapper —
    // write it directly to simulate a record from before this fix shipped.
    await db.saveCredential(makeCredential({ id: 'cred-warm-schema' }), TEST_KEY); // force schema creation
    const { openDB } = await import('idb');
    const raw = await openDB('my-signet');
    await raw.put('credentials', makeCredential({ id: 'cred-7' }));
    raw.close();
    // Load WITH key
    const loaded = await db.getCredential('cred-7', TEST_KEY);
    expect(loaded).toBeDefined();
    expect(loaded!.event).toBe('{"kind":30470,"content":"verified"}');
  }, TIMEOUT);

  it('throws on wrong decryption key', async () => {
    const db = await freshDb();
    await db.saveCredential(makeCredential({ id: 'cred-8' }), TEST_KEY);
    await expect(db.getCredential('cred-8', 'wrong-key-here!!')).rejects.toThrow();
  }, TIMEOUT);
});

// M2 (2026-07-02 audit): saveDocument / saveCredential / saveContact must
// never silently persist plaintext when no encryption key is supplied —
// unlike saveIdentityEncrypted (which already throws), these three had a
// silent `db.put(plaintext)` fallback.
describe('plaintext persistence fallback removed (M2)', () => {
  it('saveDocument throws without a key', async () => {
    const db = await freshDb();
    await expect(db.saveDocument(makeDoc({ id: 'doc-no-key', ownerPubkey: 'owner5' }))).rejects.toThrow(/encryption key/i);
  }, TIMEOUT);

  it('saveDocument throws when passed an empty-string key', async () => {
    const db = await freshDb();
    await expect(db.saveDocument(makeDoc({ id: 'doc-empty-key', ownerPubkey: 'owner5' }), '')).rejects.toThrow(/encryption key/i);
  }, TIMEOUT);

  it('saveCredential throws without a key', async () => {
    const db = await freshDb();
    await expect(db.saveCredential(makeCredential({ id: 'cred-no-key' }))).rejects.toThrow(/encryption key/i);
  }, TIMEOUT);

  it('updateCredential (delegates to saveCredential) throws without a key', async () => {
    const db = await freshDb();
    await expect(db.updateCredential(makeCredential({ id: 'cred-update-no-key' }))).rejects.toThrow(/encryption key/i);
  }, TIMEOUT);

  it('saveContact throws without a key when the contact carries a sharedSecret', async () => {
    const db = await freshDb();
    const contact = {
      pubkey: 'c'.repeat(64),
      displayName: 'Alice',
      verifiedAt: 1_700_000_000,
      sharedSecret: 'super-secret-ecdh-value',
    } as import('../types').Contact;
    await expect(db.saveContact(contact)).rejects.toThrow(/encryption key/i);
  }, TIMEOUT);

  it('saveContact does NOT throw without a key when there is no sharedSecret to protect', async () => {
    const db = await freshDb();
    const contact = {
      pubkey: 'd'.repeat(64),
      displayName: 'Bob',
      verifiedAt: 1_700_000_000,
    } as import('../types').Contact;
    await expect(db.saveContact(contact)).resolves.not.toThrow();
  }, TIMEOUT);

  it('saveContact encrypts sharedSecret at rest when a key is supplied', async () => {
    const db = await freshDb();
    const contact = {
      pubkey: 'e'.repeat(64),
      displayName: 'Carol',
      verifiedAt: 1_700_000_000,
      sharedSecret: 'super-secret-ecdh-value',
    } as import('../types').Contact;
    await db.saveContact(contact, TEST_KEY);
    const loaded = await db.getContact(contact.pubkey, TEST_KEY);
    expect(loaded?.sharedSecret).toBe('super-secret-ecdh-value');

    const raw = await db.getContact(contact.pubkey); // no key — should not be the plaintext secret
    expect(raw?.sharedSecret).not.toBe('super-secret-ecdh-value');
  }, TIMEOUT);
});

describe('purgeAllUserData', () => {
  it('clears all stores', async () => {
    const db = await freshDb();
    const identity = makeIdentity();
    await db.saveIdentityEncrypted(identity, PASSPHRASE);
    await db.saveBunkerSecret('d'.repeat(64), PASSPHRASE);
    await db.saveHeartwoodOperator({
      skHex: '7f3c9a1e2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a3c5e7b9d2f4a6c8e0b1d3f5a',
      pubHex: 'c'.repeat(64),
      deviceHex: 'a'.repeat(64),
      relays: ['wss://relay.example'],
      importedAt: 1,
    }, PASSPHRASE);
    await db.savePreferences({ id: 'current', theme: 'light' });
    await db.saveGrant({
      dependantId: 'a'.repeat(64),
      scope: 'sign-in',
      origin: 'https://roblox.com',
      decision: 'allow',
      decidedAt: 1,
    });

    await db.purgeAllUserData();

    const loaded = await db.loadIdentityDecrypted(identity.id, PASSPHRASE);
    expect(loaded).toBeUndefined();

    const secret = await db.loadBunkerSecret(PASSPHRASE);
    expect(secret).toBeNull();

    expect(await db.loadHeartwoodOperator(PASSPHRASE)).toBeNull();

    const prefs = await db.getPreferences();
    // getPreferences returns the default when the store is empty
    expect(prefs.theme).toBe('system');

    const grants = await db.listAllGrants();
    expect(grants).toEqual([]);
  }, TIMEOUT);

  it('every store in the current schema is empty after purge (audit-3 regression)', async () => {
    // Sanity check: enumerate every object store IDB knows about, write at
    // least one record into each, then assert purgeAllUserData leaves every
    // store empty. Catches "added a new store and forgot to update purge".
    const db = await freshDb();
    const { openDB } = await import('idb');
    // Force schema upgrade by opening + closing once.
    await db.saveIdentityEncrypted(makeIdentity(), PASSPHRASE);

    const raw = await openDB('my-signet');
    const storeNames = Array.from(raw.objectStoreNames);
    raw.close();

    // Write a dummy record into every store via a single raw transaction.
    const raw2 = await openDB('my-signet');
    const tx = raw2.transaction(storeNames, 'readwrite');
    for (const name of storeNames) {
      const store = tx.objectStore(name);
      const keyPath = store.keyPath;
      const dummy: Record<string, unknown> = {};
      const setKey = (k: string) => { dummy[k] = `dummy-${k}`; };
      if (typeof keyPath === 'string') setKey(keyPath);
      else if (Array.isArray(keyPath)) keyPath.forEach(setKey);
      try { await store.put(dummy); } catch { /* schema-strict stores may reject; ok */ }
    }
    await tx.done;
    raw2.close();

    await db.purgeAllUserData();

    const raw3 = await openDB('my-signet');
    for (const name of storeNames) {
      const count = await raw3.count(name);
      expect(count, `store "${name}" must be empty after purgeAllUserData`).toBe(0);
    }
    raw3.close();
  }, TIMEOUT);
});

describe('Dependant bunker endpoint round-trip', () => {
  const GUARDIAN = 'c'.repeat(64);
  const DEP_PUB = 'd'.repeat(64);

  function makeDep(overrides: Record<string, unknown> = {}) {
    return {
      id: DEP_PUB,
      guardianPubkey: GUARDIAN,
      displayName: 'Alice',
      naturalPerson: { publicKey: DEP_PUB, privateKey: '1'.repeat(64), displayName: 'Alice' },
      persona: { publicKey: 'e'.repeat(64), privateKey: '2'.repeat(64), displayName: 'Alice (anon)' },
      derivationPath: 'dependant-0',
      createdAt: Math.floor(Date.now() / 1000),
      autonomyStage: 'request-approve' as const,
      primaryKeypair: 'natural-person' as const,
      ...overrides,
    };
  }

  it('encrypts the endpoint privateKey at rest; round-trips cleanly', async () => {
    const db = await freshDb();
    const endpointPriv = 'ab'.repeat(32);
    const endpointPub = '9'.repeat(64);
    const dep = makeDep({
      bunkerEndpoint: {
        publicKey: endpointPub,
        privateKey: endpointPriv,
        createdAt: 12345,
      },
    });
    // TS helper: cast through unknown because makeDep returns a loose shape
    await db.saveDependant(dep as unknown as Parameters<typeof db.saveDependant>[0], PASSPHRASE);

    // Raw record should have an encrypted privateKey, not the plaintext
    const raw = await rawOpen();
    const stored = await raw.get('identity', 'dependant:' + DEP_PUB);
    raw.close();
    expect(stored.bunkerEndpoint.privateKey).not.toBe(endpointPriv);
    expect(stored.bunkerEndpoint.privateKey.length).toBeGreaterThan(0);
    expect(stored.bunkerEndpoint.publicKey).toBe(endpointPub);
    expect(stored.bunkerEndpoint.createdAt).toBe(12345);

    // Reload decrypted
    vi.resetModules();
    const db2 = await import('./db');
    const deps = await db2.getDependants(GUARDIAN, PASSPHRASE);
    expect(deps).toHaveLength(1);
    expect(deps[0].bunkerEndpoint).toBeDefined();
    expect(deps[0].bunkerEndpoint!.publicKey).toBe(endpointPub);
    expect(deps[0].bunkerEndpoint!.privateKey).toBe(endpointPriv);
    expect(deps[0].bunkerEndpoint!.createdAt).toBe(12345);
  }, TIMEOUT);

  it('encrypts bunkerEndpoint.pairingSecret at rest; round-trips cleanly (2026-07-02 audit)', async () => {
    const db = await freshDb();
    const endpointPriv = 'ab'.repeat(32);
    const endpointPub = '9'.repeat(64);
    const pairingSecret = 'cd'.repeat(16); // 32-hex-char generatePairingSecret() shape
    const dep = makeDep({
      bunkerEndpoint: {
        publicKey: endpointPub,
        privateKey: endpointPriv,
        createdAt: 12345,
        pairingSecret,
      },
    });
    await db.saveDependant(dep as unknown as Parameters<typeof db.saveDependant>[0], PASSPHRASE);

    // Raw record: pairingSecret must be ciphertext, not the plaintext secret.
    const raw = await rawOpen();
    const stored = await raw.get('identity', 'dependant:' + DEP_PUB);
    raw.close();
    expect(stored.bunkerEndpoint.pairingSecret).not.toBe(pairingSecret);
    expect(stored.bunkerEndpoint.pairingSecret.length).toBeGreaterThan(0);

    // Reload decrypted — pairingSecret comes back as the original value.
    vi.resetModules();
    const db2 = await import('./db');
    const deps = await db2.getDependants(GUARDIAN, PASSPHRASE);
    expect(deps).toHaveLength(1);
    expect(deps[0].bunkerEndpoint!.pairingSecret).toBe(pairingSecret);
    expect(deps[0].bunkerEndpoint!.authorizedClientPubkey).toBeUndefined();
  }, TIMEOUT);

  it('dependant without a pairingSecret round-trips with the field undefined', async () => {
    const db = await freshDb();
    const dep = makeDep({
      bunkerEndpoint: { publicKey: '9'.repeat(64), privateKey: 'ab'.repeat(32), createdAt: 1 },
    });
    await db.saveDependant(dep as unknown as Parameters<typeof db.saveDependant>[0], PASSPHRASE);

    const deps = await db.getDependants(GUARDIAN, PASSPHRASE);
    expect(deps[0].bunkerEndpoint!.pairingSecret).toBeUndefined();
  }, TIMEOUT);

  it('dependant without bunkerEndpoint round-trips without the field', async () => {
    const db = await freshDb();
    const dep = makeDep();
    await db.saveDependant(dep as unknown as Parameters<typeof db.saveDependant>[0], PASSPHRASE);
    const deps = await db.getDependants(GUARDIAN, PASSPHRASE);
    expect(deps).toHaveLength(1);
    expect(deps[0].bunkerEndpoint).toBeUndefined();
  }, TIMEOUT);

  it('clearing bunkerEndpoint (set undefined) round-trips as absent', async () => {
    const db = await freshDb();
    const dep = makeDep({
      bunkerEndpoint: { publicKey: '9'.repeat(64), privateKey: 'ab'.repeat(32), createdAt: 1 },
    });
    await db.saveDependant(dep as unknown as Parameters<typeof db.saveDependant>[0], PASSPHRASE);

    const cleared = makeDep();
    await db.saveDependant(cleared as unknown as Parameters<typeof db.saveDependant>[0], PASSPHRASE);

    const deps = await db.getDependants(GUARDIAN, PASSPHRASE);
    expect(deps[0].bunkerEndpoint).toBeUndefined();
  }, TIMEOUT);

  it('per-dep-persona avatarKey round-trips through encrypt/decrypt', async () => {
    // Phase 3 of per-persona avatars — dep keypair slots gain the same
    // avatar fields as the user's own. avatarKey is sensitive (decrypts
    // the Blossom blob) and must be encrypted at rest, matching the
    // privateKey treatment. Hash + URL stay clear.
    const db = await freshDb();
    const npAvatarKey = '11'.repeat(32);
    const personaAvatarKey = '22'.repeat(32);
    const extraAvatarKey = '33'.repeat(32);
    const dep = makeDep({
      naturalPerson: {
        publicKey: DEP_PUB,
        privateKey: '1'.repeat(64),
        displayName: 'Alice',
        avatarHash: 'aa'.repeat(32),
        avatarBlossomUrl: 'https://blossom.example.com',
        avatarKey: npAvatarKey,
        avatarUpdatedAt: 1000,
      },
      persona: {
        publicKey: 'e'.repeat(64),
        privateKey: '2'.repeat(64),
        displayName: 'Alice (anon)',
        avatarHash: 'bb'.repeat(32),
        avatarBlossomUrl: 'https://blossom.example.com',
        avatarKey: personaAvatarKey,
        avatarUpdatedAt: 2000,
      },
      extraPersonas: [{
        publicKey: 'f'.repeat(64),
        privateKey: '3'.repeat(64),
        displayName: 'Gaming',
        derivationName: 'persona-1',
        avatarHash: 'cc'.repeat(32),
        avatarBlossomUrl: 'https://blossom.example.com',
        avatarKey: extraAvatarKey,
        avatarUpdatedAt: 3000,
      }],
    });
    await db.saveDependant(dep as unknown as Parameters<typeof db.saveDependant>[0], PASSPHRASE);

    // Raw record: avatarKey ciphertext on every slot.
    const raw = await rawOpen();
    const stored = await raw.get('identity', 'dependant:' + DEP_PUB);
    raw.close();
    expect(stored.naturalPerson.avatarKey).toBeDefined();
    expect(stored.naturalPerson.avatarKey).not.toBe(npAvatarKey);
    expect(stored.persona.avatarKey).not.toBe(personaAvatarKey);
    expect(stored.extraPersonas[0].avatarKey).not.toBe(extraAvatarKey);
    // Hash + URL stay clear.
    expect(stored.naturalPerson.avatarHash).toBe('aa'.repeat(32));
    expect(stored.persona.avatarBlossomUrl).toBe('https://blossom.example.com');
    expect(stored.extraPersonas[0].avatarUpdatedAt).toBe(3000);

    // Reload decrypted — avatar keys come back as the original hex.
    vi.resetModules();
    const db2 = await import('./db');
    const deps = await db2.getDependants(GUARDIAN, PASSPHRASE);
    expect(deps).toHaveLength(1);
    expect(deps[0].naturalPerson.avatarKey).toBe(npAvatarKey);
    expect(deps[0].naturalPerson.avatarHash).toBe('aa'.repeat(32));
    expect(deps[0].naturalPerson.avatarBlossomUrl).toBe('https://blossom.example.com');
    expect(deps[0].naturalPerson.avatarUpdatedAt).toBe(1000);
    expect(deps[0].persona.avatarKey).toBe(personaAvatarKey);
    expect(deps[0].extraPersonas![0].avatarKey).toBe(extraAvatarKey);
  }, TIMEOUT);

  it('dep without avatars round-trips with avatarKey === undefined', async () => {
    const db = await freshDb();
    const dep = makeDep(); // makeDep doesn't set avatar fields
    await db.saveDependant(dep as unknown as Parameters<typeof db.saveDependant>[0], PASSPHRASE);

    const raw = await rawOpen();
    const stored = await raw.get('identity', 'dependant:' + DEP_PUB);
    raw.close();
    expect(stored.naturalPerson.avatarKey).toBeUndefined();
    expect(stored.persona.avatarKey).toBeUndefined();

    vi.resetModules();
    const db2 = await import('./db');
    const deps = await db2.getDependants(GUARDIAN, PASSPHRASE);
    expect(deps[0].naturalPerson.avatarKey).toBeUndefined();
    expect(deps[0].persona.avatarKey).toBeUndefined();
  }, TIMEOUT);
});

// Trusted-app pairing slot per dependant.
// Covers the new ensureAppBunkerEndpoint / addAppBunkerPairing /
// removeAppBunkerPairing / listAppBunkerPairings / touchAppBunkerPairing
// helpers. The IDB layer encrypts the endpoint privateKey + pairingSecret;
// the pairings array is clear (only public-pubkey + label/origin/timestamps).
describe('Trusted-app endpoint', () => {
  const GUARDIAN = 'c'.repeat(64);
  const DEP_PUB = 'd'.repeat(64);

  function makeDep(overrides: Record<string, unknown> = {}) {
    return {
      id: DEP_PUB,
      guardianPubkey: GUARDIAN,
      displayName: 'Alice',
      naturalPerson: { publicKey: DEP_PUB, privateKey: '1'.repeat(64), displayName: 'Alice' },
      persona: { publicKey: 'e'.repeat(64), privateKey: '2'.repeat(64), displayName: 'Alice (anon)' },
      derivationPath: 'dependant-0',
      createdAt: Math.floor(Date.now() / 1000),
      autonomyStage: 'request-approve' as const,
      primaryKeypair: 'natural-person' as const,
      ...overrides,
    };
  }

  async function seedDep() {
    const db = await freshDb();
    const dep = makeDep();
    await db.saveDependant(dep as unknown as Parameters<typeof db.saveDependant>[0], PASSPHRASE);
    return db;
  }

  it('ensureAppBunkerEndpoint creates a fresh keypair when absent', async () => {
    const db = await seedDep();
    const ep = await db.ensureAppBunkerEndpoint(DEP_PUB, PASSPHRASE);
    expect(ep.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(ep.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(ep.createdAt).toBeGreaterThan(0);
    expect(ep.pairings).toEqual([]);
  }, TIMEOUT);

  it('ensureAppBunkerEndpoint is idempotent — second call returns the same endpoint', async () => {
    const db = await seedDep();
    const a = await db.ensureAppBunkerEndpoint(DEP_PUB, PASSPHRASE);
    const b = await db.ensureAppBunkerEndpoint(DEP_PUB, PASSPHRASE);
    expect(b.publicKey).toBe(a.publicKey);
    expect(b.privateKey).toBe(a.privateKey);
    expect(b.createdAt).toBe(a.createdAt);
  }, TIMEOUT);

  it('encrypts the app-bunker privateKey and pairingSecret at rest', async () => {
    const db = await seedDep();
    const ep = await db.ensureAppBunkerEndpoint(DEP_PUB, PASSPHRASE);
    await db.setAppBunkerPairingSecret(DEP_PUB, 'top-secret-pairing-string', PASSPHRASE);
    const raw = await rawOpen();
    const stored = await raw.get('identity', 'dependant:' + DEP_PUB);
    raw.close();
    expect(stored.appBunkerEndpoint).toBeDefined();
    expect(stored.appBunkerEndpoint.publicKey).toBe(ep.publicKey);
    expect(stored.appBunkerEndpoint.privateKey).not.toBe(ep.privateKey);
    expect(stored.appBunkerEndpoint.privateKey.length).toBeGreaterThan(0);
    expect(stored.appBunkerEndpoint.pairingSecret).not.toBe('top-secret-pairing-string');
  }, TIMEOUT);

  it('setAppBunkerPairingSecret + clearAppBunkerPairingSecret round-trip', async () => {
    const db = await seedDep();
    await db.ensureAppBunkerEndpoint(DEP_PUB, PASSPHRASE);
    await db.setAppBunkerPairingSecret(DEP_PUB, 'fresh-secret-for-pairing', PASSPHRASE);
    // Reload to verify decrypt path works.
    vi.resetModules();
    const db2 = await import('./db');
    const deps = await db2.getDependants(GUARDIAN, PASSPHRASE);
    expect(deps[0].appBunkerEndpoint?.pairingSecret).toBe('fresh-secret-for-pairing');
    await db2.clearAppBunkerPairingSecret(DEP_PUB, PASSPHRASE);
    const deps2 = await db2.getDependants(GUARDIAN, PASSPHRASE);
    expect(deps2[0].appBunkerEndpoint?.pairingSecret).toBeUndefined();
  }, TIMEOUT);

  it('addAppBunkerPairing appends a new pairing', async () => {
    const db = await seedDep();
    await db.ensureAppBunkerEndpoint(DEP_PUB, PASSPHRASE);
    await db.addAppBunkerPairing(DEP_PUB, {
      clientPubkey: 'aa'.repeat(32),
      label: 'Fathom',
      origin: 'https://fathom.example',
      pairedAt: 1000,
      lastSeenAt: 1000,
    }, PASSPHRASE);
    const list = await db.listAppBunkerPairings(DEP_PUB, PASSPHRASE);
    expect(list).toHaveLength(1);
    expect(list[0].clientPubkey).toBe('aa'.repeat(32));
    expect(list[0].label).toBe('Fathom');
    expect(list[0].origin).toBe('https://fathom.example');
  }, TIMEOUT);

  it('addAppBunkerPairing is idempotent — second call with same clientPubkey updates lastSeenAt rather than duplicating', async () => {
    const db = await seedDep();
    await db.ensureAppBunkerEndpoint(DEP_PUB, PASSPHRASE);
    const client = 'aa'.repeat(32);
    await db.addAppBunkerPairing(DEP_PUB, {
      clientPubkey: client, label: 'Fathom', pairedAt: 1000, lastSeenAt: 1000,
    }, PASSPHRASE);
    await db.addAppBunkerPairing(DEP_PUB, {
      clientPubkey: client, label: 'Fathom', pairedAt: 1000, lastSeenAt: 5000,
    }, PASSPHRASE);
    const list = await db.listAppBunkerPairings(DEP_PUB, PASSPHRASE);
    expect(list).toHaveLength(1);
    expect(list[0].lastSeenAt).toBe(5000);
  }, TIMEOUT);

  it('addAppBunkerPairing throws "pairing slot limit reached" when at cap', async () => {
    const db = await seedDep();
    await db.ensureAppBunkerEndpoint(DEP_PUB, PASSPHRASE);
    // Fill to TRUSTED_APP_PAIRING_CAP (= 5).
    for (let i = 0; i < 5; i++) {
      await db.addAppBunkerPairing(DEP_PUB, {
        clientPubkey: `${i.toString(16).padStart(2, '0')}`.repeat(32),
        label: `App ${i}`,
        pairedAt: 1000 + i,
      }, PASSPHRASE);
    }
    const list = await db.listAppBunkerPairings(DEP_PUB, PASSPHRASE);
    expect(list).toHaveLength(5);
    // The 6th distinct client should throw.
    await expect(db.addAppBunkerPairing(DEP_PUB, {
      clientPubkey: 'cc'.repeat(32),
      label: 'Sixth',
      pairedAt: 9999,
    }, PASSPHRASE)).rejects.toThrow('pairing slot limit reached');
  }, TIMEOUT);

  it('addAppBunkerPairingAndClearSecret writes pairing and nukes secret in one save', async () => {
    // TOCTOU regression — splitting the bind-write from the secret-clear
    // would leave a window where a second concurrent connect could pass
    // the (still-valid) secret check and consume an extra slot. The
    // atomic helper must persist both changes in the same dependant
    // record so the secret is gone the moment the first bind commits.
    const db = await seedDep();
    await db.ensureAppBunkerEndpoint(DEP_PUB, PASSPHRASE);
    await db.setAppBunkerPairingSecret(DEP_PUB, 'one-shot-secret', PASSPHRASE);

    // Confirm the secret is present pre-bind.
    const before = await db.getDependants(GUARDIAN, PASSPHRASE);
    expect(before[0].appBunkerEndpoint?.pairingSecret).toBe('one-shot-secret');

    await db.addAppBunkerPairingAndClearSecret(DEP_PUB, {
      clientPubkey: 'aa'.repeat(32),
      label: 'Fathom',
      origin: 'https://fathom.example',
      pairedAt: 1000,
      lastSeenAt: 1000,
    }, PASSPHRASE);

    // Both effects: pairing appended, secret cleared.
    const after = await db.getDependants(GUARDIAN, PASSPHRASE);
    expect(after[0].appBunkerEndpoint?.pairings).toHaveLength(1);
    expect(after[0].appBunkerEndpoint?.pairings[0].clientPubkey).toBe('aa'.repeat(32));
    expect(after[0].appBunkerEndpoint?.pairingSecret).toBeUndefined();
  }, TIMEOUT);

  it('addAppBunkerPairingAndClearSecret throws on cap and leaves the existing secret intact', async () => {
    const db = await seedDep();
    await db.ensureAppBunkerEndpoint(DEP_PUB, PASSPHRASE);
    await db.setAppBunkerPairingSecret(DEP_PUB, 'still-valid', PASSPHRASE);
    for (let i = 0; i < 5; i++) {
      await db.addAppBunkerPairing(DEP_PUB, {
        clientPubkey: `${i.toString(16).padStart(2, '0')}`.repeat(32),
        label: `App ${i}`,
        pairedAt: 1000 + i,
      }, PASSPHRASE);
    }
    await expect(db.addAppBunkerPairingAndClearSecret(DEP_PUB, {
      clientPubkey: 'cc'.repeat(32),
      label: 'Sixth',
      pairedAt: 9999,
    }, PASSPHRASE)).rejects.toThrow('pairing slot limit reached');

    // Cap rejection MUST NOT clear the secret — otherwise the in-flight
    // pair window vanishes for the legitimate consumer that's still
    // about to connect with that secret.
    const after = await db.getDependants(GUARDIAN, PASSPHRASE);
    expect(after[0].appBunkerEndpoint?.pairingSecret).toBe('still-valid');
  }, TIMEOUT);

  it('removeAppBunkerPairing removes by clientPubkey; no-op when not present', async () => {
    const db = await seedDep();
    await db.ensureAppBunkerEndpoint(DEP_PUB, PASSPHRASE);
    await db.addAppBunkerPairing(DEP_PUB, {
      clientPubkey: 'aa'.repeat(32), label: 'Fathom', pairedAt: 1000,
    }, PASSPHRASE);
    await db.addAppBunkerPairing(DEP_PUB, {
      clientPubkey: 'bb'.repeat(32), label: 'Other', pairedAt: 2000,
    }, PASSPHRASE);
    await db.removeAppBunkerPairing(DEP_PUB, 'aa'.repeat(32), PASSPHRASE);
    const list = await db.listAppBunkerPairings(DEP_PUB, PASSPHRASE);
    expect(list).toHaveLength(1);
    expect(list[0].clientPubkey).toBe('bb'.repeat(32));

    // No-op when absent.
    await db.removeAppBunkerPairing(DEP_PUB, 'ff'.repeat(32), PASSPHRASE);
    const list2 = await db.listAppBunkerPairings(DEP_PUB, PASSPHRASE);
    expect(list2).toHaveLength(1);
  }, TIMEOUT);

  it('listAppBunkerPairings returns the array', async () => {
    const db = await seedDep();
    await db.ensureAppBunkerEndpoint(DEP_PUB, PASSPHRASE);
    expect(await db.listAppBunkerPairings(DEP_PUB, PASSPHRASE)).toEqual([]);
    await db.addAppBunkerPairing(DEP_PUB, {
      clientPubkey: 'aa'.repeat(32), label: 'A', pairedAt: 1,
    }, PASSPHRASE);
    const list = await db.listAppBunkerPairings(DEP_PUB, PASSPHRASE);
    expect(list).toHaveLength(1);
  }, TIMEOUT);

  it('touchAppBunkerPairing updates lastSeenAt', async () => {
    const db = await seedDep();
    await db.ensureAppBunkerEndpoint(DEP_PUB, PASSPHRASE);
    const client = 'aa'.repeat(32);
    await db.addAppBunkerPairing(DEP_PUB, {
      clientPubkey: client, label: 'A', pairedAt: 1000, lastSeenAt: 1000,
    }, PASSPHRASE);
    await db.touchAppBunkerPairing(DEP_PUB, client, PASSPHRASE);
    const list = await db.listAppBunkerPairings(DEP_PUB, PASSPHRASE);
    expect(list[0].lastSeenAt).toBeGreaterThanOrEqual(1000);
    // No-op when client is missing.
    await db.touchAppBunkerPairing(DEP_PUB, 'ff'.repeat(32), PASSPHRASE);
    const list2 = await db.listAppBunkerPairings(DEP_PUB, PASSPHRASE);
    expect(list2).toHaveLength(1);
  }, TIMEOUT);
});

describe('Remembered grants', () => {
  const DEP_A = 'a'.repeat(64);
  const DEP_B = 'b'.repeat(64);

  it('saves and looks up by compound key', async () => {
    const db = await freshDb();
    await db.saveGrant({
      dependantId: DEP_A,
      scope: 'sign-in',
      origin: 'https://roblox.com',
      decision: 'allow',
      decidedAt: 100,
    });
    const got = await db.lookupGrant(DEP_A, 'sign-in', 'https://roblox.com');
    expect(got?.decision).toBe('allow');
    expect(got?.dependantId).toBe(DEP_A);
    expect(got?.scope).toBe('sign-in');
    expect(got?.origin).toBe('https://roblox.com');
  });

  it('case-normalises dependantId and origin on key lookup', async () => {
    const db = await freshDb();
    await db.saveGrant({
      dependantId: DEP_A.toUpperCase(),
      scope: 'sign-in',
      origin: 'HTTPS://ROBLOX.COM',
      decision: 'allow',
      decidedAt: 100,
    });
    const got = await db.lookupGrant(DEP_A, 'sign-in', 'https://roblox.com');
    expect(got?.decision).toBe('allow');
  });

  it('scopes grants by (dependantId, scope, origin) — no leakage', async () => {
    const db = await freshDb();
    await db.saveGrant({
      dependantId: DEP_A, scope: 'sign-in', origin: 'https://roblox.com', decision: 'allow', decidedAt: 1,
    });

    // Different dependant — miss
    expect(await db.lookupGrant(DEP_B, 'sign-in', 'https://roblox.com')).toBeUndefined();
    // Different scope — miss
    expect(await db.lookupGrant(DEP_A, 'dm-private', 'https://roblox.com')).toBeUndefined();
    // Different origin — miss
    expect(await db.lookupGrant(DEP_A, 'sign-in', 'https://other.com')).toBeUndefined();
  });

  it('upserts on save (last-write-wins)', async () => {
    const db = await freshDb();
    await db.saveGrant({
      dependantId: DEP_A, scope: 'sign-in', origin: 'https://roblox.com', decision: 'allow', decidedAt: 1,
    });
    await db.saveGrant({
      dependantId: DEP_A, scope: 'sign-in', origin: 'https://roblox.com', decision: 'deny', decidedAt: 2,
    });
    const got = await db.lookupGrant(DEP_A, 'sign-in', 'https://roblox.com');
    expect(got?.decision).toBe('deny');
    expect(got?.decidedAt).toBe(2);
  });

  it('revokes a specific grant without touching others', async () => {
    const db = await freshDb();
    await db.saveGrant({ dependantId: DEP_A, scope: 'sign-in', origin: 'https://roblox.com', decision: 'allow', decidedAt: 1 });
    await db.saveGrant({ dependantId: DEP_A, scope: 'dm-private', origin: 'a'.repeat(64), decision: 'allow', decidedAt: 1 });

    await db.revokeGrant(DEP_A, 'sign-in', 'https://roblox.com');

    expect(await db.lookupGrant(DEP_A, 'sign-in', 'https://roblox.com')).toBeUndefined();
    expect(await db.lookupGrant(DEP_A, 'dm-private', 'a'.repeat(64))).toBeDefined();
  });

  it('lists all grants for a dependant via dependantId index', async () => {
    const db = await freshDb();
    await db.saveGrant({ dependantId: DEP_A, scope: 'sign-in', origin: 'https://r.com', decision: 'allow', decidedAt: 1 });
    await db.saveGrant({ dependantId: DEP_A, scope: 'dm-private', origin: 'b'.repeat(64), decision: 'deny', decidedAt: 2 });
    await db.saveGrant({ dependantId: DEP_B, scope: 'sign-in', origin: 'https://r.com', decision: 'allow', decidedAt: 3 });

    const forA = await db.listGrantsForDependant(DEP_A);
    expect(forA.length).toBe(2);
    expect(forA.every(g => g.dependantId === DEP_A)).toBe(true);

    const forB = await db.listGrantsForDependant(DEP_B);
    expect(forB.length).toBe(1);
  });

  it('bulk-deletes all grants for a single dependant', async () => {
    const db = await freshDb();
    await db.saveGrant({ dependantId: DEP_A, scope: 'sign-in', origin: 'https://r.com', decision: 'allow', decidedAt: 1 });
    await db.saveGrant({ dependantId: DEP_A, scope: 'dm-private', origin: 'b'.repeat(64), decision: 'allow', decidedAt: 2 });
    await db.saveGrant({ dependantId: DEP_B, scope: 'sign-in', origin: 'https://r.com', decision: 'allow', decidedAt: 3 });

    await db.deleteGrantsForDependant(DEP_A);

    expect(await db.listGrantsForDependant(DEP_A)).toEqual([]);
    expect((await db.listGrantsForDependant(DEP_B)).length).toBe(1);
  });

  it('case-insensitive scope matching: saved "Sign-In" lookups as "sign-in"', async () => {
    const db = await freshDb();
    // Simulate a future caller normalisation drift — save a grant with mixed-
    // case scope and ensure lookupGrant still finds it.
    await db.saveGrant({
      dependantId: DEP_A, scope: 'Sign-In', origin: 'https://r.com', decision: 'allow', decidedAt: 1,
    });
    const viaLower = await db.lookupGrant(DEP_A, 'sign-in', 'https://r.com');
    const viaUpper = await db.lookupGrant(DEP_A, 'SIGN-IN', 'https://r.com');
    expect(viaLower?.decision).toBe('allow');
    expect(viaUpper?.decision).toBe('allow');
  });

  it('case-insensitive scope revocation', async () => {
    const db = await freshDb();
    await db.saveGrant({ dependantId: DEP_A, scope: 'sign-in', origin: 'https://r.com', decision: 'allow', decidedAt: 1 });
    await db.revokeGrant(DEP_A, 'Sign-In', 'https://r.com');
    expect(await db.lookupGrant(DEP_A, 'sign-in', 'https://r.com')).toBeUndefined();
  });

  it('rejects invalid dependantId', async () => {
    const db = await freshDb();
    await expect(db.saveGrant({
      dependantId: 'not-hex', scope: 'sign-in', origin: 'https://r.com', decision: 'allow', decidedAt: 1,
    })).rejects.toThrow(/Invalid dependantId/);
  });

  it('rejects invalid decision', async () => {
    const db = await freshDb();
    await expect(db.saveGrant({
      dependantId: DEP_A, scope: 'sign-in', origin: 'https://r.com',
      decision: 'maybe' as 'allow' | 'deny', decidedAt: 1,
    })).rejects.toThrow(/Invalid decision/);
  });

  it('lookupGrant treats expired grants as absent', async () => {
    const db = await freshDb();
    const nowSeconds = Math.floor(Date.now() / 1000);
    // Expired 60s ago
    await db.saveGrant({
      dependantId: DEP_A,
      scope: 'sign-in',
      origin: 'https://roblox.com',
      decision: 'allow',
      decidedAt: nowSeconds - 3600,
      expiresAt: nowSeconds - 60,
    });
    expect(await db.lookupGrant(DEP_A, 'sign-in', 'https://roblox.com')).toBeUndefined();
  });

  it('lookupGrant returns grants with future expiresAt normally', async () => {
    const db = await freshDb();
    const nowSeconds = Math.floor(Date.now() / 1000);
    await db.saveGrant({
      dependantId: DEP_A,
      scope: 'sign-in',
      origin: 'https://roblox.com',
      decision: 'allow',
      decidedAt: nowSeconds,
      expiresAt: nowSeconds + 3600,
    });
    const got = await db.lookupGrant(DEP_A, 'sign-in', 'https://roblox.com');
    expect(got?.decision).toBe('allow');
  });

  it('lookupGrant ignores expiresAt when 0 / undefined (legacy / no-expiry grants)', async () => {
    const db = await freshDb();
    await db.saveGrant({
      dependantId: DEP_A, scope: 'sign-in', origin: 'https://r.com',
      decision: 'allow', decidedAt: 1, // no expiresAt
    });
    expect((await db.lookupGrant(DEP_A, 'sign-in', 'https://r.com'))?.decision).toBe('allow');

    await db.saveGrant({
      dependantId: DEP_A, scope: 'sign-in', origin: 'https://r2.com',
      decision: 'allow', decidedAt: 1, expiresAt: 0, // explicit 0 = no-expiry
    });
    expect((await db.lookupGrant(DEP_A, 'sign-in', 'https://r2.com'))?.decision).toBe('allow');
  });

  it('revokeGrant writes a tombstone that lookup filters but the sync helper keeps', async () => {
    // Revocations soft-delete. The tombstoned row must survive in IDB
    // so grants-sync can broadcast it to the guardian's other devices.
    const db = await freshDb();
    await db.saveGrant({
      dependantId: DEP_A, scope: 'sign-in', origin: 'https://r.com',
      decision: 'allow', decidedAt: 1,
    });
    await db.revokeGrant(DEP_A, 'sign-in', 'https://r.com');

    // Visible-to-callers APIs hide the tombstoned record.
    expect(await db.lookupGrant(DEP_A, 'sign-in', 'https://r.com')).toBeUndefined();
    expect(await db.listAllGrants()).toEqual([]);
    expect(await db.listGrantsForDependant(DEP_A)).toEqual([]);

    // Sync-facing API still sees it (and shows it was tombstoned).
    const withTombstones = await db.listAllGrantsIncludingTombstones();
    expect(withTombstones).toHaveLength(1);
    expect(withTombstones[0].tombstonedAt).toBeGreaterThan(0);
  });

  it('revokeGrant seeds a tombstone when nothing local existed', async () => {
    // Scenario: phone B revokes a grant that only exists on phone A. On
    // next sync phone B's fresh tombstone supersedes phone A's allow.
    const db = await freshDb();
    await db.revokeGrant(DEP_A, 'sign-in', 'https://newly-blocked.com');
    const withTombstones = await db.listAllGrantsIncludingTombstones();
    expect(withTombstones).toHaveLength(1);
    expect(withTombstones[0].tombstonedAt).toBeGreaterThan(0);
    expect(withTombstones[0].origin).toBe('https://newly-blocked.com');
  });
});

describe('Paired-child status cache', () => {
  const CHILD_A = 'a'.repeat(64);
  const CHILD_B = 'b'.repeat(64);

  it('round-trips the cached status and loads it back', async () => {
    const db = await freshDb();
    await db.savePairedChildStatus({
      dependantPubkey: CHILD_A,
      stage: 'full-control',
      updatedAt: 1000,
      lastSyncedAt: 1500,
      guardianName: 'Mum',
    });
    const loaded = await db.loadPairedChildStatus(CHILD_A);
    expect(loaded?.stage).toBe('full-control');
    expect(loaded?.guardianName).toBe('Mum');
    expect(loaded?.id).toBe(CHILD_A);
  });

  it('returns null when no status has ever been cached', async () => {
    const db = await freshDb();
    expect(await db.loadPairedChildStatus(CHILD_A)).toBeNull();
  });

  it('overwrites on re-save for the SAME dependant', async () => {
    const db = await freshDb();
    await db.savePairedChildStatus({ dependantPubkey: CHILD_A, stage: 'full-control', updatedAt: 100, lastSyncedAt: 150 });
    await db.savePairedChildStatus({ dependantPubkey: CHILD_A, stage: 'request-approve', updatedAt: 200, lastSyncedAt: 250 });
    const loaded = await db.loadPairedChildStatus(CHILD_A);
    expect(loaded?.stage).toBe('request-approve');
    expect(loaded?.updatedAt).toBe(200);
  });

  // M10 (2026-07-02 audit): the cache is keyed per-dependant, not a single
  // fixed row — a shared family device holding multiple pairings must not
  // let one child's status clobber another's.
  it('keeps separate rows for two different dependants on the same device', async () => {
    const db = await freshDb();
    await db.savePairedChildStatus({ dependantPubkey: CHILD_A, stage: 'full-control', updatedAt: 100, lastSyncedAt: 150 });
    await db.savePairedChildStatus({ dependantPubkey: CHILD_B, stage: 'full-autonomy', updatedAt: 200, lastSyncedAt: 250 });

    const loadedA = await db.loadPairedChildStatus(CHILD_A);
    const loadedB = await db.loadPairedChildStatus(CHILD_B);
    expect(loadedA?.stage).toBe('full-control');
    expect(loadedB?.stage).toBe('full-autonomy');
  });

  it('clearPairedChildStatus removes only the targeted dependant\'s row', async () => {
    const db = await freshDb();
    await db.savePairedChildStatus({ dependantPubkey: CHILD_A, stage: 'full-control', updatedAt: 1, lastSyncedAt: 2 });
    await db.savePairedChildStatus({ dependantPubkey: CHILD_B, stage: 'full-autonomy', updatedAt: 1, lastSyncedAt: 2 });

    await db.clearPairedChildStatus(CHILD_A);

    expect(await db.loadPairedChildStatus(CHILD_A)).toBeNull();
    expect(await db.loadPairedChildStatus(CHILD_B)).not.toBeNull();
  });

  it('purgeAllUserData wipes the status cache alongside other stores', async () => {
    const db = await freshDb();
    await db.savePairedChildStatus({ dependantPubkey: CHILD_A, stage: 'full-control', updatedAt: 1, lastSyncedAt: 2 });
    await db.purgeAllUserData();
    expect(await db.loadPairedChildStatus(CHILD_A)).toBeNull();
  });
});

describe('Paired-child persona-inventory revision cache (#persona-sync)', () => {
  it('save then load returns the saved revision', async () => {
    const db = await freshDb();
    await db.savePairedChildPersonaRevision(12345);
    expect(await db.loadPairedChildPersonaRevision()).toBe(12345);
  });

  it('load with no prior save returns 0', async () => {
    const db = await freshDb();
    expect(await db.loadPairedChildPersonaRevision()).toBe(0);
  });

  it('clear then load returns 0', async () => {
    const db = await freshDb();
    await db.savePairedChildPersonaRevision(99999);
    await db.clearPairedChildPersonaRevision();
    expect(await db.loadPairedChildPersonaRevision()).toBe(0);
  });

  it('overwrites on re-save (single-row semantic)', async () => {
    const db = await freshDb();
    await db.savePairedChildPersonaRevision(100);
    await db.savePairedChildPersonaRevision(200);
    expect(await db.loadPairedChildPersonaRevision()).toBe(200);
  });

  it('purgeAllUserData wipes the revision cache alongside other stores', async () => {
    const db = await freshDb();
    await db.savePairedChildPersonaRevision(42);
    await db.purgeAllUserData();
    expect(await db.loadPairedChildPersonaRevision()).toBe(0);
  });
});

describe('Paired-child record', () => {
  const DEP = 'c'.repeat(64);
  const CLIENT_PUB = '1'.repeat(64);
  const CLIENT_PRIV = '2'.repeat(64);
  const BUNKER_URI = `bunker://${'a'.repeat(64)}?relay=wss%3A%2F%2Frelay.example.com&secret=deadbeefdeadbeefdeadbeefdeadbeef&dependant=${DEP}&name=Alice`;

  function valid() {
    return {
      bunkerUri: BUNKER_URI,
      clientKeypair: { publicKey: CLIENT_PUB, privateKey: CLIENT_PRIV },
      dependantPubkey: DEP,
      dependantName: 'Alice',
      pairedAt: 1_700_000_000,
    };
  }

  it('round-trips an encrypted record (raw record has encrypted fields)', async () => {
    const db = await freshDb();
    await db.savePairedChild(valid(), PASSPHRASE);

    const raw = await rawOpen();
    // After multi-pairing support, the row is keyed on the dependant pubkey rather than a
    // fixed 'paired-child-current' constant — one row per child.
    const stored = await raw.get('pairedChild', DEP);
    raw.close();
    expect(stored).toBeDefined();
    expect(stored.encrypted).toBe(true);
    expect(stored.bunkerUri).not.toBe(BUNKER_URI); // encrypted
    expect(stored.clientKeypair.privateKey).not.toBe(CLIENT_PRIV); // encrypted
    expect(stored.clientKeypair.publicKey).toBe(CLIENT_PUB); // public stays plain
    expect(stored.dependantPubkey).toBe(DEP);
    expect(stored.dependantName).toBe('Alice');

    vi.resetModules();
    const db2 = await import('./db');
    const loaded = await db2.loadPairedChild(DEP, PASSPHRASE);
    expect(loaded).toBeDefined();
    expect(loaded!.bunkerUri).toBe(BUNKER_URI);
    expect(loaded!.clientKeypair.privateKey).toBe(CLIENT_PRIV);
    expect(loaded!.clientKeypair.publicKey).toBe(CLIENT_PUB);
    expect(loaded!.dependantPubkey).toBe(DEP);
    expect(loaded!.dependantName).toBe('Alice');
  }, TIMEOUT);

  it('loadPairedChild returns null when no record exists', async () => {
    const db = await freshDb();
    expect(await db.loadPairedChild(DEP, PASSPHRASE)).toBeNull();
  }, TIMEOUT);

  it('loadPairedChild returns null on wrong passphrase', async () => {
    const db = await freshDb();
    await db.savePairedChild(valid(), PASSPHRASE);
    vi.resetModules();
    const db2 = await import('./db');
    expect(await db2.loadPairedChild(DEP, 'wrong-passphrase-abc')).toBeNull();
  }, TIMEOUT);

  it('loadPairedChild throws if the stored record is not encrypted (devtools / corruption)', async () => {
    const raw = await rawOpen();
    await raw.put('pairedChild', {
      id: DEP,
      bunkerUri: BUNKER_URI,
      clientKeypair: { publicKey: CLIENT_PUB, privateKey: CLIENT_PRIV },
      dependantPubkey: DEP,
      dependantName: 'Alice',
      pairedAt: 1,
      // encrypted: true is the only way savePairedChild writes
    });
    raw.close();

    vi.resetModules();
    const db = await import('./db');
    await expect(db.loadPairedChild(DEP, PASSPHRASE)).rejects.toThrow(/not encrypted/);
  }, TIMEOUT);

  it('listPairedChildMetas returns labels without decrypting anything', async () => {
    const db = await freshDb();
    await db.savePairedChild(valid(), PASSPHRASE);
    const metas = await db.listPairedChildMetas();
    expect(metas).toHaveLength(1);
    expect(metas[0]).toEqual({
      dependantPubkey: DEP,
      dependantName: 'Alice',
      pairedAt: 1_700_000_000,
    });
  }, TIMEOUT);

  it('listPairedChildMetas returns an empty array when no records exist', async () => {
    const db = await freshDb();
    expect(await db.listPairedChildMetas()).toEqual([]);
  }, TIMEOUT);

  it('listPairedChildMetas holds one row per child and sorts newest-first', async () => {
    const db = await freshDb();
    const DEP2 = 'd'.repeat(64);
    await db.savePairedChild({ ...valid(), pairedAt: 100 }, PASSPHRASE);
    await db.savePairedChild({
      ...valid(),
      dependantPubkey: DEP2,
      dependantName: 'Bob',
      pairedAt: 200,
    }, PASSPHRASE);
    const metas = await db.listPairedChildMetas();
    expect(metas).toHaveLength(2);
    expect(metas[0].dependantPubkey).toBe(DEP2);
    expect(metas[1].dependantPubkey).toBe(DEP);
  }, TIMEOUT);

  it('clearPairedChild removes only the targeted record', async () => {
    const db = await freshDb();
    const DEP2 = 'd'.repeat(64);
    await db.savePairedChild(valid(), PASSPHRASE);
    await db.savePairedChild({
      ...valid(),
      dependantPubkey: DEP2,
      dependantName: 'Bob',
    }, PASSPHRASE);
    await db.clearPairedChild(DEP);
    const metas = await db.listPairedChildMetas();
    expect(metas).toHaveLength(1);
    expect(metas[0].dependantPubkey).toBe(DEP2);
  }, TIMEOUT);

  it('clearAllPairedChildren wipes the whole store', async () => {
    const db = await freshDb();
    const DEP2 = 'd'.repeat(64);
    await db.savePairedChild(valid(), PASSPHRASE);
    await db.savePairedChild({ ...valid(), dependantPubkey: DEP2, dependantName: 'Bob' }, PASSPHRASE);
    await db.clearAllPairedChildren();
    expect(await db.listPairedChildMetas()).toEqual([]);
  }, TIMEOUT);

  it('savePairedChild rejects short passphrase', async () => {
    const db = await freshDb();
    await expect(db.savePairedChild(valid(), 'short')).rejects.toThrow();
  }, TIMEOUT);

  it('savePairedChild rejects a non-bunker URI', async () => {
    const db = await freshDb();
    await expect(db.savePairedChild({
      ...valid(),
      bunkerUri: 'nostrconnect://abc?relay=wss://x',
    }, PASSPHRASE)).rejects.toThrow(/bunkerUri/);
  }, TIMEOUT);

  it('savePairedChild rejects malformed client keypair', async () => {
    const db = await freshDb();
    await expect(db.savePairedChild({
      ...valid(),
      clientKeypair: { publicKey: 'not-hex', privateKey: CLIENT_PRIV },
    }, PASSPHRASE)).rejects.toThrow(/client keypair/);
  }, TIMEOUT);

  it('savePairedChild rejects empty dependant name', async () => {
    const db = await freshDb();
    await expect(db.savePairedChild({
      ...valid(),
      dependantName: '',
    }, PASSPHRASE)).rejects.toThrow(/dependantName/);
  }, TIMEOUT);

  it('purgeAllUserData clears the paired-child record', async () => {
    const db = await freshDb();
    await db.savePairedChild(valid(), PASSPHRASE);
    await db.purgeAllUserData();
    expect(await db.listPairedChildMetas()).toEqual([]);
  }, TIMEOUT);

  it('savePairedChild + loadPairedChild default hasPaired to false', async () => {
    const db = await freshDb();
    await db.savePairedChild(valid(), PASSPHRASE);
    const loaded = await db.loadPairedChild(DEP, PASSPHRASE);
    expect(loaded?.hasPaired).toBe(false);
  }, TIMEOUT);

  it('savePairedChild persists an explicit hasPaired: true', async () => {
    const db = await freshDb();
    await db.savePairedChild({ ...valid(), hasPaired: true }, PASSPHRASE);
    const loaded = await db.loadPairedChild(DEP, PASSPHRASE);
    expect(loaded?.hasPaired).toBe(true);
  }, TIMEOUT);

  it('markPairedChildConnected flips hasPaired from false to true', async () => {
    const db = await freshDb();
    await db.savePairedChild(valid(), PASSPHRASE);
    await db.markPairedChildConnected(DEP, PASSPHRASE);
    const loaded = await db.loadPairedChild(DEP, PASSPHRASE);
    expect(loaded?.hasPaired).toBe(true);
  }, TIMEOUT);

  it('markPairedChildConnected is a no-op when hasPaired is already true', async () => {
    const db = await freshDb();
    await db.savePairedChild({ ...valid(), hasPaired: true, pairedAt: 111 }, PASSPHRASE);
    await db.markPairedChildConnected(DEP, PASSPHRASE);
    const loaded = await db.loadPairedChild(DEP, PASSPHRASE);
    // pairedAt should survive (not re-saved) since no-op returned early
    expect(loaded?.pairedAt).toBe(111);
  }, TIMEOUT);

  it('markPairedChildConnected is a no-op when no record exists', async () => {
    const db = await freshDb();
    await expect(db.markPairedChildConnected(DEP, PASSPHRASE)).resolves.toBeUndefined();
  }, TIMEOUT);
});

describe('v10 migration: paired-child-current → dependantPubkey re-key', () => {
  // Regression guard. Pre-v10 the pairedChild
  // store held at most one row with id 'paired-child-current'. Post-v10
  // the row key is the dependant pubkey so multiple pairings can coexist
  // on one device. The migration must re-key any existing row in place,
  // otherwise the next write at the new key produces a duplicate and the
  // load-by-pubkey path can't find the original.
  it('re-keys the legacy row to its dependantPubkey and drops the old id', async () => {
    const { openDB } = await import('idb');
    const DEP = 'f'.repeat(64);

    // Seed a v9 database with the legacy single-row shape.
    const v9 = await openDB('my-signet', 9, {
      upgrade(d) {
        d.createObjectStore('identity', { keyPath: 'id' });
        d.createObjectStore('contacts', { keyPath: 'pubkey' });
        d.createObjectStore('child-settings', { keyPath: 'childPubkey' });
        d.createObjectStore('preferences', { keyPath: 'id' });
        d.createObjectStore('documents', { keyPath: 'id' });
        d.createObjectStore('credentials', { keyPath: 'id' });
        d.createObjectStore('authorizedSites', { keyPath: 'id' });
        d.createObjectStore('originPolicies', { keyPath: 'origin' });
        d.createObjectStore('connectedClients', { keyPath: 'clientPubkey' });
        d.createObjectStore('grants', { keyPath: ['dependantId', 'scope', 'origin'] });
        d.createObjectStore('pairedChild', { keyPath: 'id' });
        d.createObjectStore('pairedChildStatus', { keyPath: 'id' });
      },
    });
    await v9.put('pairedChild', {
      id: 'paired-child-current',
      bunkerUri: 'encrypted',
      clientKeypair: { publicKey: 'a'.repeat(64), privateKey: 'encrypted' },
      dependantPubkey: DEP,
      dependantName: 'Alice',
      pairedAt: 1700000000,
      hasPaired: true,
      encrypted: true,
    });
    v9.close();

    // Reopen via db.ts — the upgrade to current version runs.
    await freshDb().then(m => m.getPreferences());
    const v11 = await openDB('my-signet');
    const oldRow = await v11.get('pairedChild', 'paired-child-current');
    const newRow = await v11.get('pairedChild', DEP);
    expect(oldRow).toBeUndefined();
    expect(newRow).toBeDefined();
    expect(newRow?.dependantPubkey).toBe(DEP);
    expect(newRow?.id).toBe(DEP);
    expect(newRow?.dependantName).toBe('Alice');
    expect(newRow?.encrypted).toBe(true);
  }, TIMEOUT);

  it('leaves rows with a malformed dependantPubkey alone (refuses to strand them under a bad key)', async () => {
    const { openDB } = await import('idb');

    const v9 = await openDB('my-signet', 9, {
      upgrade(d) {
        d.createObjectStore('identity', { keyPath: 'id' });
        d.createObjectStore('contacts', { keyPath: 'pubkey' });
        d.createObjectStore('child-settings', { keyPath: 'childPubkey' });
        d.createObjectStore('preferences', { keyPath: 'id' });
        d.createObjectStore('documents', { keyPath: 'id' });
        d.createObjectStore('credentials', { keyPath: 'id' });
        d.createObjectStore('authorizedSites', { keyPath: 'id' });
        d.createObjectStore('originPolicies', { keyPath: 'origin' });
        d.createObjectStore('connectedClients', { keyPath: 'clientPubkey' });
        d.createObjectStore('grants', { keyPath: ['dependantId', 'scope', 'origin'] });
        d.createObjectStore('pairedChild', { keyPath: 'id' });
        d.createObjectStore('pairedChildStatus', { keyPath: 'id' });
      },
    });
    await v9.put('pairedChild', {
      id: 'paired-child-current',
      dependantPubkey: 'not-hex',
      dependantName: 'Alice',
      pairedAt: 1,
      encrypted: true,
      bunkerUri: 'x',
      clientKeypair: { publicKey: 'x', privateKey: 'x' },
    });
    v9.close();

    await freshDb().then(m => m.getPreferences());
    const v11 = await openDB('my-signet');
    // Corrupted row stays where it was — migration refuses to re-key
    // under an invalid pubkey. Better to leave it inspectable than to
    // silently place it at a bogus keyPath.
    const still = await v11.get('pairedChild', 'paired-child-current');
    expect(still).toBeDefined();
  }, TIMEOUT);
});

describe('v4 migration: family → contacts copy', () => {
  // Regression: a prior implementation called deleteObjectStore('family')
  // synchronously during the upgrade, while openCursor() was still
  // iterating asynchronously — silently dropping every record being
  // copied. The fixed path chains deleteObjectStore into the cursor's
  // terminating branch.
  it('copies every family record into contacts before deleting the old store', async () => {
    const { openDB } = await import('idb');

    // Stand up a v3 database with a populated 'family' store.
    const v3 = await openDB('my-signet', 3, {
      upgrade(d) {
        d.createObjectStore('identity', { keyPath: 'id' });
        const family = d.createObjectStore('family', { keyPath: 'pubkey' });
        family.createIndex('ownerPubkey', 'ownerPubkey');
        d.createObjectStore('child-settings', { keyPath: 'childPubkey' });
        d.createObjectStore('preferences', { keyPath: 'id' });
        d.createObjectStore('documents', { keyPath: 'id' }).createIndex('ownerPubkey', 'ownerPubkey');
        d.createObjectStore('credentials', { keyPath: 'id' }).createIndex('documentId', 'documentId');
        d.createObjectStore('authorizedSites', { keyPath: 'id' }).createIndex('origin', 'origin');
      },
    });
    // Seed ten rows — enough that a buggy migration would drop a visible fraction.
    for (let i = 0; i < 10; i++) {
      await v3.put('family', { pubkey: `pk${i}`.padEnd(64, '0'), ownerPubkey: 'owner', displayName: `m${i}` });
    }
    v3.close();

    // Now open at current version — this triggers the v4 migration.
    // Touching any exported function wakes the singleton and forces upgrade.
    await freshDb().then(m => m.getPreferences());
    const { openDB: openDBAgain } = await import('idb');
    const full = await (await openDBAgain('my-signet')).getAll('contacts');
    expect(full.length).toBe(10);
    expect(full.map(r => r.pubkey).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `pk${i}`.padEnd(64, '0')).sort()
    );
  }, TIMEOUT);
});

describe('DB v11 — professional stores', () => {
  it('professionalRegistry store exists after upgrade', async () => {
    // Force a fresh DB instance by using a unique name.
    const { openDB } = await import('idb');
    const db = await openDB('test-professional-v11', 11, {
      upgrade(database, oldVersion) {
        if (oldVersion < 11) {
          database.createObjectStore('professionalRegistry', { keyPath: 'canonicalKey' });
          database.createObjectStore('professionalSignetJson', { keyPath: 'canonicalDomain' });
        }
      },
    });
    expect(db.objectStoreNames.contains('professionalRegistry')).toBe(true);
    expect(db.objectStoreNames.contains('professionalSignetJson')).toBe(true);
    db.close();
  });
});

describe('getProRegistryRecord / invalidateProRegistryRecord — profession-kind cache key (M5)', () => {
  function record(overrides: Partial<import('./professional/types').RegulatedEntityRecord> = {}): import('./professional/types').RegulatedEntityRecord {
    return {
      professionKind: 'school',
      jurisdiction: 'england',
      registry: 'GIAS',
      identifier: '100000',
      identifierKind: 'URN',
      name: 'Springfield School',
      status: 'Active',
      website: 'springfield.sch.uk',
      inferredCandidateWebsite: null,
      postcode: 'SP1 1AA',
      locality: 'Springfield',
      tags: [],
      fetchedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('does NOT return a colliding record from a different profession/registry with the same identifier', async () => {
    const db = await freshDb();
    const schoolRecord = record({ professionKind: 'school', registry: 'GIAS', identifier: '100000', name: 'Springfield School' });
    const firmRecord = record({ professionKind: 'solicitor-firm', registry: 'SRA', identifier: '100000', name: 'Springfield Solicitors', identifierKind: 'SRA-FirmNumber' });

    await db.setProRegistryRecord('100000', schoolRecord);
    await db.setProRegistryRecord('100000', firmRecord);

    const gotSchool = await db.getProRegistryRecord('100000', 'school');
    const gotFirm = await db.getProRegistryRecord('100000', 'solicitor-firm');

    expect(gotSchool?.record.name).toBe('Springfield School');
    expect(gotFirm?.record.name).toBe('Springfield Solicitors');
  });

  it('returns null for a profession kind that has no cached record, even when the identifier collides', async () => {
    const db = await freshDb();
    await db.setProRegistryRecord('100000', record({ professionKind: 'school' }));

    const gotFirm = await db.getProRegistryRecord('100000', 'solicitor-firm');
    expect(gotFirm).toBeNull();
  });

  it('invalidateProRegistryRecord removes only the matching profession-kind record', async () => {
    const db = await freshDb();
    await db.setProRegistryRecord('100000', record({ professionKind: 'school' }));
    await db.setProRegistryRecord('100000', record({ professionKind: 'solicitor-firm', identifierKind: 'SRA-FirmNumber' }));

    await db.invalidateProRegistryRecord('100000', 'school');

    expect(await db.getProRegistryRecord('100000', 'school')).toBeNull();
    expect(await db.getProRegistryRecord('100000', 'solicitor-firm')).not.toBeNull();
  });
});

describe('DB v12 — proDirectorySeen store', () => {
  it('proDirectorySeen store exists after upgrade', async () => {
    const { openDB } = await import('idb');
    const db = await openDB('test-professional-v12', 12, {
      upgrade(database, oldVersion) {
        if (oldVersion < 11) {
          database.createObjectStore('professionalRegistry', { keyPath: 'canonicalKey' });
          database.createObjectStore('professionalSignetJson', { keyPath: 'canonicalDomain' });
        }
        if (oldVersion < 12) {
          database.createObjectStore('proDirectorySeen', { keyPath: 'leadPubkey' });
        }
      },
    });
    expect(db.objectStoreNames.contains('proDirectorySeen')).toBe(true);
    db.close();
  });
});

describe('DB v13 — pro persona encrypted storage', () => {
  it('v12 → v13 upgrade preserves all existing stores', async () => {
    const { openDB } = await import('idb');
    // Simulate a v12 database with all expected stores.
    const db = await openDB('test-pro-persona-v13-upgrade', 13, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          database.createObjectStore('identity', { keyPath: 'id' });
          const c = database.createObjectStore('contacts', { keyPath: 'pubkey' });
          c.createIndex('ownerPubkey', 'ownerPubkey');
          database.createObjectStore('child-settings', { keyPath: 'childPubkey' });
          database.createObjectStore('preferences', { keyPath: 'id' });
        }
        if (oldVersion < 2) {
          const docs = database.createObjectStore('documents', { keyPath: 'id' });
          docs.createIndex('ownerPubkey', 'ownerPubkey');
          const creds = database.createObjectStore('credentials', { keyPath: 'id' });
          creds.createIndex('documentId', 'documentId');
        }
        if (oldVersion < 3) {
          const sites = database.createObjectStore('authorizedSites', { keyPath: 'id' });
          sites.createIndex('origin', 'origin');
        }
        if (oldVersion < 11) {
          database.createObjectStore('professionalRegistry', { keyPath: 'canonicalKey' });
          database.createObjectStore('professionalSignetJson', { keyPath: 'canonicalDomain' });
        }
        if (oldVersion < 12) {
          database.createObjectStore('proDirectorySeen', { keyPath: 'leadPubkey' });
        }
        if (oldVersion < 13) {
          // No DDL — no-op migration for v13.
        }
      },
    });
    // All v12 stores must still exist after upgrade.
    expect(db.objectStoreNames.contains('identity')).toBe(true);
    expect(db.objectStoreNames.contains('contacts')).toBe(true);
    expect(db.objectStoreNames.contains('credentials')).toBe(true);
    expect(db.objectStoreNames.contains('proDirectorySeen')).toBe(true);
    db.close();
  });

  it('saveProPersonaEncrypted and loadProPersonaDecrypted round-trip', async () => {
    const db = await freshDb();
    const TEST_PRIV_KEY = 'deadbeef'.repeat(8);
    const PASSPHRASE = 'test-passphrase-for-pro-persona';
    await db.saveProPersonaEncrypted(TEST_PRIV_KEY, PASSPHRASE);
    const loaded = await db.loadProPersonaDecrypted(PASSPHRASE);
    expect(loaded).toBe(TEST_PRIV_KEY);
  }, TIMEOUT);

  it('loadProPersonaDecrypted returns null when nothing stored', async () => {
    const db = await freshDb();
    const result = await db.loadProPersonaDecrypted('any-passphrase');
    expect(result).toBeNull();
  }, TIMEOUT);

  it('loadProPersonaDecrypted returns null on wrong passphrase', async () => {
    const db = await freshDb();
    await db.saveProPersonaEncrypted('ff00ff00'.repeat(8), 'correct-passphrase');
    const result = await db.loadProPersonaDecrypted('wrong-passphrase');
    expect(result).toBeNull();
  }, TIMEOUT);
});

describe('publicProfileSignAuth (§5.4.1 pre-auth records)', () => {
  const DEP_ID = 'dep-' + 'a'.repeat(60);
  const PERSONA_PUB = 'b'.repeat(64);
  const KID_CLIENT = 'c'.repeat(64);

  it('returns false when no record exists', async () => {
    const db = await freshDb();
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, KID_CLIENT, 0)).toBe(false);
  }, TIMEOUT);

  it('saves and reads a record with a 24h TTL', async () => {
    const db = await freshDb();
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, KID_CLIENT, 0)).toBe(true);
    const rec = await db.getPublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    expect(rec).toBeDefined();
    expect(rec!.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // 24h ≈ 86 400s. Allow a small tolerance for test-machine clock drift.
    expect(rec!.expiresAt - rec!.createdAt).toBe(86_400);
  }, TIMEOUT);

  it('scope mismatch — different persona pubkey does not match', async () => {
    const db = await freshDb();
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, 'd'.repeat(64), KID_CLIENT, 0)).toBe(false);
  }, TIMEOUT);

  it('scope mismatch — different kid-client pubkey does not match', async () => {
    const db = await freshDb();
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, 'e'.repeat(64), 0)).toBe(false);
  }, TIMEOUT);

  it('scope mismatch — different kind does not match', async () => {
    const db = await freshDb();
    // A record saved for kind-0 does NOT cover kind-5 (or vice versa); each
    // kind needs its own record. The guardian-side provisioner saves both
    // explicitly so disable-time kind-5 retraction still passes the gate.
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, KID_CLIENT, 5)).toBe(false);
  }, TIMEOUT);

  it('upsert refreshes the TTL on the same tuple', async () => {
    const db = await freshDb();
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0, 60);
    const first = await db.getPublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    // Save again with the default (much longer) TTL — record should overwrite.
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    const second = await db.getPublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    expect(second!.expiresAt).toBeGreaterThan(first!.expiresAt);
  }, TIMEOUT);

  it('explicit ttlSeconds applies', async () => {
    const db = await freshDb();
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0, 1);
    const rec = await db.getPublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    expect(rec!.expiresAt - rec!.createdAt).toBe(1);
  }, TIMEOUT);

  it('expired record reads as not-authorised', async () => {
    const db = await freshDb();
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0, -10);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, KID_CLIENT, 0)).toBe(false);
  }, TIMEOUT);

  it('sweepExpiredPublicProfileSignAuth removes only past-TTL records', async () => {
    const db = await freshDb();
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0, -10);
    await db.savePublicProfileSignAuth(DEP_ID, 'f'.repeat(64), KID_CLIENT, 0); // still valid
    const removed = await db.sweepExpiredPublicProfileSignAuth();
    expect(removed).toBe(1);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, KID_CLIENT, 0)).toBe(false);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, 'f'.repeat(64), KID_CLIENT, 0)).toBe(true);
  }, TIMEOUT);

  it('deletePublicProfileSignAuth removes a single record', async () => {
    const db = await freshDb();
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, KID_CLIENT, 0)).toBe(true);
    await db.deletePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, KID_CLIENT, 0)).toBe(false);
  }, TIMEOUT);

  it('listPublicProfileSignAuthForDep returns only that dep\'s records', async () => {
    const db = await freshDb();
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 5);
    await db.savePublicProfileSignAuth('dep-other-' + 'a'.repeat(56), PERSONA_PUB, KID_CLIENT, 0);
    const records = await db.listPublicProfileSignAuthForDep(DEP_ID);
    expect(records.length).toBe(2);
    expect(records.every(r => r.depId === DEP_ID)).toBe(true);
  }, TIMEOUT);

  it('lowercases persona + client pubkeys at save and lookup time', async () => {
    const db = await freshDb();
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB.toUpperCase(), KID_CLIENT.toUpperCase(), 0);
    // Same record reads on either case.
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, KID_CLIENT, 0)).toBe(true);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB.toUpperCase(), KID_CLIENT.toUpperCase(), 0)).toBe(true);
  }, TIMEOUT);

  it('deletePublicProfileSignAuthByClient sweeps every (depId,*,oldClient,*) record (security audit 2026-05-18)', async () => {
    const db = await freshDb();
    const OTHER_PERSONA = 'f'.repeat(64);
    const OTHER_CLIENT = 'e'.repeat(64);
    const OTHER_DEP = 'aa' + 'b'.repeat(62);
    // Records on the to-be-revoked client across multiple personas + kinds.
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 5);
    await db.savePublicProfileSignAuth(DEP_ID, OTHER_PERSONA, KID_CLIENT, 0);
    // Records that MUST survive: different client, different dep.
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, OTHER_CLIENT, 0);
    await db.savePublicProfileSignAuth(OTHER_DEP, PERSONA_PUB, KID_CLIENT, 0);

    const removed = await db.deletePublicProfileSignAuthByClient(DEP_ID, KID_CLIENT);
    expect(removed).toBe(3);

    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, KID_CLIENT, 0)).toBe(false);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, KID_CLIENT, 5)).toBe(false);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, OTHER_PERSONA, KID_CLIENT, 0)).toBe(false);
    // Survives:
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, OTHER_CLIENT, 0)).toBe(true);
    expect(await db.isPublicProfileSignAuthorised(OTHER_DEP, PERSONA_PUB, KID_CLIENT, 0)).toBe(true);
  }, TIMEOUT);

  it('deletePublicProfileSignAuthByClient is case-insensitive on the client pubkey', async () => {
    const db = await freshDb();
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    const removed = await db.deletePublicProfileSignAuthByClient(DEP_ID, KID_CLIENT.toUpperCase());
    expect(removed).toBe(1);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, KID_CLIENT, 0)).toBe(false);
  }, TIMEOUT);

  it('deletePublicProfileSignAuthByPersona sweeps every (depId,persona,*,*) record (sweep-2 low)', async () => {
    const db = await freshDb();
    const OTHER_PERSONA = 'f'.repeat(64);
    const OTHER_CLIENT = 'e'.repeat(64);
    const OTHER_DEP = 'aa' + 'b'.repeat(62);
    // Records on the to-be-deleted persona across multiple clients + kinds.
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 5);
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, OTHER_CLIENT, 0);
    // Records that MUST survive: different persona, different dep.
    await db.savePublicProfileSignAuth(DEP_ID, OTHER_PERSONA, KID_CLIENT, 0);
    await db.savePublicProfileSignAuth(OTHER_DEP, PERSONA_PUB, KID_CLIENT, 0);

    const removed = await db.deletePublicProfileSignAuthByPersona(DEP_ID, PERSONA_PUB);
    expect(removed).toBe(3);

    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, KID_CLIENT, 0)).toBe(false);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, KID_CLIENT, 5)).toBe(false);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, OTHER_CLIENT, 0)).toBe(false);
    // Survives: same dep different persona, and same persona different dep.
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, OTHER_PERSONA, KID_CLIENT, 0)).toBe(true);
    expect(await db.isPublicProfileSignAuthorised(OTHER_DEP, PERSONA_PUB, KID_CLIENT, 0)).toBe(true);
  }, TIMEOUT);

  it('deletePublicProfileSignAuthByPersona is case-insensitive on the persona pubkey', async () => {
    const db = await freshDb();
    await db.savePublicProfileSignAuth(DEP_ID, PERSONA_PUB, KID_CLIENT, 0);
    const removed = await db.deletePublicProfileSignAuthByPersona(DEP_ID, PERSONA_PUB.toUpperCase());
    expect(removed).toBe(1);
    expect(await db.isPublicProfileSignAuthorised(DEP_ID, PERSONA_PUB, KID_CLIENT, 0)).toBe(false);
  }, TIMEOUT);
});

describe('Ken store (kindred recognised keys)', () => {
  function makeKen(overrides: Record<string, unknown> = {}) {
    return {
      pubkey: 'a'.repeat(64),
      ownerPubkey: 'b'.repeat(64),
      tier: 'ken' as const,
      displayName: 'MrBeast',
      addedAt: 1000,
      provenance: { source: 'nip05', locator: 'mrbeast@example.com', confirmedAt: 1000 },
      ...overrides,
    };
  }
  it('saves and reads a ken by owner', async () => {
    const db = await freshDb();
    await db.saveKen(makeKen() as never);
    const list = await db.getKens('b'.repeat(64));
    expect(list).toHaveLength(1);
    expect(list[0].displayName).toBe('MrBeast');
  }, TIMEOUT);
  it('reads a single ken by pubkey', async () => {
    const db = await freshDb();
    await db.saveKen(makeKen() as never);
    expect((await db.getKen('a'.repeat(64)))?.displayName).toBe('MrBeast');
    expect(await db.getKen('f'.repeat(64))).toBeUndefined();
  }, TIMEOUT);
  it('scopes by ownerPubkey — no cross-persona bleed', async () => {
    const db = await freshDb();
    await db.saveKen(makeKen({ pubkey: 'a'.repeat(64), ownerPubkey: 'b'.repeat(64) }) as never);
    await db.saveKen(makeKen({ pubkey: 'c'.repeat(64), ownerPubkey: 'd'.repeat(64) }) as never);
    expect(await db.getKens('b'.repeat(64))).toHaveLength(1);
    expect(await db.getKens('d'.repeat(64))).toHaveLength(1);
  }, TIMEOUT);
  it('deletes a ken', async () => {
    const db = await freshDb();
    await db.saveKen(makeKen() as never);
    await db.deleteKen('a'.repeat(64));
    expect(await db.getKens('b'.repeat(64))).toEqual([]);
  }, TIMEOUT);
});

describe('contactAvatars store', () => {
  const PK = 'a'.repeat(64);
  const SHARE = 'b'.repeat(64);
  const KEY = 'unlock-passphrase';

  it('round-trips a record, decrypting shareKey with the unlock key', async () => {
    const db = await freshDb();
    await db.saveContactAvatar({ pubkey: PK, shareKey: SHARE, addedAt: 1000 }, KEY);
    expect(await db.getContactAvatar(PK, KEY)).toEqual({ pubkey: PK, shareKey: SHARE, addedAt: 1000 });
  }, TIMEOUT);
  it('returns null on a wrong unlock key', async () => {
    const db = await freshDb();
    await db.saveContactAvatar({ pubkey: PK, shareKey: SHARE, addedAt: 1000 }, KEY);
    expect(await db.getContactAvatar(PK, 'wrong-key')).toBeNull();
  }, TIMEOUT);
  it('does not store the shareKey in the clear', async () => {
    const db = await freshDb();
    await db.saveContactAvatar({ pubkey: PK, shareKey: SHARE, addedAt: 1000 }, KEY);
    const conn = await db.getDb();
    const raw = await conn.get('contactAvatars', PK);
    expect(raw.shareKey).not.toBe(SHARE);
  }, TIMEOUT);
  it('deletes', async () => {
    const db = await freshDb();
    await db.saveContactAvatar({ pubkey: PK, shareKey: SHARE, addedAt: 1 }, KEY);
    await db.deleteContactAvatar(PK);
    expect(await db.getContactAvatar(PK, KEY)).toBeNull();
  }, TIMEOUT);
});

describe('contactAvatarKey at rest', () => {
  it('survives an encrypted save/load on the NP slot', async () => {
    const db = await freshDb();
    const KEY = 'pw-at-least-eight';
    const id: SignetIdentity = {
      id: 'np'.padEnd(64, '0'),
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      primaryKeypair: 'natural-person',
      isChild: false,
      createdAt: 1,
      naturalPerson: { publicKey: 'p'.repeat(64), privateKey: 'a'.repeat(64), displayName: 'Me', contactAvatarKey: 'e'.repeat(64) },
      persona: { publicKey: 'q'.repeat(64), privateKey: 'b'.repeat(64), displayName: 'P' },
    };
    await db.saveIdentityEncrypted(id, KEY);
    const out = await db.loadIdentityDecrypted(id.id, KEY);
    expect(out?.naturalPerson.contactAvatarKey).toBe('e'.repeat(64));
  }, TIMEOUT);
});

// Regression for the C1 avatar-revert bug (the internal issue tracker). The fix makes
// the dependant-side contact-avatar writes (setDependantPersonaContactAvatar /
// pushContactAvatar's dep branch) resolve the dependant via a FRESH
// getDependants() read instead of the stale in-memory React snapshot. That fix
// only holds if the IDB layer keeps avatarHash and contactAvatarHash
// independent across a save → load → patch-one-field → save → load cycle.
// This proves that invariant at the db level (hooks have no test infra): a
// fresh-read-then-patch of ONLY the contactAvatar* fields must not clobber the
// avatarHash written by the preceding save.
describe('Dependant contact-avatar fresh-read invariant (C1)', () => {
  const GUARDIAN = 'c'.repeat(64);
  const DEP_PUB = 'd'.repeat(64);
  const AVATAR_HASH_B = 'bb'.repeat(32); // the avatar set in step 1
  const CONTACT_HASH = 'cc'.repeat(32); // the contact-avatar set in step 2

  function makeDep(overrides: Record<string, unknown> = {}) {
    return {
      id: DEP_PUB,
      guardianPubkey: GUARDIAN,
      displayName: 'Alice',
      naturalPerson: { publicKey: DEP_PUB, privateKey: '1'.repeat(64), displayName: 'Alice' },
      persona: { publicKey: 'e'.repeat(64), privateKey: '2'.repeat(64), displayName: 'Alice (anon)' },
      derivationPath: 'dependant-0',
      createdAt: Math.floor(Date.now() / 1000),
      autonomyStage: 'request-approve' as const,
      primaryKeypair: 'natural-person' as const,
      ...overrides,
    };
  }

  it('fresh-read-then-patch of contactAvatar* fields preserves the avatarHash', async () => {
    const db = await freshDb();

    // Step 1 — write the NEW avatar (B) to the dep's NP slot (mirrors
    // setDependantPersonaAvatar).
    const depWithAvatar = makeDep({
      naturalPerson: {
        publicKey: DEP_PUB,
        privateKey: '1'.repeat(64),
        displayName: 'Alice',
        avatarHash: AVATAR_HASH_B,
        avatarBlossomUrl: 'https://blossom.example.com',
        avatarKey: '11'.repeat(32),
        avatarUpdatedAt: 2000,
      },
    });
    await db.saveDependant(depWithAvatar as unknown as Parameters<typeof db.saveDependant>[0], PASSPHRASE);

    // Step 2 — read the dep FRESH from IDB (this is the behaviour the fix
    // introduces: NOT the stale in-memory snapshot), then patch ONLY the
    // contactAvatar* fields and save (mirrors setDependantPersonaContactAvatar).
    const fresh = await db.getDependants(GUARDIAN, PASSPHRASE);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].naturalPerson.avatarHash).toBe(AVATAR_HASH_B);
    const patched = {
      ...fresh[0],
      naturalPerson: {
        ...fresh[0].naturalPerson,
        contactAvatarKey: '99'.repeat(32),
        contactAvatarHash: CONTACT_HASH,
        contactAvatarBlossomUrl: 'https://blossom.example.com/contact',
        contactAvatarUpdatedAt: 3000,
      },
    };
    await db.saveDependant(patched as unknown as Parameters<typeof db.saveDependant>[0], PASSPHRASE);

    // Load again — BOTH fields must survive independently. avatarHash must
    // still be B (this is what the stale-snapshot bug reverted), and the
    // contactAvatarHash must be the value just written.
    const after = await db.getDependants(GUARDIAN, PASSPHRASE);
    expect(after).toHaveLength(1);
    expect(after[0].naturalPerson.avatarHash).toBe(AVATAR_HASH_B);
    expect(after[0].naturalPerson.contactAvatarHash).toBe(CONTACT_HASH);
    expect(after[0].naturalPerson.contactAvatarKey).toBe('99'.repeat(32));
    expect(after[0].naturalPerson.contactAvatarBlossomUrl).toBe('https://blossom.example.com/contact');
    expect(after[0].naturalPerson.contactAvatarUpdatedAt).toBe(3000);
    // The private avatar pointer is untouched by the contact-avatar patch.
    expect(after[0].naturalPerson.avatarKey).toBe('11'.repeat(32));
    expect(after[0].naturalPerson.avatarBlossomUrl).toBe('https://blossom.example.com');
    expect(after[0].naturalPerson.avatarUpdatedAt).toBe(2000);
  }, TIMEOUT);
});

// LEGACY (spec §9). Both stores survive read-only for the one-release
// migration, so the writers are gone — these seed rows with a raw `put`.
describe('legacy no-lock marker row', () => {
  it('reads a seeded presence flag and clears it', async () => {
    const db = await freshDb();
    const id = 'aa'.repeat(32);
    expect(await db.getGraceState(id)).toBeUndefined();
    const raw = await rawOpen();
    await raw.put('gracePeriodState', { id });
    raw.close();
    expect(await db.getGraceState(id)).toBeDefined();
    await db.clearGraceState(id);
    expect(await db.getGraceState(id)).toBeUndefined();
  });
});

describe('legacy no-lock key store', () => {
  beforeEach(() => {
    // Ensure WebCrypto is available in the test environment.
    const { webcrypto } = require('node:crypto');
    vi.stubGlobal('crypto', webcrypto);
  });

  it('reads a seeded CryptoKey handle + wrapped blob and clears it', async () => {
    const db = await freshDb();
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    const raw = await rawOpen();
    await raw.put('graceKey', { id: 'current', handle: key, wrapped: 'wrapped-blob' });
    raw.close();
    const rec = await db.getGraceKey();
    expect(rec?.wrapped).toBe('wrapped-blob');
    expect(rec?.handle).toBeDefined();
    await db.clearGraceKey();
    expect(await db.getGraceKey()).toBeUndefined();
  });
});

// Companion data-rail grants (db v20, the internal issue tracker companion rail
// design). NOTE: named `saveCompanionGrant` / `getCompanionGrant` /
// `listCompanionGrants` / `deleteCompanionGrant` against a dedicated
// `companionGrants` store — NOT `saveGrant`/`grants` as originally drafted
// in the task brief, because both names already belong to the pre-existing
// per-(dependantId, scope, origin) `RememberedGrant` sign-policy-memory
// store (see the "Remembered grants" describe blocks above / db.ts's
// v7 migration). Reusing either name would either collide (duplicate
// `saveGrant` export) or silently corrupt the existing `grants` store by
// pointing a second keyPath/shape at it.
import { COMPANION_GRANT_CAP } from '../types'
import type { CompanionGrant } from '../types'

function companionGrant(i: number): CompanionGrant {
  return {
    appPubkey: String(i).padStart(64, '0'),
    appName: `app ${i}`,
    railPubkey: 'a'.repeat(64),
    snapshotRelay: 'wss://relay.example.com',
    scope: { tiers: ['kin', 'kith'], personas: 'all' },
    createdAt: 1000 + i,
  }
}

describe('companion grants store (db v20)', () => {
  it('saves, gets, lists and deletes a grant', async () => {
    const db = await freshDb();
    await db.saveCompanionGrant(companionGrant(1))
    expect((await db.getCompanionGrant(companionGrant(1).appPubkey))?.appName).toBe('app 1')
    expect(await db.listCompanionGrants()).toHaveLength(1)
    await db.deleteCompanionGrant(companionGrant(1).appPubkey)
    expect(await db.getCompanionGrant(companionGrant(1).appPubkey)).toBeUndefined()
  })
  it('rejects a NEW grant past the cap but allows updating an existing one', async () => {
    const db = await freshDb();
    for (let i = 0; i < COMPANION_GRANT_CAP; i++) await db.saveCompanionGrant(companionGrant(i))
    await expect(db.saveCompanionGrant(companionGrant(99))).rejects.toThrow(/cap|limit/i)
    // updating one already stored is fine
    await expect(db.saveCompanionGrant({ ...companionGrant(0), appName: 'renamed' })).resolves.toBeUndefined()
  })
})


// Sync-seen markers (db v22, personas sync rail final-fix wave). One row per
// cross-device sync rail keyed by d-tag; unencrypted routing metadata (event id +
// timestamp) — see the store comment in db.ts.
describe('syncSeen store (db v22)', () => {
  it('round-trips a marker per d-tag and overwrites in place', async () => {
    const db = await freshDb();
    await db.putSyncSeen({ dTag: 'signet:personas', eventId: 'a'.repeat(64), createdAt: 1000 });
    await db.putSyncSeen({ dTag: 'signet:grants', eventId: 'b'.repeat(64), createdAt: 2000 });
    expect((await db.getSyncSeen('signet:personas'))?.eventId).toBe('a'.repeat(64));
    expect((await db.getSyncSeen('signet:grants'))?.createdAt).toBe(2000);

    await db.putSyncSeen({ dTag: 'signet:personas', eventId: 'c'.repeat(64), createdAt: 3000 });
    expect(await db.getSyncSeen('signet:personas')).toEqual({
      dTag: 'signet:personas', eventId: 'c'.repeat(64), createdAt: 3000,
    });
  }, TIMEOUT);

  it('returns undefined for a d-tag never recorded', async () => {
    const db = await freshDb();
    expect(await db.getSyncSeen('signet:never')).toBeUndefined();
  }, TIMEOUT);

  it('v21 → v22 upgrade adds syncSeen and preserves existing stores and rows', async () => {
    const { openDB } = await import('idb');

    // Seed a v21 database: syncCache exists, syncSeen does not.
    const v21 = await openDB('my-signet', 21, {
      upgrade(d) {
        d.createObjectStore('identity', { keyPath: 'id' });
        d.createObjectStore('contacts', { keyPath: 'pubkey' });
        d.createObjectStore('child-settings', { keyPath: 'childPubkey' });
        d.createObjectStore('preferences', { keyPath: 'id' });
        d.createObjectStore('documents', { keyPath: 'id' });
        d.createObjectStore('credentials', { keyPath: 'id' });
        d.createObjectStore('authorizedSites', { keyPath: 'id' });
        d.createObjectStore('grants', { keyPath: ['dependantId', 'scope', 'origin'] });
        d.createObjectStore('companionGrants', { keyPath: 'appPubkey' });
        d.createObjectStore('syncCache', { keyPath: 'id' });
      },
    });
    expect(v21.objectStoreNames.contains('syncSeen')).toBe(false);
    await v21.put('syncCache', {
      id: 'signet:personas:' + 'a'.repeat(64),
      eventId: 'e'.repeat(64),
      createdAt: 1,
      iv: 'aa',
      ciphertext: 'bb',
      updatedAt: 2,
    });
    await v21.put('preferences', { id: 'current', theme: 'dark' });
    v21.close();

    // Reopen via db.ts — the upgrade to the current version runs.
    const db = await freshDb();
    await db.getPreferences();

    const upgraded = await openDB('my-signet');
    expect(upgraded.objectStoreNames.contains('syncSeen')).toBe(true);
    expect(upgraded.objectStoreNames.contains('syncCache')).toBe(true);
    expect(await upgraded.get('preferences', 'current')).toBeDefined();
    expect(await upgraded.get('syncCache', 'signet:personas:' + 'a'.repeat(64))).toBeDefined();
    upgraded.close();

    // And the new store is usable straight away.
    await db.putSyncSeen({ dTag: 'signet:personas', eventId: 'f'.repeat(64), createdAt: 9 });
    expect((await db.getSyncSeen('signet:personas'))?.createdAt).toBe(9);
  }, TIMEOUT);
});

describe('contacts v2 stores', () => {
  it('creates the three v2 stores with their keys and indexes', async () => {
    const db = await freshDb();
    const raw = await db.getDb();
    // THIRD version literal in the repo, alongside `rawOpen` above and
    // `auth.test.ts`'s `seedGraceKey` — all three have to move together on
    // any future DB_VERSION bump. The describe title deliberately no longer
    // names a version: it was pinned at v23 while this assertion had already
    // moved to 24, which is exactly the drift that makes a stale literal hard
    // to spot.
    expect(raw.version).toBe(25);
    expect(raw.objectStoreNames.contains('privateVaultState')).toBe(true);
    expect(raw.objectStoreNames.contains('contactRecordsV2')).toBe(true);
    expect(raw.objectStoreNames.contains('contactOpsV2')).toBe(true);
    expect(raw.objectStoreNames.contains('contactImportSources')).toBe(true);

    const tx = raw.transaction(['contactRecordsV2', 'contactOpsV2', 'contactImportSources'], 'readonly');
    expect(tx.objectStore('contactRecordsV2').keyPath).toEqual(['directoryId', 'contactId']);
    expect(Array.from(tx.objectStore('contactRecordsV2').indexNames)).toContain('directoryId');
    expect(tx.objectStore('contactOpsV2').keyPath).toBe('operationId');
    expect(Array.from(tx.objectStore('contactOpsV2').indexNames)).toEqual(
      expect.arrayContaining(['directoryId', 'directoryContact']),
    );
    expect(tx.objectStore('contactImportSources').keyPath).toBe('sourceKey');
    await tx.done;
  }, TIMEOUT);

  it('leaves the legacy contacts and ken stores untouched', async () => {
    const db = await freshDb();
    const raw = await db.getDb();
    expect(raw.objectStoreNames.contains('contacts')).toBe(true);
    expect(raw.objectStoreNames.contains('ken')).toBe(true);
  }, TIMEOUT);

  it('purges the v2 stores with the rest of the user data', async () => {
    const db = await freshDb();
    const raw = await db.getDb();
    await raw.put('contactOpsV2', { operationId: 'a'.repeat(32), directoryId: 'owner', contactId: '0'.repeat(32), logicalClock: 1, createdAt: 1, encrypted: true, encryptedData: 'x' });
    await raw.put('contactRecordsV2', { directoryId: 'owner', contactId: '0'.repeat(32), createdAt: 1, updatedAt: 1, encrypted: true, encryptedData: 'x' });
    await raw.put('contactImportSources', { sourceKey: `contact:${'a'.repeat(64)}`, importedAt: 1 });

    await db.purgeAllUserData();

    expect(await raw.count('contactOpsV2')).toBe(0);
    expect(await raw.count('contactRecordsV2')).toBe(0);
    expect(await raw.count('contactImportSources')).toBe(0);
  }, TIMEOUT);

  it('v22 → v23 upgrade adds the v2 stores and preserves existing stores and rows', async () => {
    const { openDB } = await import('idb');

    // Seed a v22 database: syncSeen exists, the v2 stores do not.
    const v22 = await openDB('my-signet', 22, {
      upgrade(d) {
        d.createObjectStore('identity', { keyPath: 'id' });
        d.createObjectStore('contacts', { keyPath: 'pubkey' });
        d.createObjectStore('child-settings', { keyPath: 'childPubkey' });
        d.createObjectStore('preferences', { keyPath: 'id' });
        d.createObjectStore('documents', { keyPath: 'id' });
        d.createObjectStore('credentials', { keyPath: 'id' });
        d.createObjectStore('authorizedSites', { keyPath: 'id' });
        d.createObjectStore('grants', { keyPath: ['dependantId', 'scope', 'origin'] });
        d.createObjectStore('companionGrants', { keyPath: 'appPubkey' });
        d.createObjectStore('syncCache', { keyPath: 'id' });
        d.createObjectStore('syncSeen', { keyPath: 'dTag' });
      },
    });
    expect(v22.objectStoreNames.contains('contactRecordsV2')).toBe(false);
    await v22.put('syncSeen', { dTag: 'signet:personas', eventId: 'e'.repeat(64), createdAt: 1 });
    await v22.put('preferences', { id: 'current', theme: 'dark' });
    v22.close();

    // Reopen via db.ts — the upgrade to the current version runs.
    const db = await freshDb();
    await db.getPreferences();

    const upgraded = await openDB('my-signet');
    expect(upgraded.objectStoreNames.contains('contactRecordsV2')).toBe(true);
    expect(upgraded.objectStoreNames.contains('contactOpsV2')).toBe(true);
    expect(upgraded.objectStoreNames.contains('contactImportSources')).toBe(true);
    expect(upgraded.objectStoreNames.contains('syncSeen')).toBe(true);
    expect(await upgraded.get('preferences', 'current')).toBeDefined();
    expect(await upgraded.get('syncSeen', 'signet:personas')).toBeDefined();
    upgraded.close();

    // And the new stores are usable straight away.
    const raw = await db.getDb();
    await raw.put('contactImportSources', { sourceKey: `contact:${'b'.repeat(64)}`, importedAt: 5 });
    expect(await raw.get('contactImportSources', `contact:${'b'.repeat(64)}`)).toBeDefined();
  }, TIMEOUT);
});

// Contacts v2 app-grant registry (db v24). Unlike the v1 companionGrants
// store, this one holds SECRET material (the fresh random rail private key),
// so the body is encrypted the same way as documents/credentials and only
// grantId/directoryId/appPubkey/createdAt stay in clear for indexing.
describe('contactGrantsV2 (db v24)', () => {
  const KEY = 'a'.repeat(64);

  function grant(over: Partial<AppGrantV2> = {}): AppGrantV2 {
    return {
      grantId: 'f'.repeat(32),
      directoryId: 'owner',
      appPubkey: 'a'.repeat(64),
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_000,
      appName: 'Flock',
      capabilities: ['signet.contacts.read:directory'],
      railPubkey: 'b'.repeat(64),
      railPrivateKey: 'c'.repeat(64),
      relay: 'wss://relay.example.com',
      maxStalenessSeconds: 21600,
      appLabels: {},
      seenOperationIds: [],
      ...over,
    };
  }

  it('round-trips a grant through encrypted storage', async () => {
    const db = await freshDb();
    await db.saveContactGrantV2(grant(), KEY);
    const loaded = await db.getContactGrantV2('f'.repeat(32), KEY);
    expect(loaded).toEqual(grant());
  }, TIMEOUT);

  it('keeps only the routing fields in clear', async () => {
    const db = await freshDb();
    await db.saveContactGrantV2(grant(), KEY);
    const raw = await rawOpen();
    const row = await raw.get('contactGrantsV2', 'f'.repeat(32));
    raw.close();
    expect(row.grantId).toBe('f'.repeat(32));
    expect(row.directoryId).toBe('owner');
    expect(row.appPubkey).toBe('a'.repeat(64));
    expect(row.createdAt).toBe(1_700_000_000);
    expect(row.encrypted).toBe(true);
    expect(row.railPrivateKey).toBeUndefined();
    expect(row.appName).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('c'.repeat(64));
  }, TIMEOUT);

  it('refuses to save without an encryption key', async () => {
    const db = await freshDb();
    await expect(db.saveContactGrantV2(grant(), '')).rejects.toThrow(/encryption key/i);
  }, TIMEOUT);

  it('returns undefined rather than throwing on the wrong key', async () => {
    const db = await freshDb();
    await db.saveContactGrantV2(grant(), KEY);
    expect(await db.getContactGrantV2('f'.repeat(32), '9'.repeat(64))).toBeUndefined();
  }, TIMEOUT);

  it('lists by directory', async () => {
    const db = await freshDb();
    await db.saveContactGrantV2(grant(), KEY);
    await db.saveContactGrantV2(grant({ grantId: 'e'.repeat(32), directoryId: 'dependant:0', appPubkey: '2'.repeat(64) }), KEY);
    expect(await db.listContactGrantsV2ForDirectory('owner', KEY)).toHaveLength(1);
    expect(await db.listContactGrantsV2(KEY)).toHaveLength(2);
  }, TIMEOUT);

  it('caps new grants but always allows updating an existing one', async () => {
    const db = await freshDb();
    for (let i = 0; i < CONTACT_GRANT_V2_CAP; i += 1) {
      await db.saveContactGrantV2(grant({ grantId: i.toString(16).padStart(32, '0'), appPubkey: i.toString(16).padStart(64, '0') }), KEY);
    }
    await expect(db.saveContactGrantV2(grant({ grantId: 'd'.repeat(32) }), KEY)).rejects.toThrow(/cap/i);
    await expect(db.saveContactGrantV2(grant({ grantId: '0'.repeat(32), appName: 'Renamed' }), KEY)).resolves.toBeUndefined();
  }, TIMEOUT);

  it('counts only ACTIVE grants against the cap (R-13)', async () => {
    const db = await freshDb();
    for (let i = 0; i < CONTACT_GRANT_V2_CAP; i += 1) {
      await db.saveContactGrantV2(grant({
        grantId: i.toString(16).padStart(32, '0'),
        appPubkey: i.toString(16).padStart(64, '0'),
        revokedAt: 1_700_000_500,
      }), KEY);
    }
    // Ten revocations must not lock the owner out of ever connecting an app
    // again — a revoked row is kept for audit, not as a reserved slot.
    await expect(db.saveContactGrantV2(grant({ grantId: 'd'.repeat(32) }), KEY)).resolves.toBeUndefined();
  }, TIMEOUT);

  it('deletes a grant and is cleared by purgeAllUserData', async () => {
    const db = await freshDb();
    await db.saveContactGrantV2(grant(), KEY);
    await db.deleteContactGrantV2('f'.repeat(32));
    expect(await db.getContactGrantV2('f'.repeat(32), KEY)).toBeUndefined();
    await db.saveContactGrantV2(grant(), KEY);
    await db.purgeAllUserData();
    expect(await db.listContactGrantsV2(KEY)).toEqual([]);
  }, TIMEOUT);

  // R-22 (Task 28): `updateContactGrantV2` is the compare-and-swap-shaped
  // replacement for the whole-row `saveContactGrantV2` overwrite. Every grant
  // write in `db.ts` shares one module-level serial queue, so a
  // read -> mutate -> write sequence can never be interleaved with another
  // writer's.
  describe('updateContactGrantV2 — one serialised writer (R-22)', () => {
    async function rawCiphertext(): Promise<string> {
      const raw = await rawOpen();
      const row = await raw.get('contactGrantsV2', 'f'.repeat(32));
      raw.close();
      return row.encryptedData as string;
    }

    it('applies 20 concurrent appends to one row without losing any of them', async () => {
      const db = await freshDb();
      await db.saveContactGrantV2(grant(), KEY);

      const ids = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(32, '0'));
      // Fired together, with no await between them: without the shared queue
      // every one of these reads the same pre-append row and the last write
      // wins, leaving a single id behind.
      await Promise.all(ids.map((id) => db.updateContactGrantV2('f'.repeat(32), KEY, (current) => ({
        ...current, seenOperationIds: [...current.seenOperationIds, id],
      }))));

      const loaded = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(loaded?.seenOperationIds).toHaveLength(20);
      expect([...(loaded?.seenOperationIds ?? [])].sort()).toEqual([...ids].sort());
    }, TIMEOUT);

    it('interleaves a saveContactGrantV2 and an update without either losing its change', async () => {
      const db = await freshDb();
      await db.saveContactGrantV2(grant(), KEY);

      // Queued in call order: the whole-row save lands first, then the update
      // reads the row the save actually wrote. Unserialised, the update's own
      // read happens before the save's put and its later write silently
      // reverts the rename.
      await Promise.all([
        db.saveContactGrantV2(grant({ appName: 'Renamed' }), KEY),
        db.updateContactGrantV2('f'.repeat(32), KEY, (current) => ({
          ...current, seenOperationIds: [...current.seenOperationIds, '9'.repeat(32)],
        })),
      ]);

      const loaded = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(loaded?.appName).toBe('Renamed');
      expect(loaded?.seenOperationIds).toEqual(['9'.repeat(32)]);
    }, TIMEOUT);

    it('writes nothing when mutate returns null, and hands back the current row', async () => {
      const db = await freshDb();
      await db.saveContactGrantV2(grant(), KEY);
      const before = await rawCiphertext();

      const returned = await db.updateContactGrantV2('f'.repeat(32), KEY, () => null);

      expect(returned).toEqual(grant());
      // A fresh encrypt mints a fresh random salt/IV, so an identical
      // ciphertext is proof no write happened at all — stronger than
      // asserting the decrypted value is unchanged, which a rewrite of the
      // same content would also satisfy.
      expect(await rawCiphertext()).toBe(before);
    }, TIMEOUT);

    it('returns null and writes nothing for a row that does not exist', async () => {
      const db = await freshDb();
      const mutate = vi.fn((current: AppGrantV2) => current);
      expect(await db.updateContactGrantV2('e'.repeat(32), KEY, mutate)).toBeNull();
      expect(mutate).not.toHaveBeenCalled();
      expect(await db.listContactGrantsV2(KEY)).toEqual([]);
    }, TIMEOUT);

    it('rejects an async mutate rather than storing a Promise, and keeps the queue draining', async () => {
      const db = await freshDb();
      await db.saveContactGrantV2(grant(), KEY);

      await expect(db.updateContactGrantV2(
        'f'.repeat(32), KEY,
        (async (current: AppGrantV2) => current) as unknown as (c: AppGrantV2) => AppGrantV2,
      )).rejects.toThrow(/synchronous/i);

      // The chain survives the rejection: the next write still lands.
      await db.updateContactGrantV2('f'.repeat(32), KEY, (current) => ({ ...current, appName: 'After' }));
      expect((await db.getContactGrantV2('f'.repeat(32), KEY))?.appName).toBe('After');
    }, TIMEOUT);

    it('pins the key: a mutate that changes grantId updates the row it read, never forks a second one', async () => {
      const db = await freshDb();
      await db.saveContactGrantV2(grant(), KEY);

      const returned = await db.updateContactGrantV2('f'.repeat(32), KEY, (current) => ({
        ...current, grantId: 'e'.repeat(32), appName: 'Renamed',
      }));

      // `grantId` is the store's keyPath: an unpinned write would leave the
      // original row untouched AND create a second one under the new id, two
      // grants for one app with two different rail keys.
      expect(returned?.grantId).toBe('f'.repeat(32));
      expect(await db.getContactGrantV2('e'.repeat(32), KEY)).toBeUndefined();
      const all = await db.listContactGrantsV2(KEY);
      expect(all).toHaveLength(1);
      expect(all[0].grantId).toBe('f'.repeat(32));
      expect(all[0].appName).toBe('Renamed');
    }, TIMEOUT);

    it('throws a typed cap error, not just a message', async () => {
      const db = await freshDb();
      for (let i = 0; i < CONTACT_GRANT_V2_CAP; i += 1) {
        await db.saveContactGrantV2(grant({
          grantId: i.toString(16).padStart(32, '0'),
          appPubkey: i.toString(16).padStart(64, '0'),
        }), KEY);
      }
      // `useContactGrantsRail` counts this outcome; matching on prose meant a
      // reword would silently drop the count to zero rather than fail a test.
      const err = await db.saveContactGrantV2(grant({ grantId: 'd'.repeat(32) }), KEY).catch((e) => e);
      expect(db.isGrantCapError(err)).toBe(true);
      expect((err as { code: string }).code).toBe(db.GRANT_CAP_REACHED);
      expect(err).toBeInstanceOf(Error);
      // And an unrelated failure is NOT mistaken for it.
      expect(db.isGrantCapError(new Error('contact grant cap reached'))).toBe(false);
    }, TIMEOUT);

    it('purgeAllUserData cannot be outrun by a queued grant write (rail keys never survive a wipe)', async () => {
      const db = await freshDb();
      await db.saveContactGrantV2(grant(), KEY);

      // Both queued before either runs: the write is ahead of the wipe, so it
      // lands and is then cleared. Outside the queue the write's own encrypt
      // (real PBKDF2) would still be in flight when the clear ran, and its
      // `put` would re-create a row holding a rail PRIVATE KEY in a database
      // the owner just asked to be emptied.
      await Promise.all([
        db.updateContactGrantV2('f'.repeat(32), KEY, (current) => ({
          ...current, seenOperationIds: ['9'.repeat(32)],
        })),
        db.purgeAllUserData(),
      ]);

      expect(await db.listContactGrantsV2(KEY)).toEqual([]);
      const raw = await rawOpen();
      const rows = await raw.getAll('contactGrantsV2');
      raw.close();
      expect(rows).toEqual([]);
    }, TIMEOUT);

    it('a write queued AFTER a purge cannot resurrect a wiped row', async () => {
      const db = await freshDb();
      await db.saveContactGrantV2(grant(), KEY);
      await db.purgeAllUserData();

      // The row is gone, so the update finds nothing and writes nothing —
      // rather than re-putting the pre-purge snapshot it was holding.
      expect(await db.updateContactGrantV2('f'.repeat(32), KEY, (current) => current)).toBeNull();
      expect(await db.listContactGrantsV2(KEY)).toEqual([]);
    }, TIMEOUT);

    it('propagates a throwing mutate and keeps the queue draining', async () => {
      const db = await freshDb();
      await db.saveContactGrantV2(grant(), KEY);

      await expect(db.updateContactGrantV2('f'.repeat(32), KEY, () => { throw new Error('boom'); }))
        .rejects.toThrow('boom');
      await db.updateContactGrantV2('f'.repeat(32), KEY, (current) => ({ ...current, appName: 'Still works' }));
      expect((await db.getContactGrantV2('f'.repeat(32), KEY))?.appName).toBe('Still works');
    }, TIMEOUT);
  });

  // Fix round 1, M1: `appLabels` moved from Record<string, string> to
  // Record<string, {label, updatedAt}> under R-17. These write the row
  // directly (bypassing `saveContactGrantV2`, which now only ever writes the
  // new shape) to simulate a pre-R17 or malformed record on disk.
  describe('appLabels lift on decrypt (R-17 fix round 1, M1)', () => {
    async function putRawGrant(db: Awaited<ReturnType<typeof freshDb>>, sensitive: Record<string, unknown>) {
      const encryptedData = await db.encryptSecret(JSON.stringify(sensitive), KEY);
      const raw = await rawOpen();
      await raw.put('contactGrantsV2', {
        grantId: 'f'.repeat(32), directoryId: 'owner', appPubkey: 'a'.repeat(64),
        createdAt: 1_700_000_000, encrypted: true, encryptedData,
      });
      raw.close();
    }

    function baseSensitive(appLabels: unknown): Record<string, unknown> {
      return {
        updatedAt: 1_700_000_000, appName: 'Flock', capabilities: ['signet.contacts.read:directory'],
        railPubkey: 'b'.repeat(64), railPrivateKey: 'c'.repeat(64), relay: 'wss://relay.example.com',
        maxStalenessSeconds: 21600, appLabels, seenOperationIds: [],
      };
    }

    it('reads a pre-R17 bare-string label as no labels rather than resurrecting it', async () => {
      const db = await freshDb();
      await putRawGrant(db, baseSensitive({ [`${'9'.repeat(32)}`]: 'Coach' }));
      const loaded = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(loaded?.appLabels).toEqual({});
    }, TIMEOUT);

    it('drops an entry missing or mistyping label/updatedAt, keeping the well-formed ones', async () => {
      const db = await freshDb();
      const good = '1'.repeat(32);
      await putRawGrant(db, baseSensitive({
        [good]: { label: 'Good', updatedAt: 5 },
        [`${'2'.repeat(32)}`]: { label: 'Bad clock', updatedAt: 'not-a-number' },
        [`${'3'.repeat(32)}`]: { label: 42, updatedAt: 5 },
        [`${'4'.repeat(32)}`]: { label: 'Negative clock', updatedAt: -1 },
        [`${'5'.repeat(32)}`]: { label: 'Fractional clock', updatedAt: 1.5 },
        [`${'6'.repeat(32)}`]: { updatedAt: 5 },
      }));
      const loaded = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(loaded?.appLabels).toEqual({ [good]: { label: 'Good', updatedAt: 5 } });
    }, TIMEOUT);

    it('enforces the 16-entry appLabels cap on read too, not just on write', async () => {
      const db = await freshDb();
      const appLabels: Record<string, { label: string; updatedAt: number }> = {};
      for (let i = 0; i < MAX_APP_LABELS_PER_GRANT + 5; i += 1) {
        appLabels[i.toString(16).padStart(32, '0')] = { label: `Label ${i}`, updatedAt: i };
      }
      await putRawGrant(db, baseSensitive(appLabels));
      const loaded = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(Object.keys(loaded?.appLabels ?? {})).toHaveLength(MAX_APP_LABELS_PER_GRANT);
    }, TIMEOUT);
  });

  it('v23 → v24 upgrade adds contactGrantsV2 and preserves existing stores and rows', async () => {
    const { openDB } = await import('idb');

    // Seed a v23 database: the contacts-v2 stores exist, contactGrantsV2 does not.
    const v23 = await openDB('my-signet', 23, {
      upgrade(d) {
        d.createObjectStore('identity', { keyPath: 'id' });
        d.createObjectStore('contacts', { keyPath: 'pubkey' });
        d.createObjectStore('child-settings', { keyPath: 'childPubkey' });
        d.createObjectStore('preferences', { keyPath: 'id' });
        d.createObjectStore('documents', { keyPath: 'id' });
        d.createObjectStore('credentials', { keyPath: 'id' });
        d.createObjectStore('authorizedSites', { keyPath: 'id' });
        d.createObjectStore('grants', { keyPath: ['dependantId', 'scope', 'origin'] });
        d.createObjectStore('companionGrants', { keyPath: 'appPubkey' });
        d.createObjectStore('syncCache', { keyPath: 'id' });
        d.createObjectStore('syncSeen', { keyPath: 'dTag' });
        const records = d.createObjectStore('contactRecordsV2', { keyPath: ['directoryId', 'contactId'] });
        records.createIndex('directoryId', 'directoryId');
        const ops = d.createObjectStore('contactOpsV2', { keyPath: 'operationId' });
        ops.createIndex('directoryId', 'directoryId');
        ops.createIndex('directoryContact', ['directoryId', 'contactId']);
        d.createObjectStore('contactImportSources', { keyPath: 'sourceKey' });
      },
    });
    expect(v23.objectStoreNames.contains('contactGrantsV2')).toBe(false);
    await v23.put('contactRecordsV2', {
      directoryId: 'owner', contactId: '0'.repeat(32), createdAt: 1, updatedAt: 1, encrypted: true, encryptedData: 'x',
    });
    await v23.put('preferences', { id: 'current', theme: 'dark' });
    v23.close();

    // Reopen via db.ts — the upgrade to the current version runs.
    const db = await freshDb();
    await db.getPreferences();

    const upgraded = await openDB('my-signet');
    expect(upgraded.objectStoreNames.contains('contactGrantsV2')).toBe(true);
    expect(upgraded.objectStoreNames.contains('contactRecordsV2')).toBe(true);
    expect(await upgraded.get('preferences', 'current')).toBeDefined();
    expect(await upgraded.get('contactRecordsV2', ['owner', '0'.repeat(32)])).toBeDefined();
    upgraded.close();

    // And the new store is usable straight away.
    await db.saveContactGrantV2(grant({ grantId: '1'.repeat(32) }), KEY);
    expect(await db.getContactGrantV2('1'.repeat(32), KEY)).toBeDefined();
  }, TIMEOUT);
});

describe('stable contacts device identity during preference writes', () => {
  it('keeps the first device ID when a stale or racing settings save omits or replaces it', async () => {
    const db = await freshDb();
    const stale = await db.getPreferences();
    await db.savePreferences({ ...stale, contactsDeviceId: 'a'.repeat(32) });
    await db.savePreferences({ ...stale, relayUrl: 'wss://changed.example' });
    expect((await db.getPreferences()).contactsDeviceId).toBe('a'.repeat(32));
    await Promise.all([
      db.savePreferences({ ...stale, contactsDeviceId: 'b'.repeat(32), theme: 'dark' }),
      db.savePreferences({ ...stale, contactsDeviceId: 'c'.repeat(32), theme: 'light' }),
    ]);
    expect((await db.getPreferences()).contactsDeviceId).toBe('a'.repeat(32));
  });
});
it('allocates one contacts device ID atomically without rewriting unrelated settings', async () => {
  const db = await freshDb();
  await db.savePreferences({ id: 'current', theme: 'dark', relayUrl: 'wss://chosen.example' });
  const [a, b] = await Promise.all([db.getOrCreateContactsDeviceId(), db.getOrCreateContactsDeviceId()]);
  expect(a).toMatch(/^[0-9a-f]{32}$/); expect(b).toBe(a);
  expect(await db.getPreferences()).toMatchObject({ theme: 'dark', relayUrl: 'wss://chosen.example', contactsDeviceId: a });
});
