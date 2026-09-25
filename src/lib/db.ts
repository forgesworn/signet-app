import { ensureContactsDeviceId } from './contacts-v2-ids';
// IndexedDB storage for MySignet family app

import { openDB, unwrap, type IDBPDatabase } from 'idb';
import type { SignetIdentity, Contact, ChildSettings, AppPreferences, IdentityDocument, StoredCredential, AuthorizedSite, OriginPolicy, ConnectedClient, RememberedGrant, PairedChildRecord, DependantStatusRecord, TrustedAppEndpoint, TrustedAppPairing, ContactOperation, ContactRecord } from '../types';
import { TRUSTED_APP_PAIRING_CAP, COMPANION_GRANT_CAP } from '../types';
import type { CompanionGrant } from '../types';
import { CONTACT_GRANT_V2_CAP, MAX_APP_LABELS_PER_GRANT } from '../types';
import type { AppGrantV2 } from '../types';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import { encryptSecret, decryptSecret, isEncrypted, encryptSecretsBatch, decryptSecretsBatch } from './crypto-store';
import { liftDependantPublicProfileConfig } from './lift-public-profile-config';
import { liftChildSettings } from './lift-child-settings';
import { mergeChildContactSettings, portableChildContactSettings } from './child-contact-settings';
import { isHeartwoodOperatorCredential, type HeartwoodOperatorCredential } from './heartwood-operator';
import { validateOperation, validateRecord } from './contacts-v2-reducer';
import { createSerialQueue } from './contacts-v2-queue';
import { portableSettingsValues } from './portable-settings';
import { privateVaultQueue } from './private-vault-queue';

export { encryptSecret, decryptSecret } from './crypto-store';

const DB_NAME = 'my-signet';
const DB_VERSION = 25;

let dbPromise: Promise<IDBPDatabase> | null = null;

/** Internal DB accessor — used by pro modules that need direct store access. */
export function getDb(): Promise<IDBPDatabase> {
  return getDB();
}

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        // Version 1 stores
        if (oldVersion < 1) {
          if (!db.objectStoreNames.contains('identity')) {
            db.createObjectStore('identity', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('family')) {
            const family = db.createObjectStore('family', { keyPath: 'pubkey' });
            family.createIndex('ownerPubkey', 'ownerPubkey');
          }
          if (!db.objectStoreNames.contains('child-settings')) {
            db.createObjectStore('child-settings', { keyPath: 'childPubkey' });
          }
          if (!db.objectStoreNames.contains('preferences')) {
            db.createObjectStore('preferences', { keyPath: 'id' });
          }
        }
        // Version 2 stores
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains('documents')) {
            const documents = db.createObjectStore('documents', { keyPath: 'id' });
            documents.createIndex('ownerPubkey', 'ownerPubkey');
          }
          if (!db.objectStoreNames.contains('credentials')) {
            const credentials = db.createObjectStore('credentials', { keyPath: 'id' });
            credentials.createIndex('documentId', 'documentId');
          }
        }
        // Version 3 stores
        if (oldVersion < 3) {
          if (!db.objectStoreNames.contains('authorizedSites')) {
            const sites = db.createObjectStore('authorizedSites', { keyPath: 'id' });
            sites.createIndex('origin', 'origin');
          }
        }
        // Version 4: rename 'family' → 'contacts' + add groupId index.
        // idb's transaction.objectStore() returns an IDBPObjectStore whose
        // openCursor() resolves a Promise — not a native IDBRequest with
        // onsuccess — so the previous cursor-callback style set a no-op
        // on a Promise and every family record was silently dropped when
        // deleteObjectStore ran. Unwrap to the raw IDBTransaction and use
        // the IDBRequest callback style, chaining deleteObjectStore into
        // the cursor's terminating (null) branch so it fires only after
        // every record is copied.
        if (oldVersion < 4) {
          if (!db.objectStoreNames.contains('contacts')) {
            const contacts = db.createObjectStore('contacts', { keyPath: 'pubkey' });
            contacts.createIndex('ownerPubkey', 'ownerPubkey');
            contacts.createIndex('groupId', 'groupId');
          }

          if (db.objectStoreNames.contains('family')) {
            const rawTx = unwrap(transaction) as unknown as IDBTransaction;
            const oldStore = rawTx.objectStore('family');
            const newStore = rawTx.objectStore('contacts');
            const req = oldStore.openCursor();
            req.onsuccess = function () {
              const cursor = req.result;
              if (cursor) {
                newStore.put(cursor.value);
                cursor.continue();
              } else {
                db.deleteObjectStore('family');
              }
            };
          }
        }
        // Version 5: originPolicies store (per-origin identity selection memory)
        if (oldVersion < 5) {
          if (!db.objectStoreNames.contains('originPolicies')) {
            db.createObjectStore('originPolicies', { keyPath: 'origin' });
          }
        }
        // Version 6: connectedClients — NIP-46 bunker server client records
        // NIP-46 bunker server client records, Phase 2.
        if (oldVersion < 6) {
          if (!db.objectStoreNames.contains('connectedClients')) {
            db.createObjectStore('connectedClients', { keyPath: 'clientPubkey' });
          }
        }
        // Version 7: grants — per-(dependantId, scope, origin) remembered decisions
        // for dependant signing policy.
        if (oldVersion < 7) {
          if (!db.objectStoreNames.contains('grants')) {
            const grants = db.createObjectStore('grants', { keyPath: ['dependantId', 'scope', 'origin'] });
            grants.createIndex('dependantId', 'dependantId');
          }
        }
        // Version 8: pairedChild — single-row store for child-device pairing
        // state against the guardian's phone-as-family-bunker
        // against the guardian's phone-as-family-bunker.
        if (oldVersion < 8) {
          if (!db.objectStoreNames.contains('pairedChild')) {
            db.createObjectStore('pairedChild', { keyPath: 'id' });
          }
        }
        // Version 9: pairedChildStatus — single-row cache of the guardian-
        // published autonomyStage for this child-own-device. Populated
        // from the dependant-status-sync rail.
        if (oldVersion < 9) {
          if (!db.objectStoreNames.contains('pairedChildStatus')) {
            db.createObjectStore('pairedChildStatus', { keyPath: 'id' });
          }
        }
        // Version 10: re-key the pairedChild store so a single device can
        // hold multiple pairings (shared family iPad). Pre-v10 the store held at most one row with id
        // 'paired-child-current'; post-v10 the id is the dependant's
        // signing pubkey. Migrate any existing row in place.
        if (oldVersion < 10) {
          if (db.objectStoreNames.contains('pairedChild')) {
            const rawTx = unwrap(transaction) as unknown as IDBTransaction;
            const store = rawTx.objectStore('pairedChild');
            const req = store.openCursor();
            req.onsuccess = function () {
              const cursor = req.result;
              if (!cursor) return;
              const rec = cursor.value as { id?: unknown; dependantPubkey?: unknown };
              if (rec && rec.id === 'paired-child-current' && typeof rec.dependantPubkey === 'string' && /^[0-9a-f]{64}$/i.test(rec.dependantPubkey)) {
                cursor.delete();
                store.put({ ...rec, id: rec.dependantPubkey.toLowerCase() });
              }
              cursor.continue();
            };
          }
        }
        // Version 11: professionalRegistry + professionalSignetJson caches
        // for Pro-surface resolver results and signet.json fetches (24h TTL).
        // See the internal Pro-surface architecture design doc, §5.3 and §6.7.
        if (oldVersion < 11) {
          if (!db.objectStoreNames.contains('professionalRegistry')) {
            db.createObjectStore('professionalRegistry', { keyPath: 'canonicalKey' });
          }
          if (!db.objectStoreNames.contains('professionalSignetJson')) {
            db.createObjectStore('professionalSignetJson', { keyPath: 'canonicalDomain' });
          }
        }
        // Version 12: proDirectorySeen — keyed-by-lead-pubkey cache used by
        // the passive directory-discovery hook in the Pro-surface verify path.
        if (oldVersion < 12) {
          if (!db.objectStoreNames.contains('proDirectorySeen')) {
            db.createObjectStore('proDirectorySeen', { keyPath: 'leadPubkey' });
          }
        }
        // Version 13: pro-persona keypair stored encrypted in identity store.
        // No new object stores — professionalPersona row uses the existing
        // identity store with key 'professionalPersona'. StoredCredential rows
        // gain optional pendingIssuedAt and confirmationAt fields (IndexedDB
        // is schemaless; no DDL needed).
        if (oldVersion < 13) {
          // No DDL actions — field additions handled at read/write layer.
        }
        // Version 14: trusted-app pairing slot per dependant
        // The new `appBunkerEndpoint` field
        // rides on existing DependantIdentity records (stored in the
        // `identity` store with the `dependant:` key prefix). IndexedDB
        // is schemaless, so the field just appears on freshly-saved
        // records — no new object stores or DDL needed.
        if (oldVersion < 14) {
          // No DDL actions — appBunkerEndpoint added at read/write layer.
        }
        // Version 15: pairedChildPersonaRevision — single-row cache of the
        // last-applied persona-inventory revision on a paired-child device.
        // Mirrors pairedChildStatus (v9). No DDL action needed on guardian devices.
        if (oldVersion < 15) {
          if (!db.objectStoreNames.contains('pairedChildPersonaRevision')) {
            db.createObjectStore('pairedChildPersonaRevision', { keyPath: 'id' });
          }
        }
        // Version 16: publicProfileSignAuth — pre-authorisation records for
        // kid-initiated kind-0 / kind-5 sign requests via NIP-46. When the
        // guardian enables a dep persona's public profile, the bunker server
        // skips manual approval prompts for sign_event requests scoped to
        // (depId, personaPubkey, kidClientPubkey, kind). See per-persona
        // public-profile design §5.4.1. Composite-key store.
        if (oldVersion < 16) {
          if (!db.objectStoreNames.contains('publicProfileSignAuth')) {
            db.createObjectStore('publicProfileSignAuth', {
              keyPath: ['depId', 'personaPubkey', 'kidClientPubkey', 'kind'],
            });
          }
        }
        // Version 17: ken store — one-way recognised public keys (kindred).
        // No secret material (public keys + provenance), so stored in the
        // clear, scoped per persona via the ownerPubkey index — same shape
        // as `contacts`. See 2026-06-03 kindred integration design.
        if (oldVersion < 17) {
          if (!db.objectStoreNames.contains('ken')) {
            const ken = db.createObjectStore('ken', { keyPath: 'pubkey' });
            ken.createIndex('ownerPubkey', 'ownerPubkey');
          }
        }
        // Version 18: contactAvatars — per-contact avatar share keys. shareKey
        // is encrypted at rest (decryption secret); pubkey + addedAt clear.
        if (oldVersion < 18) {
          if (!db.objectStoreNames.contains('contactAvatars')) {
            db.createObjectStore('contactAvatars', { keyPath: 'pubkey' });
          }
        }
        // Version 19: gracePeriodState / graceKey — the retired no-lock tier's
        // per-identity marker row and its singleton non-extractable AES-GCM key
        // handle + wrapped blob. Read-only now (spec §9); both stores stay so
        // the DB version is unchanged.
        if (oldVersion < 19) {
          if (!db.objectStoreNames.contains('gracePeriodState')) {
            db.createObjectStore('gracePeriodState', { keyPath: 'id' }); // id = identity id
          }
          if (!db.objectStoreNames.contains('graceKey')) {
            db.createObjectStore('graceKey', { keyPath: 'id' }); // singleton: id = 'current'
          }
        }
        // Version 20: companionGrants store — one scoped data grant per
        // companion app (keyed by the app's device pubkey). No secret material
        // (the rail privkey is re-derived on demand). Named `companionGrants`
        // rather than `grants` — that name is already taken by the v7
        // per-(dependantId, scope, origin) RememberedGrant sign-policy store,
        // which has an incompatible compound keyPath. See companion data
        // rail design.
        if (oldVersion < 20) {
          if (!db.objectStoreNames.contains('companionGrants')) {
            db.createObjectStore('companionGrants', { keyPath: 'appPubkey' });
          }
        }
        // Version 21: syncCache — per-rail decrypted cross-device sync payload cache
        // (family-bunker §11.1.10). Encrypted at rest with a key derived
        // from the unlock key; keyed by `${dTag}:${authorPubkey}`.
        if (oldVersion < 21) {
          if (!db.objectStoreNames.contains('syncCache')) {
            db.createObjectStore('syncCache', { keyPath: 'id' });
          }
        }
        // Version 22: syncSeen — per-rail "last relay record this device
        // saw" marker, keyed by d-tag. Its own store rather than a field on
        // AppPreferences: every rail writes it on every successful fetch,
        // and a read-modify-write of the whole preferences record per rail
        // is both a lost-update race between rails and a needless
        // decrypt/re-encrypt of unrelated settings.
        if (oldVersion < 22) {
          if (!db.objectStoreNames.contains('syncSeen')) {
            db.createObjectStore('syncSeen', { keyPath: 'dTag' });
          }
        }
        // Version 23: contacts v2 — the append-only operation log, the
        // materialised records it folds into, and one marker row per legacy
        // row already imported. Bodies are encrypted at rest with the unlock
        // key (same routing-clear + `encryptedData` shape as `documents` /
        // `credentials`); only the keys and the ordering fields stay in clear,
        // because the reducer has to sort and address rows without unlocking.
        // The legacy `contacts` / `ken` stores are deliberately untouched —
        // v2 lives beside them until the UI switches over.
        if (oldVersion < 23) {
          if (!db.objectStoreNames.contains('contactRecordsV2')) {
            const records = db.createObjectStore('contactRecordsV2', { keyPath: ['directoryId', 'contactId'] });
            records.createIndex('directoryId', 'directoryId');
          }
          if (!db.objectStoreNames.contains('contactOpsV2')) {
            const ops = db.createObjectStore('contactOpsV2', { keyPath: 'operationId' });
            ops.createIndex('directoryId', 'directoryId');
            ops.createIndex('directoryContact', ['directoryId', 'contactId']);
          }
          if (!db.objectStoreNames.contains('contactImportSources')) {
            db.createObjectStore('contactImportSources', { keyPath: 'sourceKey' });
          }
        }
        // Version 24: contactGrantsV2 — one row per contacts-v2 app grant.
        // Unlike v20's companionGrants this row holds SECRET material (the
        // fresh random rail private key), so the body is encrypted and only the
        // routing fields stay clear. Indexed by directory and by app pubkey so
        // the projection publisher and the proposal inbox can each enumerate
        // what they need without decrypting every row first.
        if (oldVersion < 24) {
          if (!db.objectStoreNames.contains('contactGrantsV2')) {
            const grantsV2 = db.createObjectStore('contactGrantsV2', { keyPath: 'grantId' });
            grantsV2.createIndex('by-directory', 'directoryId');
            grantsV2.createIndex('by-app', 'appPubkey');
          }
        }
        if (oldVersion < 25 && !db.objectStoreNames.contains('privateVaultState')) {
          db.createObjectStore('privateVaultState', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

// --- Identity ---

export async function getIdentity(pubkey: string): Promise<SignetIdentity | undefined> {
  const db = await getDB();
  return db.get('identity', pubkey);
}

/**
 * All real user `SignetIdentity` rows from the `identity` store.
 *
 * The store also holds non-identity rows that share the same store (and,
 * for dependants, an overlapping shape): the `bunkerSecret` and
 * `professionalPersona` marker rows, and `dependant:`-prefixed
 * `DependantIdentity` rows. `DependantIdentity` carries its own
 * `naturalPerson`/`persona` slots too, so a shape-only check (`'naturalPerson'
 * in r`) is not enough to exclude it — callers must filter by id prefix.
 * Filtering centrally here means every caller gets the same guarantee
 * (2026-07-02 audit finding — a caller's shape-only filter was letting
 * dependant rows leak into the user's own identity list).
 */
export async function getAllIdentities(): Promise<SignetIdentity[]> {
  const db = await getDB();
  const all = await db.getAll('identity');
  return all.filter((r): r is SignetIdentity =>
    typeof r.id === 'string' &&
    r.id !== BUNKER_SECRET_KEY &&
    r.id !== PRO_PERSONA_KEY &&
    r.id !== HEARTWOOD_OPERATOR_KEY &&
    !r.id.startsWith(DEPENDANT_PREFIX),
  );
}

/**
 * Encrypt private keys and mnemonic with a passphrase-derived AES-256-GCM key before storing.
 * The stored record has encrypted: true so callers know to decrypt on load.
 */
export async function saveIdentityEncrypted(identity: SignetIdentity, passphrase: string): Promise<void> {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters');
  }
  // Only encrypt non-empty fields (nsec imports may have empty keypair/mnemonic)
  const encryptedNpPrivateKey = identity.naturalPerson.privateKey
    ? await encryptSecret(identity.naturalPerson.privateKey, passphrase)
    : '';
  const encryptedPersonaPrivateKey = identity.persona.privateKey
    ? await encryptSecret(identity.persona.privateKey, passphrase)
    : '';
  const encryptedMnemonic = identity.mnemonic
    ? await encryptSecret(identity.mnemonic, passphrase)
    : '';
  // Per-persona avatar keys — encrypted at rest, same pattern as privateKey.
  // Hash + URL stay clear (routing fields, parallel to the existing
  // top-level photoHash/blossomUrl exception documented in the db module).
  const encryptedNpAvatarKey = identity.naturalPerson.avatarKey
    ? await encryptSecret(identity.naturalPerson.avatarKey, passphrase)
    : undefined;
  const encryptedPersonaAvatarKey = identity.persona.avatarKey
    ? await encryptSecret(identity.persona.avatarKey, passphrase)
    : undefined;
  // Contact-share avatar keys — same at-rest treatment as avatarKey
  // (decryption secret); hash/url stay clear (routing fields).
  const encryptedNpContactAvatarKey = identity.naturalPerson.contactAvatarKey
    ? await encryptSecret(identity.naturalPerson.contactAvatarKey, passphrase)
    : undefined;
  const encryptedPersonaContactAvatarKey = identity.persona.contactAvatarKey
    ? await encryptSecret(identity.persona.contactAvatarKey, passphrase)
    : undefined;
  const encryptedExtras = identity.extraPersonas
    ? await Promise.all(identity.extraPersonas.map(async (ep) => ({
        ...ep,
        privateKey: ep.privateKey ? await encryptSecret(ep.privateKey, passphrase) : '',
        avatarKey: ep.avatarKey ? await encryptSecret(ep.avatarKey, passphrase) : undefined,
        contactAvatarKey: ep.contactAvatarKey ? await encryptSecret(ep.contactAvatarKey, passphrase) : undefined,
      })))
    : undefined;
  // Professional persona — the canonical Pro key currently lives in its own
  // encrypted row (saveProPersonaEncrypted), but the type allows a privateKey
  // here and several callbacks spread `professionalPersona` back through
  // saveIdentityEncrypted. Encrypt it like every other slot so a future path
  // that populates it can never write a cleartext key to IDB (security audit
  // 2026-06-15). Absent on legacy identities → stays undefined.
  const encryptedProfessional = identity.professionalPersona
    ? {
        ...identity.professionalPersona,
        privateKey: identity.professionalPersona.privateKey
          ? await encryptSecret(identity.professionalPersona.privateKey, passphrase)
          : '',
      }
    : undefined;

  const encryptedIdentity: SignetIdentity = {
    ...identity,
    naturalPerson: {
      ...identity.naturalPerson,
      privateKey: encryptedNpPrivateKey,
      avatarKey: encryptedNpAvatarKey,
      contactAvatarKey: encryptedNpContactAvatarKey,
    },
    persona: {
      ...identity.persona,
      privateKey: encryptedPersonaPrivateKey,
      avatarKey: encryptedPersonaAvatarKey,
      contactAvatarKey: encryptedPersonaContactAvatarKey,
    },
    extraPersonas: encryptedExtras,
    professionalPersona: encryptedProfessional,
    mnemonic: encryptedMnemonic,
    encrypted: true,
  };

  const db = await getDB();
  await db.put('identity', encryptedIdentity);
}

/**
 * Load an identity and decrypt private keys and mnemonic if they were stored encrypted.
 * Returns undefined if no identity exists for the given pubkey.
 * Throws if decryption fails (wrong passphrase).
 */
export async function loadIdentityDecrypted(pubkey: string, passphrase: string): Promise<SignetIdentity | undefined> {
  const db = await getDB();
  const stored: SignetIdentity | undefined = await db.get('identity', pubkey);
  if (!stored) return undefined;

  if (!stored.encrypted) {
    throw new Error('Identity record is not encrypted — possible data integrity issue');
  }

  // Decrypt, peeling off multiple encryption layers if the data was corrupted
  // by double-encryption (e.g. saving an already-encrypted identity).
  const HEX_KEY_RE = /^[0-9a-f]{64}$/;
  const MNEMONIC_RE = /^[a-z]+(?: [a-z]+){11,23}$/;
  async function decryptFully(value: string, isMnemonic = false): Promise<string> {
    if (!value) return '';
    let result = await decryptSecret(value, passphrase);
    // Keep decrypting while the result looks like another encrypted layer
    // (not yet a valid hex key or mnemonic words)
    let safety = 10;
    while (safety-- > 0) {
      const done = isMnemonic ? MNEMONIC_RE.test(result) : HEX_KEY_RE.test(result);
      if (done || !isEncrypted(result)) break;
      try {
        result = await decryptSecret(result, passphrase);
      } catch {
        break; // Not actually encrypted — isEncrypted was a false positive
      }
    }
    return result;
  }

  const npPrivateKey = stored.naturalPerson.privateKey
    ? await decryptFully(stored.naturalPerson.privateKey)
    : '';
  const personaPrivateKey = stored.persona.privateKey
    ? await decryptFully(stored.persona.privateKey)
    : '';
  const mnemonic = stored.mnemonic
    ? await decryptFully(stored.mnemonic, true)
    : '';
  // Per-persona avatar keys — 64-char hex like privateKey, so decryptFully's
  // HEX_KEY_RE termination works without changes. Undefined when no avatar
  // is set; decrypted to the original hex when present.
  const npAvatarKey = stored.naturalPerson.avatarKey
    ? await decryptFully(stored.naturalPerson.avatarKey)
    : undefined;
  const personaAvatarKey = stored.persona.avatarKey
    ? await decryptFully(stored.persona.avatarKey)
    : undefined;
  // Contact-share avatar keys — 64-char hex like avatarKey, so decryptFully's
  // HEX_KEY_RE termination works unchanged.
  const npContactAvatarKey = stored.naturalPerson.contactAvatarKey
    ? await decryptFully(stored.naturalPerson.contactAvatarKey)
    : undefined;
  const personaContactAvatarKey = stored.persona.contactAvatarKey
    ? await decryptFully(stored.persona.contactAvatarKey)
    : undefined;
  const decryptedExtras = stored.extraPersonas
    ? await Promise.all(stored.extraPersonas.map(async (ep: ExtraPersona) => ({
        ...ep,
        privateKey: ep.privateKey ? await decryptFully(ep.privateKey) : '',
        avatarKey: ep.avatarKey ? await decryptFully(ep.avatarKey) : undefined,
        contactAvatarKey: ep.contactAvatarKey ? await decryptFully(ep.contactAvatarKey) : undefined,
      })))
    : undefined;
  // Professional persona — symmetric with the encrypt path above. Decrypt the
  // private key when present so a round-tripped identity carries usable key
  // material, not ciphertext (security audit 2026-06-15).
  const decryptedProfessional = stored.professionalPersona
    ? {
        ...stored.professionalPersona,
        privateKey: stored.professionalPersona.privateKey
          ? await decryptFully(stored.professionalPersona.privateKey)
          : '',
      }
    : undefined;

  return {
    ...stored,
    naturalPerson: {
      ...stored.naturalPerson,
      privateKey: npPrivateKey,
      avatarKey: npAvatarKey,
      contactAvatarKey: npContactAvatarKey,
    },
    persona: {
      ...stored.persona,
      privateKey: personaPrivateKey,
      avatarKey: personaAvatarKey,
      contactAvatarKey: personaContactAvatarKey,
    },
    extraPersonas: decryptedExtras,
    professionalPersona: decryptedProfessional,
    mnemonic,
    encrypted: false,
  };
}

export async function deleteIdentityRecord(pubkey: string): Promise<void> {
  const db = await getDB();
  await db.delete('identity', pubkey);
}

/**
 * Remove any identity records that were stored without encryption.
 * Protects against orphaned plaintext records from interrupted setup flows.
 */
export async function cleanupUnencryptedIdentities(): Promise<number> {
  const db = await getDB();
  const all = await db.getAll('identity');
  let removed = 0;
  for (const identity of all) {
    if (identity.id === BUNKER_SECRET_KEY) continue;
    if (identity.id === PRO_PERSONA_KEY) continue;
    if (identity.id === HEARTWOOD_OPERATOR_KEY) continue;
    if (typeof identity.id === 'string' && identity.id.startsWith(DEPENDANT_PREFIX)) continue;
    if (!identity.encrypted) {
      await db.delete('identity', identity.id);
      removed++;
    }
  }
  return removed;
}

// --- Contacts ---

export async function getContacts(ownerPubkey: string, encryptionKey?: string): Promise<Contact[]> {
  const db = await getDB();
  const members = await db.getAllFromIndex('contacts', 'ownerPubkey', ownerPubkey);
  if (!encryptionKey) return members;
  return Promise.all(members.map(async (m) => {
    if (!m.sharedSecret) return m;
    try {
      return { ...m, sharedSecret: await decryptSecret(m.sharedSecret, encryptionKey) };
    } catch {
      return m; // fallback for pre-encryption records
    }
  }));
}

export async function getContact(pubkey: string, encryptionKey?: string): Promise<Contact | undefined> {
  const db = await getDB();
  const m = await db.get('contacts', pubkey);
  if (!m || !encryptionKey || !m.sharedSecret) return m;
  try {
    return { ...m, sharedSecret: await decryptSecret(m.sharedSecret, encryptionKey) };
  } catch {
    return m; // fallback for pre-encryption records
  }
}

/**
 * M2 (2026-07-02 audit): `encryptionKey` is required whenever `contact.sharedSecret`
 * is set — an ECDH shared secret must never be persisted unencrypted.
 * Contacts with no `sharedSecret` (public-only rolodex entries) have
 * nothing sensitive to protect and may still be saved without a key
 * (e.g. `useBadgeRefresh`'s cache-passthrough re-save).
 */
export async function saveContact(contact: Contact, encryptionKey?: string): Promise<void> {
  if (!encryptionKey && contact.sharedSecret) {
    throw new Error('Encryption key required to save a contact with a shared secret');
  }
  const toStore = encryptionKey && contact.sharedSecret
    ? { ...contact, sharedSecret: await encryptSecret(contact.sharedSecret, encryptionKey) }
    : contact;
  const db = await getDB();
  await db.put('contacts', toStore);
}

export async function deleteContact(pubkey: string): Promise<void> {
  const db = await getDB();
  await db.delete('contacts', pubkey);
}

// --- Ken (one-way recognised public keys, kindred) ---
// Stored in the clear: a KenEntry carries no secret material (public key +
// provenance + optional local annotations). Scoped per persona via ownerPubkey.

export async function getKens(ownerPubkey: string): Promise<KenEntry[]> {
  const db = await getDB();
  return db.getAllFromIndex('ken', 'ownerPubkey', ownerPubkey);
}

export async function getKen(pubkey: string): Promise<KenEntry | undefined> {
  const db = await getDB();
  return db.get('ken', pubkey);
}

export async function saveKen(ken: KenEntry): Promise<void> {
  const db = await getDB();
  await db.put('ken', ken);
}

export async function deleteKen(pubkey: string): Promise<void> {
  const db = await getDB();
  await db.delete('ken', pubkey);
}

// --- Contacts v2 (db v23) ---
// Routing fields stay in clear because the reducer must sort and address rows
// without unlocking; everything else — names, notes, shared secrets, phone
// numbers, block reasons — rides in `encryptedData`, the same split
// `documents` and `credentials` use.

interface EncryptedRow {
  encrypted?: boolean;
  encryptedData?: string;
  [key: string]: unknown;
}

export async function saveContactOperationV2(op: ContactOperation, encryptionKey: string): Promise<void> {
  if (!encryptionKey) throw new Error('Encryption key required to save a contact operation');
  // R-10: an operation the reducer would drop is not "saved" in any useful
  // sense — `listContactOperationsV2` filters it out again on the way back,
  // so the row is invisible work and, in a test, a silently empty directory
  // that every assertion then passes against.
  if (!validateOperation(op)) throw new Error('contacts: refusing to save an invalid operation');
  const { operationId, directoryId, contactId, logicalClock, createdAt, ...sensitive } = op;
  const encryptedData = await encryptSecret(JSON.stringify(sensitive), encryptionKey);
  const db = await getDB();
  await db.put('contactOpsV2', { operationId, directoryId, contactId, logicalClock, createdAt, encrypted: true, encryptedData });
}

/**
 * Save many operations under ONE PBKDF2 derivation instead of N (I2 perf
 * fix) — `saveContactOperationV2` above still derives fresh per call, for
 * the many one-at-a-time UI mutation call sites; this is for the sync rail,
 * which can be merging dozens of remote operations from a single fetch.
 * Rows land in the SAME per-row format (`encryptSecretsBatch` shares only
 * the salt, not the IV), so a batch-written row is byte-for-byte as
 * individually decryptable as a singly-written one, and reading a store that
 * mixes both back works unchanged.
 */
export async function saveContactOperationsV2(ops: ContactOperation[], encryptionKey: string): Promise<void> {
  if (ops.length === 0) return;
  if (!encryptionKey) throw new Error('Encryption key required to save a contact operation');
  // All or nothing: the batch is built from one logical change, and half of it
  // is worse than none of it.
  if (!ops.every((op) => validateOperation(op))) {
    throw new Error('contacts: refusing to save an invalid operation');
  }
  const sensitivePayloads = ops.map((op) => {
    const { operationId, directoryId, contactId, logicalClock, createdAt, ...sensitive } = op;
    return JSON.stringify(sensitive);
  });
  const encryptedDataList = await encryptSecretsBatch(sensitivePayloads, encryptionKey);
  const db = await getDB();
  const tx = db.transaction('contactOpsV2', 'readwrite');
  for (let i = 0; i < ops.length; i += 1) {
    const { operationId, directoryId, contactId, logicalClock, createdAt } = ops[i];
    await tx.store.put({ operationId, directoryId, contactId, logicalClock, createdAt, encrypted: true, encryptedData: encryptedDataList[i] });
  }
  await tx.done;
}

/**
 * Decrypt, validate and reassemble a batch of operation rows, sharing one
 * derived key per distinct salt across the whole batch (I2 perf fix) rather
 * than one derivation per row. A row that fails to decrypt, parse or
 * validate is DROPPED — never thrown out of a load.
 */
async function decryptOperationRows(rows: EncryptedRow[], encryptionKey: string): Promise<ContactOperation[]> {
  const plaintexts = await decryptSecretsBatch(rows.map((row) => String(row.encryptedData)), encryptionKey);
  const out: ContactOperation[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const plaintext = plaintexts[i];
    if (plaintext === null) continue;
    try {
      const plain = JSON.parse(plaintext) as Record<string, unknown>;
      const row = rows[i];
      // Body FIRST, clear routing fields LAST: the routing fields are what the
      // index and the reducer address this row by, so a tampered `encryptedData`
      // carrying its own `operationId`/`directoryId`/`logicalClock` must not be
      // able to overwrite them and have the row answer for a different one.
      const candidate = {
        ...plain,
        operationId: row.operationId,
        directoryId: row.directoryId,
        contactId: row.contactId,
        logicalClock: row.logicalClock,
        createdAt: row.createdAt,
      };
      if (validateOperation(candidate)) out.push(candidate);
    } catch {
      // Unreadable row: skip it, same as a failed decrypt.
    }
  }
  return out;
}

export async function listContactOperationsV2(directoryId: string, encryptionKey: string): Promise<ContactOperation[]> {
  const db = await getDB();
  const rows = await db.getAllFromIndex('contactOpsV2', 'directoryId', directoryId) as EncryptedRow[];
  return decryptOperationRows(rows, encryptionKey);
}

export async function listAllContactOperationsV2(encryptionKey: string): Promise<ContactOperation[]> {
  const db = await getDB();
  const rows = await db.getAll('contactOpsV2') as EncryptedRow[];
  return decryptOperationRows(rows, encryptionKey);
}

export async function saveContactRecordV2(record: ContactRecord, encryptionKey: string): Promise<void> {
  if (!encryptionKey) throw new Error('Encryption key required to save a contact record');
  const { directoryId, contactId, createdAt, updatedAt, ...sensitive } = record;
  const encryptedData = await encryptSecret(JSON.stringify(sensitive), encryptionKey);
  const db = await getDB();
  await db.put('contactRecordsV2', { directoryId, contactId, createdAt, updatedAt, encrypted: true, encryptedData });
}

export async function listContactRecordsV2(directoryId: string, encryptionKey: string): Promise<ContactRecord[]> {
  const db = await getDB();
  const rows = await db.getAllFromIndex('contactRecordsV2', 'directoryId', directoryId) as EncryptedRow[];
  // I2 perf: batched so a store where several rows share a salt (any rows
  // written via a batch save elsewhere) costs one derivation per distinct
  // salt to read, not one per row.
  const plaintexts = await decryptSecretsBatch(rows.map((row) => String(row.encryptedData)), encryptionKey);
  const out: ContactRecord[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const plaintext = plaintexts[i];
    if (plaintext === null) continue;
    try {
      const sensitive = JSON.parse(plaintext) as Record<string, unknown>;
      const row = rows[i];
      // Body first, clear routing fields last — see decryptOperationRows.
      const candidate = {
        ...sensitive,
        directoryId: String(row.directoryId),
        contactId: String(row.contactId),
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
      };
      if (validateRecord(candidate)) out.push(candidate);
    } catch {
      // Unreadable row: skip it. The operation log is the source of truth and
      // a re-reduce rebuilds this view.
    }
  }
  return out;
}

export async function deleteContactRecordV2(directoryId: string, contactId: string): Promise<void> {
  const db = await getDB();
  await db.delete('contactRecordsV2', [directoryId, contactId]);
}

/** `sourceKey` values (`contact:<pubkey>` / `ken:<pubkey>`) already lifted into v2. */
export async function listContactImportSources(): Promise<string[]> {
  const db = await getDB();
  const rows = await db.getAll('contactImportSources') as { sourceKey?: unknown }[];
  // Filter on the RAW value, not on the string 'undefined' — a legitimate key
  // is a string, and comparing after String() both keeps junk (numbers, null)
  // and would drop a real key that happened to spell 'undefined'.
  return rows.filter(r => typeof r.sourceKey === 'string' && r.sourceKey.length > 0).map(r => r.sourceKey as string);
}

export async function markContactImportSources(sourceKeys: string[], importedAt: number): Promise<void> {
  if (sourceKeys.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('contactImportSources', 'readwrite');
  for (const sourceKey of sourceKeys) {
    await tx.store.put({ sourceKey, importedAt });
  }
  await tx.done;
}

/** Every legacy contact row, across every owner slot — the import's input, not a UI read path. */
export async function getAllContacts(encryptionKey?: string): Promise<Contact[]> {
  const db = await getDB();
  const rows = await db.getAll('contacts') as Contact[];
  if (!encryptionKey) return rows;
  return Promise.all(rows.map(async (row) => {
    if (!row.sharedSecret) return row;
    try {
      return { ...row, sharedSecret: await decryptSecret(row.sharedSecret, encryptionKey) };
    } catch {
      // Undecryptable: drop the field rather than hand the CIPHERTEXT back as
      // if it were the secret — an import would then store it as direct
      // evidence and it would read as a verified shared secret forever.
      const { sharedSecret: _unreadable, ...withoutSecret } = row;
      return withoutSecret as Contact;
    }
  }));
}

/** Every legacy ken row, across every owner slot. Kens hold no secret material. */
export async function getAllKens(): Promise<KenEntry[]> {
  const db = await getDB();
  return db.getAll('ken') as Promise<KenEntry[]>;
}

// --- Companion grants (companion data rail, db v20) ---
// One row per companion app, keyed by the app's device pubkey. No secret
// material — the rail privkey is re-derived on demand. Named
// `saveCompanionGrant` / `companionGrants` (not `saveGrant` / `grants`) to
// avoid colliding with the pre-existing per-(dependantId, scope, origin)
// RememberedGrant sign-policy store below.

export async function getCompanionGrant(appPubkey: string): Promise<CompanionGrant | undefined> {
  const db = await getDB();
  return db.get('companionGrants', appPubkey);
}

export async function listCompanionGrants(): Promise<CompanionGrant[]> {
  const db = await getDB();
  return db.getAll('companionGrants');
}

/** Rejects a NEW grant (unseen appPubkey) once COMPANION_GRANT_CAP is reached; updating an existing grant is always allowed. */
export async function saveCompanionGrant(grant: CompanionGrant): Promise<void> {
  const db = await getDB();
  const existing = await db.get('companionGrants', grant.appPubkey);
  if (!existing) {
    const count = await db.count('companionGrants');
    if (count >= COMPANION_GRANT_CAP) {
      throw new Error('companion grant cap reached');
    }
  }
  await db.put('companionGrants', grant);
}

export async function deleteCompanionGrant(appPubkey: string): Promise<void> {
  const db = await getDB();
  await db.delete('companionGrants', appPubkey);
}

// --- Contacts v2 app grants (db v24) ---
// Routing-clear: grantId, directoryId, appPubkey, createdAt. Everything else —
// including railPrivateKey — lives inside `encryptedData`.

type StoredContactGrantV2 = {
  grantId: string; directoryId: string; appPubkey: string; createdAt: number;
  encrypted: true; encryptedData: string;
};

/**
 * R-22: ONE serial queue for every write to `contactGrantsV2`.
 *
 * Three hooks read-modify-write the same row — `useContactProposals`
 * (`seenOperationIds`/`appLabels`), `useContactProjections`
 * (`lastProjectionHash`/`lastProjectionAt`/`lastPublishState`) and
 * `useContactGrantsRail` (the merge, and `revokedAt`) — plus App's own
 * revoke/forget. `saveContactGrantV2` is a whole-row overwrite with no
 * compare-and-swap, so any two of them in flight lose an update: a rail
 * private key or a replay window, silently. Every grant write in this module
 * therefore runs through this single chain, so a read→mutate→write sequence
 * cannot be interleaved with another writer's.
 *
 * MODULE scope, not per-caller: the hazard is two DIFFERENT callers racing,
 * which a per-caller queue cannot see. It is deliberately one queue for the
 * whole store rather than one per `grantId` — grant writes are rare (a
 * proposal batch, a projection publish, a merge) and a single chain is the
 * only shape that also serialises `saveContactGrantV2`'s cap check against a
 * concurrent insert.
 *
 * NOT re-entrant (see `contacts-v2-queue.ts`): nothing run inside a queued
 * task may call back into another queued grant function, or the chain
 * deadlocks. `listContactGrantsV2` and `getContactGrantV2` are reads and are
 * deliberately NOT queued, which is what lets the cap check below run inside
 * a queued task.
 *
 * COST MODEL, stated plainly because serialising anything that does PBKDF2 is
 * a real decision, not a free one:
 *
 * - One `updateContactGrantV2` = TWO 600k-iteration PBKDF2 derivations (the
 *   decrypt of the current row, then the encrypt of the next), so roughly
 *   tenths of a second on a phone. Serialised, N concurrent updates cost N
 *   times that end to end rather than overlapping.
 * - One `saveContactGrantV2` for a NEW grant additionally decrypts EVERY grant
 *   row, because the R-13 cap counts ACTIVE grants and `revokedAt` lives
 *   inside the ciphertext. At the cap that is up to `CONTACT_GRANT_V2_CAP`
 *   extra derivations — bounded, and once per approval.
 * - Updating an existing grant skips that scan entirely (the `existing` check
 *   is on the cleartext key path), so the common write is the two-derivation
 *   case.
 *
 * Accepted because grant writes are RARE and never on an interactive path: a
 * proposal batch arriving, a projection publish settling, a rail merge after a
 * fetch, an approval or a revocation. None of them is a keystroke, none of
 * them blocks a render, and the alternative — unserialised whole-row
 * overwrites — loses rail private keys, which is not a performance problem but
 * a data-loss one. If this ever does become hot, the fix is a per-`grantId`
 * queue plus a separate cap-check lock, not dropping the serialisation.
 */
const grantWriteQueue = createSerialQueue();

/**
 * The `saveContactGrantV2` cap refusal, as a TYPED error rather than a message
 * to regex (fix round 1, minor 3). `useContactGrantsRail` counts this outcome
 * into its `skippedRemote` total, and matching on prose meant a future
 * reword would silently drop the count to zero instead of failing a test.
 */
export const GRANT_CAP_REACHED = 'GRANT_CAP_REACHED';

export class ContactGrantCapError extends Error {
  readonly code = GRANT_CAP_REACHED;
  constructor() {
    super('contact grant cap reached');
    this.name = 'ContactGrantCapError';
  }
}

/** True for the cap refusal above, however it crossed a module boundary. */
export function isGrantCapError(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === GRANT_CAP_REACHED;
}

/** Encrypt and put one grant row. Callers must already hold the queue. */
async function writeContactGrantRow(grant: AppGrantV2, encryptionKey: string): Promise<void> {
  const db = await getDB();
  const { grantId, directoryId, appPubkey, createdAt, ...sensitive } = grant;
  const encryptedData = await encryptSecret(JSON.stringify(sensitive), encryptionKey);
  const row: StoredContactGrantV2 = { grantId, directoryId, appPubkey, createdAt, encrypted: true, encryptedData };
  await db.put('contactGrantsV2', row);
}

export async function saveContactGrantV2(grant: AppGrantV2, encryptionKey: string): Promise<void> {
  if (!encryptionKey) throw new Error('Encryption key required to save a contact grant');
  return grantWriteQueue.run(async () => {
    const db = await getDB();
    const existing = await db.get('contactGrantsV2', grant.grantId);
    if (!existing) {
      // R-13: ACTIVE grants only. Counting rows would let ten revocations
      // permanently exhaust the cap, so the count decrypts to check `revokedAt`
      // — only on the new-grant path, which happens once per approval.
      const active = (await listContactGrantsV2(encryptionKey)).filter((g) => !g.revokedAt);
      if (active.length >= CONTACT_GRANT_V2_CAP) throw new ContactGrantCapError();
    }
    await writeContactGrantRow(grant, encryptionKey);
  });
}

/**
 * R-22: read-modify-write ONE grant row atomically with respect to every
 * other grant write in this module.
 *
 * `mutate` is handed the freshly decrypted row and returns the row to write,
 * or `null` to write nothing. Each caller mutates only ITS OWN fields and
 * spreads the rest from `current`, so two callers touching different fields
 * of the same row both survive.
 *
 * `mutate` MUST be synchronous and side-effect-free with respect to this
 * module: the queue is not re-entrant, so a `mutate` that awaited anything —
 * or called back into `saveContactGrantV2` / `updateContactGrantV2` /
 * `deleteContactGrantV2` — would deadlock the chain for the rest of the
 * session. An async `mutate` is rejected outright rather than silently
 * writing a `Promise` object into the store.
 *
 * Returns the row as written, the unchanged current row when `mutate`
 * returned `null`, or `null` when there is no such row (no write, never a
 * throw). A throwing `mutate` propagates to the caller; the queue keeps
 * draining.
 *
 * The KEY IS PINNED (fix round 1, minor 2): whatever `mutate` returns is
 * written under the `grantId` that was read, never under one the mutate
 * supplied. `grantId` is this store's `keyPath`, so a mutate that changed it —
 * by spreading a stale record over `current`, or simply by getting the field
 * wrong — would not rename the row, it would FORK it: a second row appears
 * under the new id while the original stays untouched at the old one, leaving
 * two grants claiming the same app with two different rail keys and no way to
 * tell which the app is actually reading. Pinning turns that class of bug into
 * a silently-ignored field rather than a duplicated grant.
 */
export async function updateContactGrantV2(
  grantId: string,
  encryptionKey: string,
  mutate: (current: AppGrantV2) => AppGrantV2 | null,
): Promise<AppGrantV2 | null> {
  if (!encryptionKey) throw new Error('Encryption key required to update a contact grant');
  return grantWriteQueue.run(async () => {
    const db = await getDB();
    const current = await decryptContactGrantV2(await db.get('contactGrantsV2', grantId), encryptionKey);
    if (!current) return null;
    const next = mutate(current);
    if (next === null || next === undefined) return current;
    if (typeof (next as { then?: unknown }).then === 'function') {
      throw new Error('updateContactGrantV2 mutate must be synchronous — the grant write queue is not re-entrant');
    }
    const pinned: AppGrantV2 = { ...next, grantId: current.grantId };
    await writeContactGrantRow(pinned, encryptionKey);
    return pinned;
  });
}

/**
 * Lift/validate a decrypted grant's `appLabels` (R-17 fix round 1, M1).
 *
 * `AppGrantV2.appLabels` moved from `Record<string, string>` to
 * `Record<string, { label, updatedAt }>` under R-17. A row written before
 * that change (or a corrupt/hostile one) may still carry a bare string, or
 * an object missing/mistyping either field — such an entry is DROPPED, never
 * resurrected as `{ label: undefined, updatedAt: undefined }`, which would
 * let a stale-clock comparison downstream treat `undefined >= number` as
 * `false` and accept an app rename it should have rejected as a replay.
 *
 * The 16-entry cap (`MAX_APP_LABELS_PER_GRANT`) is enforced here too, not
 * just on the write path — a row written by an older or hostile build could
 * otherwise carry more than the cap and read back as if the write-side cap
 * had never applied. Entries beyond the cap are dropped in iteration order;
 * which entries survive is deliberately unspecified beyond "at most the
 * cap" — a row this malformed already lost its ordering guarantees.
 */
function liftAppLabels(raw: unknown): AppGrantV2['appLabels'] {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: AppGrantV2['appLabels'] = {};
  for (const [scopedId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_APP_LABELS_PER_GRANT) break;
    if (typeof value !== 'object' || value === null) continue; // pre-R17 bare string, or worse
    const label = (value as { label?: unknown }).label;
    const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
    if (typeof label !== 'string') continue;
    if (typeof updatedAt !== 'number' || !Number.isInteger(updatedAt) || updatedAt < 0) continue;
    out[scopedId] = { label, updatedAt };
  }
  return out;
}

async function decryptContactGrantV2(row: unknown, encryptionKey: string): Promise<AppGrantV2 | undefined> {
  const r = row as StoredContactGrantV2 | undefined;
  if (!r || r.encrypted !== true) return undefined;
  try {
    const sensitive = JSON.parse(await decryptSecret(r.encryptedData, encryptionKey)) as Partial<AppGrantV2>;
    if (!Array.isArray(sensitive.capabilities) || typeof sensitive.railPrivateKey !== 'string') return undefined;
    return {
      grantId: r.grantId, directoryId: r.directoryId, appPubkey: r.appPubkey, createdAt: r.createdAt,
      updatedAt: typeof sensitive.updatedAt === 'number' ? sensitive.updatedAt : r.createdAt,
      ...(typeof sensitive.ownerIdentityPubkey === 'string' && /^[0-9a-f]{64}$/.test(sensitive.ownerIdentityPubkey)
        ? { ownerIdentityPubkey: sensitive.ownerIdentityPubkey } : {}),
      appName: typeof sensitive.appName === 'string' ? sensitive.appName : '',
      capabilities: sensitive.capabilities,
      railPubkey: typeof sensitive.railPubkey === 'string' ? sensitive.railPubkey : '',
      railPrivateKey: sensitive.railPrivateKey,
      relay: typeof sensitive.relay === 'string' ? sensitive.relay : '',
      maxStalenessSeconds: typeof sensitive.maxStalenessSeconds === 'number' ? sensitive.maxStalenessSeconds : 21600,
      revokedAt: sensitive.revokedAt,
      ...(typeof sensitive.autoAcceptInvites === 'boolean' ? { autoAcceptInvites: sensitive.autoAcceptInvites } : {}),
      lastProjectionHash: sensitive.lastProjectionHash,
      lastProjectionAt: sensitive.lastProjectionAt,
      lastPublishState: sensitive.lastPublishState,
      appLabels: liftAppLabels(sensitive.appLabels),
      seenOperationIds: Array.isArray(sensitive.seenOperationIds) ? sensitive.seenOperationIds : [],
    };
  } catch {
    // Wrong key or corrupt row: a missing grant, never a thrown load.
    return undefined;
  }
}

export async function getContactGrantV2(grantId: string, encryptionKey: string): Promise<AppGrantV2 | undefined> {
  const db = await getDB();
  return decryptContactGrantV2(await db.get('contactGrantsV2', grantId), encryptionKey);
}

export async function listContactGrantsV2(encryptionKey: string): Promise<AppGrantV2[]> {
  const db = await getDB();
  const rows = await db.getAll('contactGrantsV2');
  const decrypted = await Promise.all(rows.map((r) => decryptContactGrantV2(r, encryptionKey)));
  return decrypted.filter((g): g is AppGrantV2 => g !== undefined);
}

export async function listContactGrantsV2ForDirectory(directoryId: string, encryptionKey: string): Promise<AppGrantV2[]> {
  const db = await getDB();
  const rows = await db.getAllFromIndex('contactGrantsV2', 'by-directory', directoryId);
  const decrypted = await Promise.all(rows.map((r) => decryptContactGrantV2(r, encryptionKey)));
  return decrypted.filter((g): g is AppGrantV2 => g !== undefined);
}

/** R-22: forgetting a grant rides the same chain as every other grant write,
 *  so a delete can never land between another writer's read and its write. */
export async function deleteContactGrantV2(grantId: string): Promise<void> {
  return grantWriteQueue.run(async () => {
    const db = await getDB();
    await db.delete('contactGrantsV2', grantId);
  });
}

// --- Sync decrypt cache (v21, family-bunker §11.1.10) ---
// One row per cross-device sync rail, keyed `${dTag}:${authorPubkey}`, holding the
// plaintext of the last relay event we decrypted — AES-256-GCM ciphertext
// only, never plaintext. `eventId` is the cache validity check: a relay
// event whose id still matches costs no `nip44_decrypt` round-trip to the
// signing device. Encrypt/decrypt lives in `sync-decrypt-cache.ts`.

export interface SyncCacheEntry {
  /** `${dTag}:${authorPubkey.toLowerCase()}` */
  id: string;
  /** Relay event id the cached plaintext came from. */
  eventId: string;
  /** That event's `created_at` (seconds) — diagnostics/eviction only. */
  createdAt: number;
  /** AES-GCM IV, base64. */
  iv: string;
  /** AES-GCM ciphertext (with tag), base64. */
  ciphertext: string;
  /** When this row was written (ms). */
  updatedAt: number;
}

export async function getSyncCacheEntry(id: string): Promise<SyncCacheEntry | undefined> {
  const db = await getDB();
  return db.get('syncCache', id);
}

export async function putSyncCacheEntry(entry: SyncCacheEntry): Promise<void> {
  const db = await getDB();
  await db.put('syncCache', entry);
}

export async function clearSyncCache(): Promise<void> {
  const db = await getDB();
  await db.clear('syncCache');
}

// --- Sync seen markers (v22) ---
// One row per cross-device sync rail, keyed by d-tag, recording the last relay
// record this device saw for that rail. Lets a rail tell "there's genuinely
// nothing on the relay yet" apart from "there used to be a record here and
// the relay can no longer produce it" — see `sync-seen.ts`.
//
// NOT encrypted at rest. An event id plus its timestamp is routing metadata
// of exactly the kind already stored in clear elsewhere in this DB (see the
// "At-rest routing-field metadata" note): it names a public
// relay event whose CONTENT is NIP-44 ciphertext either way, and reveals
// nothing beyond "this device synced rail X at time T" — which the presence
// of the rail's own encrypted cache row already implies. Encrypting it
// would also make the marker unreadable in exactly the situation it exists
// to describe (a rail fetching before the identity is decrypted).

export interface SyncSeenRecord {
  /** Storage key: sync-seen.ts encodes [authorPubkey, dTag] here.
   * Legacy rows contain a bare d-tag and remain available for safe migration. */
  dTag: string;
  /** Relay event id last seen for this rail. */
  eventId: string;
  /** That event's `created_at` (seconds). */
  createdAt: number;
  /**
   * Contacts v2 only: the checkpoint sequence that event carried. Lets
   * `nextCheckpointSeq` refuse to regress when a relay serves an older
   * checkpoint or one this device cannot read (R2). Additive and optional —
   * every existing row simply has no `seq`, so no DB version bump.
   */
  seq?: number;
}

export async function getSyncSeen(dTag: string): Promise<SyncSeenRecord | undefined> {
  const db = await getDB();
  return db.get('syncSeen', dTag);
}

export async function putSyncSeen(row: SyncSeenRecord): Promise<void> {
  const db = await getDB();
  await db.put('syncSeen', row);
}

// --- Contact avatars (recipient-side share keys) ---
// One row per contact pubkey holding the AES-256-GCM key that decrypts that
// contact's shared avatar blob. The shareKey is a decryption secret, so it's
// encrypted at rest with the unlock key (same pattern as private keys);
// pubkey + addedAt stay clear (routing fields). See 2026-06-04
// contact-card-name-avatar design §B2.

export interface ContactAvatarRecord {
  pubkey: string;
  shareKey: string;
  addedAt: number;
}

/** Save a recipient-side contact-share key. shareKey encrypted at rest. */
export async function saveContactAvatar(rec: ContactAvatarRecord, encryptionKey: string): Promise<void> {
  const encrypted = await encryptSecret(rec.shareKey, encryptionKey);
  const db = await getDB();
  await db.put('contactAvatars', { ...rec, shareKey: encrypted });
}

/** Load + decrypt a contact-share key. Null if absent or wrong key. */
export async function getContactAvatar(pubkey: string, encryptionKey: string): Promise<ContactAvatarRecord | null> {
  const db = await getDB();
  const rec = await db.get('contactAvatars', pubkey);
  if (!rec) return null;
  try {
    return { pubkey: rec.pubkey, addedAt: rec.addedAt, shareKey: await decryptSecret(rec.shareKey, encryptionKey) };
  } catch {
    return null;
  }
}

export async function deleteContactAvatar(pubkey: string): Promise<void> {
  const db = await getDB();
  await db.delete('contactAvatars', pubkey);
}

// --- Child Settings ---

export async function getChildSettings(childPubkey: string): Promise<ChildSettings | undefined> {
  const db = await getDB();
  return liftChildSettings(await db.get('child-settings', childPubkey) as ChildSettings | undefined);
}

export async function saveChildSettings(settings: ChildSettings): Promise<void> {
  const db = await getDB();
  await db.put('child-settings', settings);
}

export async function updateChildContactSettings(childPubkey: string, guardianPubkey: string,
  patch: Partial<Pick<ChildSettings, 'contactPolicy' | 'defaultChildCeiling'>>, legacyGuardianPubkeys: readonly string[] = []): Promise<ChildSettings> {
  const db = await getDB();
  const tx = db.transaction('child-settings', 'readwrite');
  const previous = liftChildSettings(await tx.store.get(childPubkey));
  if (previous && previous.guardianPubkey !== guardianPubkey && !legacyGuardianPubkeys.includes(previous.guardianPubkey)) throw new Error('Child contact settings belong to another guardian');
  const next: ChildSettings = { contactPolicy: 'kin-only', defaultChildCeiling: 'ken', ...previous,
    childPubkey, guardianPubkey, ...patch, contactPolicyConflicted: false,
    updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1) };
  if (!portableChildContactSettings(next)) throw new Error('Invalid child contact settings');
  await tx.store.put(next); await tx.done;
  return next;
}

export async function restoreChildContactSettings(incoming: ChildSettings, legacyGuardianPubkeys: readonly string[] = []): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('child-settings', 'readwrite');
  let previous = liftChildSettings(await tx.store.get(incoming.childPubkey));
  if (previous && legacyGuardianPubkeys.includes(previous.guardianPubkey)) previous = { ...previous, guardianPubkey: incoming.guardianPubkey };
  const next = mergeChildContactSettings(previous, incoming);
  await tx.store.put(next); await tx.done;
}

/** Explicit guardian consent under the approved-contacts policy. */
export async function approveChildContact(childPubkey: string, guardianPubkey: string, peer: string): Promise<ChildSettings> {
  if (![childPubkey, guardianPubkey, peer].every(value => /^[0-9a-f]{64}$/.test(value))) throw new Error('Invalid contact approval');
  const db = await getDB();
  const tx = db.transaction('child-settings', 'readwrite');
  const settings = liftChildSettings(await tx.store.get(childPubkey));
  if (!settings || settings.guardianPubkey !== guardianPubkey || settings.contactPolicy !== 'approved' || settings.contactPolicyConflicted) {
    await tx.done;
    throw new Error('The contact approval policy changed');
  }
  const approvedContacts = [...new Set([...(settings.approvedContacts ?? []), peer])];
  if (approvedContacts.length > 500) { await tx.done; throw new Error('The approved contacts list is full'); }
  const next = { ...settings, approvedContacts, updatedAt: Math.max(Date.now(), (settings.updatedAt ?? 0) + 1) };
  await tx.store.put(next); await tx.done;
  return next;
}

// --- Preferences ---

/**
 * `bunkerUri` (when present) carries a reusable `bunker://...&secret=...`
 * NIP-46 reauth secret and is stored ENCRYPTED at rest (M1, 2026-07-02
 * audit) — see `savePreferences`. Pass `encryptionKey` to get back a
 * usable plaintext URI; without it, `bunkerUri` is returned as whatever
 * opaque value is on disk (ciphertext, or a legacy pre-migration
 * cleartext value) so callers that merely spread this object through an
 * unrelated `savePreferences` call round-trip it unchanged rather than
 * losing or misusing it. See `migrateCleartextBunkerUri`.
 */
/** Reserve the installation's contacts actor ID without overwriting other
 * preferences captured before onboarding or another settings write completed. */
export async function getOrCreateContactsDeviceId(): Promise<string> {
  const db = await getDB();
  const tx = db.transaction('preferences', 'readwrite');
  const previous = await tx.store.get('current');
  const contactsDeviceId = ensureContactsDeviceId(previous?.contactsDeviceId);
  if (contactsDeviceId !== previous?.contactsDeviceId) {
    await tx.store.put({ id: 'current', theme: 'system', ...previous, contactsDeviceId });
  }
  await tx.done;
  return contactsDeviceId;
}

export async function getPreferences(encryptionKey?: string): Promise<AppPreferences> {
  const db = await getDB();
  const prefs = await db.get('preferences', 'current');
  const out: AppPreferences = prefs || { id: 'current', theme: 'system' };
  if (encryptionKey && typeof out.bunkerUri === 'string' && !out.bunkerUri.startsWith('bunker://')) {
    try {
      out.bunkerUri = await decryptSecret(out.bunkerUri, encryptionKey);
    } catch {
      out.bunkerUri = undefined; // wrong key / corrupted ciphertext — don't hand back garbage
    }
  }
  return out;
}

/**
 * Persists preferences. `bunkerUri`, when a plaintext `bunker://...` URI,
 * is ENCRYPTED before it touches disk (M1) — this repo's own convention
 * ("Bunker client secret ... Never in AppPreferences") requires
 * it, and the codebase already encrypts the sibling NIP-46 client secret
 * the same way (`saveBunkerSecret`) and `PairedChildRecord.bunkerUri`.
 *
 * `encryptionKey` is optional because most callers spread the in-memory
 * `preferences` object through for an unrelated field change (theme,
 * relay, etc.) without knowing or caring about bunkerUri. When no key is
 * supplied and the incoming value is plaintext, we refuse to write it —
 * the existing on-disk value (ciphertext, or absent) is preserved instead
 * of being clobbered with an unencrypted secret. Explicit clears
 * (`bunkerUri: undefined`) always work regardless of key.
 */
export async function savePreferences(prefs: AppPreferences, encryptionKey?: string, portableTimestamp?: number): Promise<void> {
  const db = await getDB();
  let toStore = prefs;
  const plaintextBunker = typeof prefs.bunkerUri === 'string' && prefs.bunkerUri.startsWith('bunker://');
  if (plaintextBunker && encryptionKey) {
    toStore = { ...prefs, bunkerUri: await encryptSecret(prefs.bunkerUri!, encryptionKey) };
  }
  // Crypto is complete before opening the transaction. Read-and-write together
  // keeps the per-install contacts actor ID stable across racing settings saves.
  const tx = db.transaction('preferences', 'readwrite');
  const previous = await tx.store.get(prefs.id ?? 'current');
  if (plaintextBunker && !encryptionKey) toStore = { ...toStore, bunkerUri: previous?.bunkerUri };
  if (previous?.contactsDeviceId && /^[0-9a-f]{32}$/.test(previous.contactsDeviceId)) {
    toStore = { ...toStore, contactsDeviceId: previous.contactsDeviceId };
  }
  const changed = JSON.stringify(portableSettingsValues(previous ?? { id: 'current', theme: 'system' }))
    !== JSON.stringify(portableSettingsValues(prefs));
  const stamp = portableTimestamp ?? (changed ? Math.max(Date.now(), (previous?.portableSettingsUpdatedAt ?? 0) + 1) : previous?.portableSettingsUpdatedAt);
  if (stamp !== undefined) toStore = { ...toStore, portableSettingsUpdatedAt: stamp };
  await tx.store.put(toStore);
  await tx.done;
}

/**
 * One-shot migration (M1): move a legacy cleartext `AppPreferences.bunkerUri`
 * (written before this fix shipped) into encrypted storage. No-op if the
 * field is absent or already encrypted (doesn't start with `bunker://`).
 * Idempotent — safe to call on every unlock.
 */
export async function migrateCleartextBunkerUri(encryptionKey: string): Promise<void> {
  const db = await getDB();
  const raw = await db.get('preferences', 'current');
  if (!raw || typeof raw.bunkerUri !== 'string' || !raw.bunkerUri.startsWith('bunker://')) return;
  const encrypted = await encryptSecret(raw.bunkerUri, encryptionKey);
  await db.put('preferences', { ...raw, bunkerUri: encrypted });
}

// --- Child-mode session ---
// A persistent marker that the device is currently "handed to" a dependant.
// Entry is soft; exit is PIN-gated in the app. The record survives reload and
// process-kill so the child can't escape the boundary by closing the app.

interface ChildModeSessionRecord {
  id: 'child-mode-session';
  activeDependantId: string;
  enteredAt: number;
}

export async function saveChildModeSession(activeDependantId: string): Promise<void> {
  const db = await getDB();
  const record: ChildModeSessionRecord = {
    id: 'child-mode-session',
    activeDependantId,
    enteredAt: Date.now(),
  };
  await db.put('preferences', record);
}

export async function loadChildModeSession(): Promise<{ activeDependantId: string; enteredAt: number } | null> {
  const db = await getDB();
  const raw = await db.get('preferences', 'child-mode-session') as ChildModeSessionRecord | undefined;
  if (!raw) return null;
  if (typeof raw.activeDependantId !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.activeDependantId)) return null;
  if (typeof raw.enteredAt !== 'number' || raw.enteredAt <= 0) return null;
  return { activeDependantId: raw.activeDependantId, enteredAt: raw.enteredAt };
}

export async function clearChildModeSession(): Promise<void> {
  const db = await getDB();
  await db.delete('preferences', 'child-mode-session');
}

// --- Identity Documents ---

export async function getDocument(id: string, encryptionKey?: string): Promise<IdentityDocument | undefined> {
  const db = await getDB();
  const record = await db.get('documents', id);
  if (!record) return undefined;
  return decryptDocumentRecord(record, encryptionKey);
}

export async function getDocumentsByOwner(ownerPubkey: string, encryptionKey?: string): Promise<IdentityDocument[]> {
  const db = await getDB();
  const records = await db.getAllFromIndex('documents', 'ownerPubkey', ownerPubkey);
  return Promise.all(records.map(r => decryptDocumentRecord(r, encryptionKey)));
}

/**
 * M2 (2026-07-02 audit): `encryptionKey` is required — the document body
 * (name, DOB, document number, etc.) is PII and must never be persisted
 * unencrypted. Matches `saveIdentityEncrypted`'s throw-when-unkeyed
 * contract; unlike that function, this one previously silently fell back
 * to a plaintext `db.put` when called without a key.
 */
export async function saveDocument(document: IdentityDocument, encryptionKey?: string): Promise<void> {
  if (!encryptionKey) {
    throw new Error('Encryption key required to save a document');
  }
  const db = await getDB();
  const { id, ownerPubkey, createdAt, updatedAt, ...sensitive } = document;
  const encryptedData = await encryptSecret(JSON.stringify(sensitive), encryptionKey);
  await db.put('documents', { id, ownerPubkey, createdAt, updatedAt, encrypted: true, encryptedData });
}

async function decryptDocumentRecord(record: IdentityDocument, encryptionKey?: string): Promise<IdentityDocument> {
  const r = record as unknown as Record<string, unknown>;
  if (!r.encrypted) return record;
  if (!encryptionKey) return record;
  const decrypted = await decryptSecret(r.encryptedData as string, encryptionKey);
  const sensitive = JSON.parse(decrypted) as Partial<IdentityDocument>;
  return {
    id: record.id,
    ownerPubkey: record.ownerPubkey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...sensitive,
  } as IdentityDocument;
}

export async function deleteDocument(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('documents', id);
}

// --- Stored Credentials ---

export async function getCredential(id: string, encryptionKey?: string): Promise<StoredCredential | undefined> {
  const db = await getDB();
  const record = await db.get('credentials', id);
  if (!record) return undefined;
  return decryptCredentialRecord(record, encryptionKey);
}

export async function getCredentialsByDocument(documentId: string, encryptionKey?: string): Promise<StoredCredential[]> {
  const db = await getDB();
  const records = await db.getAllFromIndex('credentials', 'documentId', documentId);
  return Promise.all(records.map(r => decryptCredentialRecord(r, encryptionKey)));
}

export async function getAllCredentials(encryptionKey?: string): Promise<StoredCredential[]> {
  const db = await getDB();
  const records = await db.getAll('credentials');
  return Promise.all(records.map(r => decryptCredentialRecord(r, encryptionKey)));
}

/**
 * M2 (2026-07-02 audit): `encryptionKey` is required — the credential
 * body carries the credential payload and `merkleLeaves`, which must
 * never be persisted unencrypted. See `saveDocument` for the same fix
 * applied to the sibling store.
 */
export async function saveCredential(credential: StoredCredential, encryptionKey?: string): Promise<void> {
  if (!encryptionKey) {
    throw new Error('Encryption key required to save a credential');
  }
  const db = await getDB();
  const { id, documentId, keypairType, verifierPubkey, verifiedAt, verifierStatus, ...sensitive } = credential;
  const encryptedData = await encryptSecret(JSON.stringify(sensitive), encryptionKey);
  await db.put('credentials', { id, documentId, keypairType, verifierPubkey, verifiedAt, verifierStatus, encrypted: true, encryptedData });
}

async function decryptCredentialRecord(record: StoredCredential, encryptionKey?: string): Promise<StoredCredential> {
  const r = record as unknown as Record<string, unknown>;
  if (!r.encrypted) return record;
  if (!encryptionKey) return record;
  const decrypted = await decryptSecret(r.encryptedData as string, encryptionKey);
  const sensitive = JSON.parse(decrypted) as Partial<StoredCredential>;
  return {
    id: record.id,
    documentId: record.documentId,
    keypairType: record.keypairType,
    verifierPubkey: record.verifierPubkey,
    verifiedAt: record.verifiedAt,
    verifierStatus: record.verifierStatus,
    ...sensitive,
  } as StoredCredential;
}

export async function deleteCredential(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('credentials', id);
}

/**
 * Persist an updated StoredCredential row. Uses the same encryption path as
 * saveCredential — callers must pass the active encryption key when one is set.
 * Primary use-case: state transitions (e.g. pending → expired-pending).
 */
export async function updateCredential(credential: StoredCredential, encryptionKey?: string): Promise<void> {
  return saveCredential(credential, encryptionKey);
}

// --- Authorized Sites ---

export async function getAuthorizedSites(): Promise<AuthorizedSite[]> {
  const db = await getDB();
  return db.getAll('authorizedSites');
}

export async function getAuthorizedSiteByOrigin(origin: string): Promise<AuthorizedSite | undefined> {
  const db = await getDB();
  const all = await db.getAllFromIndex('authorizedSites', 'origin', origin);
  return all[0];
}

export async function saveAuthorizedSite(site: AuthorizedSite): Promise<void> {
  const db = await getDB();
  await db.put('authorizedSites', site);
}

/**
 * Upsert an authorization by origin in a single transaction, so concurrent
 * approvals for the same origin collapse to one row instead of leaving
 * duplicate `id`-keyed records behind. The store keys on `id`, but the
 * `origin` index is used to look up existing rows first.
 */
export async function upsertAuthorizedSiteByOrigin(
  origin: string,
  patch: Omit<AuthorizedSite, 'id' | 'origin' | 'authorizedAt'>,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('authorizedSites', 'readwrite');
  const idx = tx.store.index('origin');
  const existing: AuthorizedSite | undefined = await idx.get(origin);
  const now = Math.floor(Date.now() / 1000);
  if (existing) {
    await tx.store.put({ ...existing, ...patch, origin, lastUsedAt: patch.lastUsedAt ?? now });
  } else {
    await tx.store.put({
      ...patch,
      id: crypto.randomUUID(),
      origin,
      authorizedAt: now,
      lastUsedAt: patch.lastUsedAt ?? now,
    });
  }
  await tx.done;
}

export async function deleteAuthorizedSite(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('authorizedSites', id);
}

// --- Origin Policies (per-origin identity-selection memory) ---

/** Normalise an origin to the form used as the keyPath — no path, no trailing slash. */
export function normaliseOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

export async function getOriginPolicy(origin: string): Promise<OriginPolicy | undefined> {
  const key = normaliseOrigin(origin);
  if (!key) return undefined;
  const db = await getDB();
  return db.get('originPolicies', key);
}

export async function getAllOriginPolicies(): Promise<OriginPolicy[]> {
  const db = await getDB();
  return db.getAll('originPolicies');
}

export async function saveOriginPolicy(policy: OriginPolicy): Promise<void> {
  const key = normaliseOrigin(policy.origin);
  if (!key) return;
  const db = await getDB();
  await db.put('originPolicies', { ...policy, origin: key });
}

export async function deleteOriginPolicy(origin: string): Promise<void> {
  const key = normaliseOrigin(origin);
  if (!key) return;
  const db = await getDB();
  await db.delete('originPolicies', key);
}

// --- Dependant Identities ---

import type { DependantIdentity, ExtraPersona } from '../types';
import type { KenEntry } from '@forgesworn/kenspeckle';

const DEPENDANT_PREFIX = 'dependant:';

export async function saveDependant(dependant: DependantIdentity, encryptionKey: string): Promise<void> {
  if (!encryptionKey || encryptionKey.length < 8) {
    throw new Error('Encryption key required');
  }
  const encNpPriv = dependant.naturalPerson.privateKey
    ? await encryptSecret(dependant.naturalPerson.privateKey, encryptionKey)
    : '';
  const encPersonaPriv = dependant.persona.privateKey
    ? await encryptSecret(dependant.persona.privateKey, encryptionKey)
    : '';
  // Per-persona avatar keys — same at-rest treatment as privateKey. Hash +
  // URL stay clear (routing fields, parallel to the per-identity
  // exception on SignetIdentity).
  const encNpAvatarKey = dependant.naturalPerson.avatarKey
    ? await encryptSecret(dependant.naturalPerson.avatarKey, encryptionKey)
    : undefined;
  const encPersonaAvatarKey = dependant.persona.avatarKey
    ? await encryptSecret(dependant.persona.avatarKey, encryptionKey)
    : undefined;
  // Contact-share avatar keys — same at-rest treatment as avatarKey.
  const encNpContactAvatarKey = dependant.naturalPerson.contactAvatarKey
    ? await encryptSecret(dependant.naturalPerson.contactAvatarKey, encryptionKey)
    : undefined;
  const encPersonaContactAvatarKey = dependant.persona.contactAvatarKey
    ? await encryptSecret(dependant.persona.contactAvatarKey, encryptionKey)
    : undefined;
  const encExtras = dependant.extraPersonas
    ? await Promise.all(dependant.extraPersonas.map(async (ep) => ({
        ...ep,
        privateKey: ep.privateKey ? await encryptSecret(ep.privateKey, encryptionKey) : '',
        avatarKey: ep.avatarKey ? await encryptSecret(ep.avatarKey, encryptionKey) : undefined,
        contactAvatarKey: ep.contactAvatarKey ? await encryptSecret(ep.contactAvatarKey, encryptionKey) : undefined,
      })))
    : undefined;
  const encEndpoint = dependant.bunkerEndpoint
    ? {
        ...dependant.bunkerEndpoint,
        privateKey: dependant.bunkerEndpoint.privateKey
          ? await encryptSecret(dependant.bunkerEndpoint.privateKey, encryptionKey)
          : '',
        // Encrypted at rest for the same reason as appBunkerEndpoint's
        // pairingSecret below — it's a live one-time pairing challenge, not
        // routing metadata (2026-07-02 audit: this was the only field left
        // in the clear despite the two endpoint shapes being structurally
        // identical). authorizedClientPubkey stays clear (public pubkey).
        pairingSecret: dependant.bunkerEndpoint.pairingSecret
          ? await encryptSecret(dependant.bunkerEndpoint.pairingSecret, encryptionKey)
          : undefined,
      }
    : undefined;
  // App-bunker endpoint — symmetric encryption for the transport
  // private key + the in-flight pairing secret. The pairings array is
  // public-pubkey + label/origin/timestamps only, so it stays in the clear.
  const encAppEndpoint = dependant.appBunkerEndpoint
    ? {
        ...dependant.appBunkerEndpoint,
        privateKey: dependant.appBunkerEndpoint.privateKey
          ? await encryptSecret(dependant.appBunkerEndpoint.privateKey, encryptionKey)
          : '',
        pairingSecret: dependant.appBunkerEndpoint.pairingSecret
          ? await encryptSecret(dependant.appBunkerEndpoint.pairingSecret, encryptionKey)
          : undefined,
      }
    : undefined;
  const stored = {
    ...dependant,
    id: DEPENDANT_PREFIX + dependant.id,
    naturalPerson: { ...dependant.naturalPerson, privateKey: encNpPriv, avatarKey: encNpAvatarKey, contactAvatarKey: encNpContactAvatarKey },
    persona: { ...dependant.persona, privateKey: encPersonaPriv, avatarKey: encPersonaAvatarKey, contactAvatarKey: encPersonaContactAvatarKey },
    extraPersonas: encExtras,
    bunkerEndpoint: encEndpoint,
    appBunkerEndpoint: encAppEndpoint,
    encrypted: true,
  };
  const db = await getDB();
  await db.put('identity', stored);
}

export async function getDependants(guardianPubkey: string, encryptionKey?: string): Promise<DependantIdentity[]> {
  const db = await getDB();
  const all = await db.getAll('identity');
  const dependants: DependantIdentity[] = [];
  for (const record of all) {
    if (typeof record.id !== 'string' || !record.id.startsWith(DEPENDANT_PREFIX)) continue;
    if (record.guardianPubkey !== guardianPubkey) continue;
    const realId = record.id.slice(DEPENDANT_PREFIX.length);
    if (encryptionKey && record.encrypted) {
      try {
        const HEX_KEY_RE = /^[0-9a-f]{64}$/;
        async function decryptFully(value: string): Promise<string> {
          if (!value) return '';
          let result = await decryptSecret(value, encryptionKey!);
          let safety = 10;
          while (safety-- > 0) {
            if (HEX_KEY_RE.test(result) || !isEncrypted(result)) break;
            try {
              result = await decryptSecret(result, encryptionKey!);
            } catch {
              break;
            }
          }
          return result;
        }
        const npPriv = record.naturalPerson?.privateKey
          ? await decryptFully(record.naturalPerson.privateKey)
          : '';
        const personaPriv = record.persona?.privateKey
          ? await decryptFully(record.persona.privateKey)
          : '';
        // Per-persona avatar keys — same shape as privateKey (64-char hex),
        // so decryptFully's HEX_KEY_RE termination terminates cleanly.
        const npAvatarKey = record.naturalPerson?.avatarKey
          ? await decryptFully(record.naturalPerson.avatarKey)
          : undefined;
        const personaAvatarKey = record.persona?.avatarKey
          ? await decryptFully(record.persona.avatarKey)
          : undefined;
        // Contact-share avatar keys — same shape as avatarKey (64-char hex).
        const npContactAvatarKey = record.naturalPerson?.contactAvatarKey
          ? await decryptFully(record.naturalPerson.contactAvatarKey)
          : undefined;
        const personaContactAvatarKey = record.persona?.contactAvatarKey
          ? await decryptFully(record.persona.contactAvatarKey)
          : undefined;
        const decExtras = record.extraPersonas
          ? await Promise.all((record.extraPersonas as ExtraPersona[]).map(async (ep: ExtraPersona) => ({
              ...ep,
              privateKey: ep.privateKey ? await decryptFully(ep.privateKey) : '',
              avatarKey: ep.avatarKey ? await decryptFully(ep.avatarKey) : undefined,
              contactAvatarKey: ep.contactAvatarKey ? await decryptFully(ep.contactAvatarKey) : undefined,
            })))
          : undefined;
        const decEndpoint = record.bunkerEndpoint
          ? {
              publicKey: record.bunkerEndpoint.publicKey,
              privateKey: record.bunkerEndpoint.privateKey
                ? await decryptFully(record.bunkerEndpoint.privateKey)
                : '',
              createdAt: record.bunkerEndpoint.createdAt,
              // Pair-flow state fields. The decoder
              // previously only carried `publicKey`/`privateKey`/`createdAt`
              // through, which silently dropped both fields on every read —
              // meaning a successful `bindDependantBunkerClient` would write
              // `authorizedClientPubkey` to IDB but the next reload would
              // return the endpoint with `authorizedClientPubkey: undefined`.
              // That, in turn, made the publisher gate
              // (`endpoint.authorizedClientPubkey`) always fail, masking
              // every paired-child handshake.
              //
              // `pairingSecret` is ciphertext at rest (2026-07-02 audit —
              // encrypted on write above, symmetric with appBunkerEndpoint's
              // pairingSecret). Decrypt only if present; tolerate failure as
              // "no pair window open" rather than throwing the whole
              // dependant out. `authorizedClientPubkey` stays clear (public
              // pubkey, no secret).
              pairingSecret: record.bunkerEndpoint.pairingSecret
                ? await decryptFully(record.bunkerEndpoint.pairingSecret).catch(() => undefined)
                : undefined,
              authorizedClientPubkey: record.bunkerEndpoint.authorizedClientPubkey,
            }
          : undefined;
        // App-bunker endpoint. PrivateKey + pairingSecret are
        // ciphertext at rest; pairings are clear (no secrets). Decrypt the
        // pairing secret only if present — empty/undefined means no
        // pair window is open.
        let decAppEndpoint: TrustedAppEndpoint | undefined;
        if (record.appBunkerEndpoint) {
          const ae = record.appBunkerEndpoint as TrustedAppEndpoint;
          let decSecret: string | undefined = undefined;
          if (ae.pairingSecret) {
            try { decSecret = await decryptFully(ae.pairingSecret); }
            catch { /* tolerate — treat as no pair window */ }
          }
          decAppEndpoint = {
            publicKey: ae.publicKey,
            privateKey: ae.privateKey ? await decryptFully(ae.privateKey) : '',
            createdAt: ae.createdAt,
            pairingSecret: decSecret,
            pairings: Array.isArray(ae.pairings) ? ae.pairings : [],
          };
        }
        dependants.push({
          ...record,
          id: realId,
          naturalPerson: { ...record.naturalPerson, privateKey: npPriv, avatarKey: npAvatarKey, contactAvatarKey: npContactAvatarKey },
          persona: { ...record.persona, privateKey: personaPriv, avatarKey: personaAvatarKey, contactAvatarKey: personaContactAvatarKey },
          extraPersonas: decExtras,
          bunkerEndpoint: decEndpoint,
          appBunkerEndpoint: decAppEndpoint,
          primaryKeypair: record.primaryKeypair || 'natural-person',
          encrypted: false,
        } as DependantIdentity);
      } catch {
        // Decryption failed — SKIP this dependant entirely. Returning the
        // record with ciphertext in the privateKey fields would let
        // callers mistake ciphertext for a hex private key (the
        // `LocalSigningBackend` constructor would throw on the hex check,
        // but sync paths that don't construct a backend would silently
        // re-publish ciphertext). Callers still receive correctly-
        // decrypted dependants and the skip is invisible except that the
        // dependant temporarily doesn't show until the key is valid.
      }
    } else {
      // No encryption key available AND the record is NOT marked encrypted.
      // Encrypted dependant records are the only valid format on disk; a
      // dep row without `encrypted: true` is either malformed or a legacy
      // plaintext artefact. Skipping rather than returning leaks-clear
      // privateKey/mnemonic to the caller.
      if (record.encrypted !== true) {
        continue;
      }
      dependants.push({ ...record, id: realId, primaryKeypair: record.primaryKeypair || 'natural-person' } as DependantIdentity);
    }
  }
  // Apply the legacy publicProfile.{name,displayName,about,...} lift to
  // every dep on read so every caller sees the same post-lift shape.
  // Pre-pass-4, only useDependants.loadDependants ran the lift; the
  // sync path (useDependantsSync → fromSyncWire → mergeDependantWithLocal)
  // called db.getDependants directly and was therefore using legacy-shape
  // local records, then re-publishing them as legacy on the wire. Lift here
  // makes the invariant uniform across readers. Idempotent — already-lifted
  // records short-circuit via needsLiftDep.
  return dependants.map(liftDependantPublicProfileConfig);
}

export async function deleteDependant(pubkey: string): Promise<void> {
  const db = await getDB();
  await db.delete('identity', DEPENDANT_PREFIX + pubkey);
}

// --- App-bunker endpoint (per-dependant trusted-app pairings) ---
//
// `appBunkerEndpoint` is a per-dependant NIP-46 transport keypair holding up
// to TRUSTED_APP_PAIRING_CAP TrustedAppPairing records. Distinct from
// `bunkerEndpoint` (which is reserved for the child's own paired device).
// The keypair is fresh randomness — NOT derived from the mnemonic — so it
// lives only on this device and does NOT propagate via cross-device
// dependant sync. Cross-device sync of appBunkerEndpoint is OUT OF SCOPE
// a guardian's secondary device starts with no app pairings.
//
// All helpers below load/save through the existing dependant CRUD path so
// the privateKey + pairingSecret stay encrypted-at-rest. The `pairings`
// array is clear (only public pubkey, label, origin, timestamps).

/**
 * Load the dependant record (decrypted) for the helpers below. Throws if
 * the dependant is missing or decryption fails.
 */
async function loadDependantOrThrow(dependantId: string, encryptionKey: string): Promise<DependantIdentity> {
  if (!encryptionKey) throw new Error('Encryption key required');
  const db = await getDB();
  const record = await db.get('identity', DEPENDANT_PREFIX + dependantId);
  if (!record) throw new Error('Dependant not found');
  // Re-derive the dependant via the canonical guardian-scoped reader so
  // we share the multi-layer decryptFully path. Slightly heavier than a
  // direct read but keeps decryption logic in one place.
  if (!record.guardianPubkey) throw new Error('Dependant record missing guardianPubkey');
  const all = await getDependants(record.guardianPubkey, encryptionKey);
  const dep = all.find(d => d.id === dependantId);
  if (!dep) throw new Error('Dependant not found after decrypt');
  return dep;
}

/**
 * Ensure a `TrustedAppEndpoint` exists for the dependant. Generates a fresh
 * keypair if absent. Returns the (decrypted) endpoint. The keypair is fresh
 * randomness, not derived from the mnemonic — so it lives only on this
 * device. Cross-device sync of appBunkerEndpoint is OUT OF SCOPE for this
 * issue.
 */
export async function ensureAppBunkerEndpoint(
  dependantId: string,
  encryptionKey: string,
): Promise<TrustedAppEndpoint> {
  const dep = await loadDependantOrThrow(dependantId, encryptionKey);
  if (dep.appBunkerEndpoint?.privateKey && dep.appBunkerEndpoint?.publicKey) {
    return dep.appBunkerEndpoint;
  }
  const sk = generateSecretKey();
  const privHex = bytesToHex(sk);
  const pubHex = getPublicKey(sk);
  sk.fill(0);
  const endpoint: TrustedAppEndpoint = {
    publicKey: pubHex,
    privateKey: privHex,
    createdAt: Math.floor(Date.now() / 1000),
    pairings: [],
  };
  const updated: DependantIdentity = { ...dep, appBunkerEndpoint: endpoint };
  await saveDependant(updated, encryptionKey);
  return endpoint;
}

/** Mint and persist a fresh pairing secret. Used by PairDependantApp. */
export async function setAppBunkerPairingSecret(
  dependantId: string,
  secret: string,
  encryptionKey: string,
): Promise<void> {
  const dep = await loadDependantOrThrow(dependantId, encryptionKey);
  if (!dep.appBunkerEndpoint) throw new Error('Dependant has no app-bunker endpoint');
  if (dep.appBunkerEndpoint.pairingSecret === secret) return;
  const updated: DependantIdentity = {
    ...dep,
    appBunkerEndpoint: { ...dep.appBunkerEndpoint, pairingSecret: secret },
  };
  await saveDependant(updated, encryptionKey);
}

/** Clear the in-flight secret (after a successful connect). */
export async function clearAppBunkerPairingSecret(
  dependantId: string,
  encryptionKey: string,
): Promise<void> {
  const dep = await loadDependantOrThrow(dependantId, encryptionKey);
  if (!dep.appBunkerEndpoint) return;
  if (!dep.appBunkerEndpoint.pairingSecret) return;
  const updated: DependantIdentity = {
    ...dep,
    appBunkerEndpoint: { ...dep.appBunkerEndpoint, pairingSecret: undefined },
  };
  await saveDependant(updated, encryptionKey);
}

/**
 * Compute the next pairings array for a successful app-route bind.
 * Throws `Error('pairing slot limit reached')` if the new pairing would
 * push the array past `TRUSTED_APP_PAIRING_CAP`. Idempotent on
 * `clientPubkey` — bumps `lastSeenAt` on a duplicate rather than
 * appending. Pure helper so tests can exercise without IDB.
 */
function nextPairingsForBind(
  current: TrustedAppPairing[],
  pairing: TrustedAppPairing,
): TrustedAppPairing[] {
  const lcClient = pairing.clientPubkey.toLowerCase();
  const existing = current.find(p => p.clientPubkey.toLowerCase() === lcClient);
  if (existing) {
    return current.map(p =>
      p.clientPubkey.toLowerCase() === lcClient
        ? { ...p, lastSeenAt: pairing.lastSeenAt ?? p.lastSeenAt ?? Math.floor(Date.now() / 1000) }
        : p,
    );
  }
  if (current.length >= TRUSTED_APP_PAIRING_CAP) {
    throw new Error('pairing slot limit reached');
  }
  return [...current, { ...pairing, clientPubkey: lcClient }];
}

/**
 * Append a new pairing. Throws `Error('pairing slot limit reached')` if
 * appending would exceed `TRUSTED_APP_PAIRING_CAP`. Idempotent on
 * `clientPubkey` — if a pairing with that pubkey already exists, updates
 * its `lastSeenAt` rather than appending a duplicate.
 *
 * **Prefer `addAppBunkerPairingAndClearSecret` for the connect-flow
 * path.** Splitting the bind-write from the secret-clear leaves a brief
 * window where the just-used secret is still valid in IDB and a second
 * concurrent connect from a different clientPubkey can pass the secret
 * check and consume an extra slot. This standalone variant remains for
 * tests + the rare path that doesn't own a paired secret.
 */
export async function addAppBunkerPairing(
  dependantId: string,
  pairing: TrustedAppPairing,
  encryptionKey: string,
): Promise<void> {
  const dep = await loadDependantOrThrow(dependantId, encryptionKey);
  if (!dep.appBunkerEndpoint) throw new Error('Dependant has no app-bunker endpoint');
  const nextPairings = nextPairingsForBind(dep.appBunkerEndpoint.pairings, pairing);
  const updated: DependantIdentity = {
    ...dep,
    appBunkerEndpoint: { ...dep.appBunkerEndpoint, pairings: nextPairings },
  };
  await saveDependant(updated, encryptionKey);
}

/**
 * Atomic version: appends the pairing AND clears the in-flight pairing
 * secret in a single `saveDependant` write. Used by the NIP-46 connect
 * handler (`onAppPairingComplete`) so a second `connect` from a
 * different clientPubkey arriving between the bind-write and the
 * secret-clear-write can NOT pass the secret check and consume a
 * second slot — the `bindingInFlightRef` guard in `useBunkerServer`
 * only covers the duration of this call, not the gap between two
 * separate writes.
 *
 * Throws `Error('pairing slot limit reached')` on cap; the dispatcher
 * surfaces this back to the consumer as the NIP-46 error.
 */
export async function addAppBunkerPairingAndClearSecret(
  dependantId: string,
  pairing: TrustedAppPairing,
  encryptionKey: string,
): Promise<void> {
  const dep = await loadDependantOrThrow(dependantId, encryptionKey);
  if (!dep.appBunkerEndpoint) throw new Error('Dependant has no app-bunker endpoint');
  const nextPairings = nextPairingsForBind(dep.appBunkerEndpoint.pairings, pairing);
  const updated: DependantIdentity = {
    ...dep,
    appBunkerEndpoint: {
      ...dep.appBunkerEndpoint,
      pairings: nextPairings,
      pairingSecret: undefined,
    },
  };
  await saveDependant(updated, encryptionKey);
}

/** Remove a pairing by clientPubkey. No-op if not present. */
export async function removeAppBunkerPairing(
  dependantId: string,
  clientPubkey: string,
  encryptionKey: string,
): Promise<void> {
  const dep = await loadDependantOrThrow(dependantId, encryptionKey);
  if (!dep.appBunkerEndpoint) return;
  const lcClient = clientPubkey.toLowerCase();
  const next = dep.appBunkerEndpoint.pairings.filter(p => p.clientPubkey.toLowerCase() !== lcClient);
  if (next.length === dep.appBunkerEndpoint.pairings.length) return;
  const updated: DependantIdentity = {
    ...dep,
    appBunkerEndpoint: { ...dep.appBunkerEndpoint, pairings: next },
  };
  await saveDependant(updated, encryptionKey);
}

/** Read-only view of pairings for a dependant. */
export async function listAppBunkerPairings(
  dependantId: string,
  encryptionKey: string,
): Promise<TrustedAppPairing[]> {
  const dep = await loadDependantOrThrow(dependantId, encryptionKey);
  return dep.appBunkerEndpoint?.pairings ? [...dep.appBunkerEndpoint.pairings] : [];
}

/** Bump lastSeenAt for an existing pairing. No-op if missing. */
export async function touchAppBunkerPairing(
  dependantId: string,
  clientPubkey: string,
  encryptionKey: string,
): Promise<void> {
  const dep = await loadDependantOrThrow(dependantId, encryptionKey);
  if (!dep.appBunkerEndpoint) return;
  const lcClient = clientPubkey.toLowerCase();
  const existing = dep.appBunkerEndpoint.pairings.find(p => p.clientPubkey.toLowerCase() === lcClient);
  if (!existing) return;
  const now = Math.floor(Date.now() / 1000);
  const next = dep.appBunkerEndpoint.pairings.map(p =>
    p.clientPubkey.toLowerCase() === lcClient ? { ...p, lastSeenAt: now } : p,
  );
  const updated: DependantIdentity = {
    ...dep,
    appBunkerEndpoint: { ...dep.appBunkerEndpoint, pairings: next },
  };
  await saveDependant(updated, encryptionKey);
}

// --- Bunker Client Secret (encrypted) ---

const BUNKER_SECRET_KEY = 'bunkerSecret';

export async function saveBunkerSecret(clientSecret: string, encryptionKey: string): Promise<void> {
  const encrypted = await encryptSecret(clientSecret, encryptionKey);
  const db = await getDB();
  await db.put('identity', { id: BUNKER_SECRET_KEY, secret: encrypted });
}

export async function loadBunkerSecret(encryptionKey: string): Promise<string | null> {
  const db = await getDB();
  const record = await db.get('identity', BUNKER_SECRET_KEY);
  if (!record || !record.secret) return null;
  try {
    return await decryptSecret(record.secret, encryptionKey);
  } catch {
    return null;
  }
}

export async function deleteBunkerSecret(): Promise<void> {
  const db = await getDB();
  await db.delete('identity', BUNKER_SECRET_KEY);
}

// --- Heartwood operator credential (encrypted) ---
// One `identity`-store row keyed 'heartwoodOperator', the whole credential
// JSON encrypted with the unlock key — same pattern as `bunkerSecret`.
// The operator key authorises kind-24134 device management (policy push,
// verdicts); see `heartwood-operator.ts` (family-bunker §11.1.4/9, C3 §5).

const HEARTWOOD_OPERATOR_KEY = 'heartwoodOperator';

export async function saveHeartwoodOperator(
  cred: HeartwoodOperatorCredential,
  encryptionKey: string,
): Promise<void> {
  const encrypted = await encryptSecret(JSON.stringify(cred), encryptionKey);
  const db = await getDB();
  await db.put('identity', { id: HEARTWOOD_OPERATOR_KEY, secret: encrypted });
}

/** Returns null when nothing is stored, the key is wrong, or the decrypted
 *  payload isn't a well-formed credential. */
export async function loadHeartwoodOperator(
  encryptionKey: string,
): Promise<HeartwoodOperatorCredential | null> {
  const db = await getDB();
  const record = await db.get('identity', HEARTWOOD_OPERATOR_KEY);
  if (!record || !record.secret) return null;
  try {
    const parsed: unknown = JSON.parse(await decryptSecret(record.secret, encryptionKey));
    return isHeartwoodOperatorCredential(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function deleteHeartwoodOperator(): Promise<void> {
  const db = await getDB();
  await db.delete('identity', HEARTWOOD_OPERATOR_KEY);
}

// --- Professional Persona Private Key (encrypted) ---
// Stored with key 'professionalPersona' in the identity store.
// Same AES-256-GCM pattern as the mnemonic and bunkerSecret.
// Spec: 2026-04-25-pro-surface-architecture-design.md §4.5.9

const PRO_PERSONA_KEY = 'professionalPersona';

/**
 * Save the Professional Persona private key encrypted to the identity store.
 * Uses the same AES-256-GCM/PBKDF2 pattern as the mnemonic.
 * Key: 'professionalPersona'
 */
export async function saveProPersonaEncrypted(
  privKey: string,
  passphrase: string,
): Promise<void> {
  const ciphertext = await encryptSecret(privKey, passphrase);
  const db = await getDB();
  await db.put('identity', { id: PRO_PERSONA_KEY, value: ciphertext, encrypted: true });
}

/**
 * Load and decrypt the Professional Persona private key.
 * Returns null if not yet stored (first-time Pro entry pending).
 */
export async function loadProPersonaDecrypted(
  passphrase: string,
): Promise<string | null> {
  const db = await getDB();
  const row = await db.get('identity', PRO_PERSONA_KEY) as
    { value: string; encrypted: boolean } | undefined;
  if (!row) return null;
  if (row.encrypted !== true) return null;
  try {
    return await decryptSecret(row.value, passphrase);
  } catch {
    return null;
  }
}

/**
 * Delete the stored Professional Persona private key.
 * Called when the identity is fully deleted or re-derived.
 */
export async function deleteProPersonaRecord(): Promise<void> {
  const db = await getDB();
  await db.delete('identity', PRO_PERSONA_KEY);
}

/**
 * Purge ALL user data from all IndexedDB object stores.
 * Called during identity deletion to ensure no orphaned PII remains.
 */
export async function purgeAllUserData(): Promise<void> {
  const db = await getDB();
  await db.clear('identity');
  await db.clear('contacts');
  await db.clear('child-settings');
  await db.clear('preferences');
  await db.clear('documents');
  await db.clear('credentials');
  await db.clear('authorizedSites');
  if (db.objectStoreNames.contains('originPolicies')) {
    await db.clear('originPolicies');
  }
  if (db.objectStoreNames.contains('connectedClients')) {
    await db.clear('connectedClients');
    notifyConnectedClientsChanged();
  }
  if (db.objectStoreNames.contains('grants')) {
    await db.clear('grants');
  }
  if (db.objectStoreNames.contains('pairedChild')) {
    await db.clear('pairedChild');
  }
  if (db.objectStoreNames.contains('pairedChildStatus')) {
    await db.clear('pairedChildStatus');
  }
  if (db.objectStoreNames.contains('pairedChildPersonaRevision')) {
    await db.clear('pairedChildPersonaRevision');
  }
  if (db.objectStoreNames.contains('publicProfileSignAuth')) {
    await db.clear('publicProfileSignAuth');
  }
  if (db.objectStoreNames.contains('professionalRegistry')) {
    await db.clear('professionalRegistry');
  }
  if (db.objectStoreNames.contains('professionalSignetJson')) {
    await db.clear('professionalSignetJson');
  }
  if (db.objectStoreNames.contains('proDirectorySeen')) {
    await db.clear('proDirectorySeen');
  }
  if (db.objectStoreNames.contains('ken')) {
    await db.clear('ken');
  }
  if (db.objectStoreNames.contains('contactAvatars')) await db.clear('contactAvatars');
  if (db.objectStoreNames.contains('gracePeriodState')) await db.clear('gracePeriodState');
  if (db.objectStoreNames.contains('graceKey')) await db.clear('graceKey');
  if (db.objectStoreNames.contains('companionGrants')) await db.clear('companionGrants');
  if (db.objectStoreNames.contains('syncCache')) await db.clear('syncCache');
  if (db.objectStoreNames.contains('syncSeen')) await db.clear('syncSeen');
  if (db.objectStoreNames.contains('privateVaultState')) {
    await privateVaultQueue.run(() => db.clear('privateVaultState'));
  }
  if (db.objectStoreNames.contains('contactRecordsV2')) await db.clear('contactRecordsV2');
  if (db.objectStoreNames.contains('contactOpsV2')) await db.clear('contactOpsV2');
  if (db.objectStoreNames.contains('contactImportSources')) await db.clear('contactImportSources');
  // R-22 (fix round 1, minor 1): the grant wipe rides the SAME queue as every
  // other grant write. Outside it, a write already queued when the purge
  // started — a proposal batch's `updateContactGrantV2`, a projection's
  // publish-state write, a rail merge's `saveContactGrantV2` — could land
  // AFTER the clear and re-put a row carrying a rail PRIVATE KEY into a
  // database the owner just asked to be emptied. Queuing it means the wipe is
  // ordered against those writes: anything queued before it is flushed first
  // and then cleared, and anything queued after it starts from an empty store
  // (`updateContactGrantV2` finds no row and writes nothing; only an explicit
  // `saveContactGrantV2` could create one, which is a fresh approval, not
  // residue). The `getDB()` handle above is reused deliberately — reopening
  // inside the task would race the purge's own connection.
  if (db.objectStoreNames.contains('contactGrantsV2')) {
    await grantWriteQueue.run(() => db.clear('contactGrantsV2'));
  }
}

// --- Paired-child dependant-status cache ---

/**
 * Write the cached dependant status. Called by the child-side subscriber
 * hook after a successful NIP-44 decrypt of a guardian-published status
 * event. M10 (2026-07-02 audit): keyed by `record.dependantPubkey` — a
 * shared family device can hold multiple pairings, so a fixed row key
 * would let one child's status clobber another's.
 */
export async function savePairedChildStatus(record: Omit<DependantStatusRecord, 'id'>): Promise<void> {
  if (!HEX64.test(record.dependantPubkey)) {
    throw new Error('Invalid dependantPubkey');
  }
  const db = await getDB();
  const dependantPubkey = record.dependantPubkey.toLowerCase();
  await db.put('pairedChildStatus', { ...record, dependantPubkey, id: dependantPubkey });
}

/**
 * Read the cached status for a specific dependant. Returns null when no
 * event has ever been synced for that child (brand-new pair). Callers
 * treat a null as "dormant" per the OQ1-139 conservative-default
 * consensus.
 */
export async function loadPairedChildStatus(dependantPubkey: string): Promise<DependantStatusRecord | null> {
  if (!HEX64.test(dependantPubkey)) return null;
  const db = await getDB();
  const raw = await db.get('pairedChildStatus', dependantPubkey.toLowerCase()) as DependantStatusRecord | undefined;
  return raw ?? null;
}

/**
 * Drop the cached status for one dependant — called on unpair/remove.
 * (Full-logout purge already clears the whole `pairedChildStatus` store
 * directly — see `purgeAllUserData`.)
 */
export async function clearPairedChildStatus(dependantPubkey: string): Promise<void> {
  if (!HEX64.test(dependantPubkey)) return;
  const db = await getDB();
  await db.delete('pairedChildStatus', dependantPubkey.toLowerCase());
}

// --- Paired-child persona-inventory revision cache ---

const PAIRED_CHILD_PERSONA_REV_ID = 'paired-child-persona-rev';

/** Persist the latest applied revision (unix seconds). */
export async function savePairedChildPersonaRevision(revision: number): Promise<void> {
  const db = await getDB();
  await db.put('pairedChildPersonaRevision', { id: PAIRED_CHILD_PERSONA_REV_ID, revision });
}

/** Returns 0 when never synced. */
export async function loadPairedChildPersonaRevision(): Promise<number> {
  const db = await getDB();
  const raw = await db.get('pairedChildPersonaRevision', PAIRED_CHILD_PERSONA_REV_ID) as { revision: number } | undefined;
  return raw?.revision ?? 0;
}

/** Drop the cache — called on logout / delete / unpair. */
export async function clearPairedChildPersonaRevision(): Promise<void> {
  const db = await getDB();
  await db.delete('pairedChildPersonaRevision', PAIRED_CHILD_PERSONA_REV_ID);
}

// --- Paired-child record (child-device side of phone-as-family-bunker) ---
//
// Single-row store. See `PairedChildRecord` in types.ts and
// Private fields (`bunkerUri`,
// `clientKeypair.privateKey`) are encrypted at rest with the device PIN-
// derived key so a dumped IDB can't leak the pairing credentials.

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Shape of the public meta returned by `listPairedChildMetas` — the
 * same fields `peekPairedChildMeta` used to return, now multi-row. No
 * encrypted fields ever cross this boundary, so callers can read it
 * before the user has unlocked the device (the picker relies
 * on this — it needs the display names to render before decryption).
 */
export interface PairedChildMeta {
  dependantPubkey: string;
  dependantName: string;
  pairedAt: number;
}

export async function savePairedChild(record: Omit<PairedChildRecord, 'id' | 'encrypted'>, encryptionKey: string): Promise<void> {
  if (!encryptionKey || encryptionKey.length < 8) {
    throw new Error('Encryption key required');
  }
  if (typeof record.bunkerUri !== 'string' || !record.bunkerUri.startsWith('bunker://')) {
    throw new Error('Invalid bunkerUri');
  }
  if (!HEX64.test(record.clientKeypair.publicKey) || !HEX64.test(record.clientKeypair.privateKey)) {
    throw new Error('Invalid client keypair');
  }
  if (!HEX64.test(record.dependantPubkey)) {
    throw new Error('Invalid dependantPubkey');
  }
  if (typeof record.dependantName !== 'string' || record.dependantName.length === 0) {
    throw new Error('Invalid dependantName');
  }
  if (record.guardianPubkey !== undefined && !HEX64.test(record.guardianPubkey)) {
    throw new Error('Invalid guardianPubkey');
  }
  const encryptedUri = await encryptSecret(record.bunkerUri, encryptionKey);
  const encryptedPriv = await encryptSecret(record.clientKeypair.privateKey, encryptionKey);
  const dependantPubkey = record.dependantPubkey.toLowerCase();
  const stored: PairedChildRecord = {
    // After multi-pairing support, the keyPath IS the dependant pubkey — one row per child.
    id: dependantPubkey,
    bunkerUri: encryptedUri,
    clientKeypair: {
      publicKey: record.clientKeypair.publicKey.toLowerCase(),
      privateKey: encryptedPriv,
    },
    dependantPubkey,
    dependantName: record.dependantName,
    pairedAt: record.pairedAt,
    hasPaired: record.hasPaired ?? false,
    encrypted: true,
    ...(record.guardianPubkey ? { guardianPubkey: record.guardianPubkey.toLowerCase() } : {}),
  };
  const db = await getDB();
  await db.put('pairedChild', stored);
}

export async function loadPairedChild(dependantPubkey: string, encryptionKey: string): Promise<PairedChildRecord | null> {
  if (!HEX64.test(dependantPubkey)) return null;
  const db = await getDB();
  const raw = await db.get('pairedChild', dependantPubkey.toLowerCase()) as PairedChildRecord | undefined;
  if (!raw) return null;
  if (!raw.encrypted) {
    // Defence: we only ever write encrypted records. An unencrypted one in the
    // store is either corruption or a manual devtools write — refuse to load.
    throw new Error('Paired-child record is not encrypted — refusing to load');
  }
  try {
    const bunkerUri = await decryptSecret(raw.bunkerUri, encryptionKey);
    const privateKey = await decryptSecret(raw.clientKeypair.privateKey, encryptionKey);
    return {
      ...raw,
      bunkerUri,
      clientKeypair: { ...raw.clientKeypair, privateKey },
      encrypted: false,
    };
  } catch {
    return null; // wrong passphrase or corrupted ciphertext
  }
}

/**
 * Public metas for every pairing stored on this device. Callers render
 * the picker list from this — no encrypted fields, no PIN required.
 * Sorted by `pairedAt` descending so the most-recently-paired child
 * shows first.
 */
export async function listPairedChildMetas(): Promise<PairedChildMeta[]> {
  const db = await getDB();
  const all = await db.getAll('pairedChild') as PairedChildRecord[];
  const metas = all
    .filter(r => typeof r.dependantPubkey === 'string' && HEX64.test(r.dependantPubkey))
    .map(r => ({
      dependantPubkey: r.dependantPubkey,
      dependantName: r.dependantName,
      pairedAt: r.pairedAt,
    }));
  return metas.sort((a, b) => b.pairedAt - a.pairedAt);
}

export async function clearPairedChild(dependantPubkey: string): Promise<void> {
  if (!HEX64.test(dependantPubkey)) return;
  const db = await getDB();
  await db.delete('pairedChild', dependantPubkey.toLowerCase());
}

/** Drop every pairing on the device. Used on logout / delete. */
export async function clearAllPairedChildren(): Promise<void> {
  const db = await getDB();
  await db.clear('pairedChild');
}

/** Mark a successfully connected pairing without rewriting its encrypted fields
 * or discarding independently cached state. Never mark a replacement pairing. */
export async function markPairedChildConnected(dependantPubkey: string, encryptionKey: string): Promise<void> {
  if (!HEX64.test(dependantPubkey)) return;
  const db = await getDB(), id = dependantPubkey.toLowerCase();
  const raw = await db.get('pairedChild', id) as PairedChildRecord | undefined;
  if (!raw?.encrypted || raw.hasPaired) return;
  try {
    await decryptSecret(raw.bunkerUri, encryptionKey);
    await decryptSecret(raw.clientKeypair.privateKey, encryptionKey);
  } catch { return; }
  const tx = db.transaction('pairedChild', 'readwrite');
  const fresh = await tx.store.get(id) as PairedChildRecord | undefined;
  if (fresh?.encrypted && fresh.bunkerUri === raw.bunkerUri && fresh.clientKeypair.privateKey === raw.clientKeypair.privateKey
    && fresh.clientKeypair.publicKey === raw.clientKeypair.publicKey && fresh.guardianPubkey === raw.guardianPubkey) {
    await tx.store.put({ ...fresh, hasPaired: true });
  }
  await tx.done;
}

/**
 * Re-pair an existing PairedChildRecord against a fresh guardian endpoint.
 *
 * Used when the guardian's per-dep bunker endpoint has been revoked +
 * regenerated (typical reason: guardian replaced their phone — the random
 * endpoint keypair doesn't round-trip through mnemonic restore). The kid's
 * existing identity / PIN / audit cache / persona-revision cache MUST be
 * preserved; only the transport-level pairing fields change.
 *
 * Updates in place:
 *  - `bunkerUri` — new endpoint pubkey + secret
 *  - `clientKeypair` — caller may rotate (recommended; the new endpoint
 *    expects a fresh `connect` and rotating reduces correlation surface)
 *  - `hasPaired` — reset to `false` so the next session uses `connect`
 *    (not `reconnect`) and binds the new client pubkey server-side
 *  - `pairedAt` — refreshed to the re-pair timestamp
 *
 * Preserves: `id`, `dependantPubkey`, `dependantName`, encryption flag.
 *
 * The caller is responsible for verifying the new bunker URI's
 * `dependantPubkey` matches the existing record before invoking this —
 * see the gating policy (identity match
 * required; otherwise refuse with a clear "this code is for a different
 * identity" error).
 */
export async function repairPairedChild(
  dependantPubkey: string,
  newBunkerUri: string,
  newClientKeypair: { publicKey: string; privateKey: string },
  encryptionKey: string,
  /**
   * Guardian pubkey from the freshly-scanned re-pair QR (`parsed.guardianPubkey`).
   * Falls back to the existing record's value when the fresh QR predates
   * the `guardian=` param — pairing already trusted that guardian's
   * pubkey once, so preserving it on repair is not a downgrade.
   */
  newGuardianPubkey?: string,
): Promise<void> {
  const existing = await loadPairedChild(dependantPubkey, encryptionKey);
  if (!existing) throw new Error('No existing pairing to repair');
  await savePairedChild({
    bunkerUri: newBunkerUri,
    clientKeypair: newClientKeypair,
    dependantPubkey: existing.dependantPubkey,
    dependantName: existing.dependantName,
    pairedAt: Math.floor(Date.now() / 1000),
    hasPaired: false,
    guardianPubkey: newGuardianPubkey ?? existing.guardianPubkey,
  }, encryptionKey);
}

// --- Remembered grants (per-dependant, per-scope, per-origin sign-policy memory) ---
//
// Stored on the guardian phone only. See 2026-04-22 dependant-accounts spec
// §"Remembered grants". Keyed by compound key
// [dependantId, scope, origin].

function normaliseGrantKey(g: RememberedGrant): RememberedGrant {
  return { ...g, dependantId: g.dependantId.toLowerCase(), scope: g.scope.toLowerCase(), origin: g.origin.toLowerCase() };
}

export async function lookupGrant(dependantId: string, scope: string, origin: string): Promise<RememberedGrant | undefined> {
  const db = await getDB();
  const grant = await db.get('grants', [dependantId.toLowerCase(), scope.toLowerCase(), origin.toLowerCase()]) as RememberedGrant | undefined;
  if (!grant) return undefined;
  // Honour tombstones first — a revoked grant is invisible to callers
  // regardless of expiry or decision. Tombstones are soft-
  // deletes that survive in IDB so the revocation can propagate to the
  // guardian's other devices under last-write-wins sync.
  if (typeof grant.tombstonedAt === 'number' && grant.tombstonedAt > 0) return undefined;
  // Honour `expiresAt` — expired grants are invisible to callers. The record
  // itself stays in IDB until something explicitly removes it (future sweep
  // job when grant expiry cleanup lands).
  if (typeof grant.expiresAt === 'number' && grant.expiresAt > 0) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds >= grant.expiresAt) return undefined;
  }
  return grant;
}

export async function saveGrant(grant: RememberedGrant): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(grant.dependantId)) {
    throw new Error('Invalid dependantId — expected 64-char hex');
  }
  if (!grant.scope || typeof grant.scope !== 'string') {
    throw new Error('Invalid scope');
  }
  if (!grant.origin || typeof grant.origin !== 'string') {
    throw new Error('Invalid origin');
  }
  if (grant.decision !== 'allow' && grant.decision !== 'deny') {
    throw new Error('Invalid decision');
  }
  const db = await getDB();
  await db.put('grants', normaliseGrantKey(grant));
}

/**
 * Revoke a grant by marking it with a tombstone (soft-delete). The
 * record stays in IDB so the revocation can propagate to the guardian's
 * other devices via grants-sync — hard-deleting would mean the remote
 * device re-creates the grant on next merge. Tombstones are opaque to
 * `lookupGrant` and the default `listGrantsForDependant` view, but are
 * returned by `listAllGrantsIncludingTombstones` for the sync publisher.
 */
export async function revokeGrant(dependantId: string, scope: string, origin: string): Promise<void> {
  const db = await getDB();
  const key = [dependantId.toLowerCase(), scope.toLowerCase(), origin.toLowerCase()];
  const existing = await db.get('grants', key) as RememberedGrant | undefined;
  const now = Math.floor(Date.now() / 1000);
  if (!existing) {
    // Seed a tombstone record even when nothing local existed — the
    // other device might have an allow for this key that we need to
    // supersede on next sync.
    await db.put('grants', {
      dependantId: dependantId.toLowerCase(),
      scope: scope.toLowerCase(),
      origin: origin.toLowerCase(),
      decision: 'deny',
      decidedAt: now,
      tombstonedAt: now,
    } satisfies RememberedGrant);
    return;
  }
  await db.put('grants', { ...existing, tombstonedAt: now });
}

export async function listGrantsForDependant(dependantId: string): Promise<RememberedGrant[]> {
  const db = await getDB();
  const idx = db.transaction('grants').store.index('dependantId');
  const all = await idx.getAll(dependantId.toLowerCase()) as RememberedGrant[];
  return all.filter(g => !g.tombstonedAt || g.tombstonedAt <= 0);
}

/**
 * Returns only live (non-tombstoned) grants. The default list for UI
 * surfaces and pre-sync local reads.
 */
export async function listAllGrants(): Promise<RememberedGrant[]> {
  const db = await getDB();
  const all = await db.getAll('grants') as RememberedGrant[];
  return all.filter(g => !g.tombstonedAt || g.tombstonedAt <= 0);
}

/**
 * Returns every grant record including tombstones. Used by the grants
 * sync publisher so tombstones ride along to the remote device.
 * Do NOT use this for UI — callers would see revoked grants.
 */
export async function listAllGrantsIncludingTombstones(): Promise<RememberedGrant[]> {
  const db = await getDB();
  return db.getAll('grants') as Promise<RememberedGrant[]>;
}

export async function deleteGrantsForDependant(dependantId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('grants', 'readwrite');
  const idx = tx.store.index('dependantId');
  const keys = await idx.getAllKeys(dependantId.toLowerCase());
  for (const k of keys) {
    await tx.store.delete(k as IDBValidKey);
  }
  await tx.done;
}

// --- Connected NIP-46 clients (bunker server) ---

const connectedClientListeners = new Set<() => void>();

/** Notify the mounted Connections view after a grant transaction commits. */
export function subscribeConnectedClients(listener: () => void): () => void {
  connectedClientListeners.add(listener);
  return () => { connectedClientListeners.delete(listener); };
}

function notifyConnectedClientsChanged(): void {
  for (const listener of connectedClientListeners) listener();
}

export async function getConnectedClient(clientPubkey: string): Promise<ConnectedClient | undefined> {
  const db = await getDB();
  return db.get('connectedClients', clientPubkey);
}

export async function listConnectedClients(): Promise<ConnectedClient[]> {
  const db = await getDB();
  return db.getAll('connectedClients');
}

export async function saveConnectedClient(client: ConnectedClient): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(client.clientPubkey)) {
    throw new Error('Invalid clientPubkey — expected 64-char hex');
  }
  const db = await getDB();
  if (!db.objectStoreNames.contains('connectedClients')) {
    throw new Error('connectedClients store missing — IDB version may be outdated. Try refresh.');
  }
  await db.put('connectedClients', client);
  notifyConnectedClientsChanged();
}

export async function deleteConnectedClient(clientPubkey: string): Promise<void> {
  const db = await getDB();
  await db.delete('connectedClients', clientPubkey);
  notifyConnectedClientsChanged();
}

// ── Professional registry cache ─────────────────────────────────────────────

export interface ProfessionalRegistryCacheRow {
  /** `${registryId}:${identifier}` e.g. "GIAS:100000" */
  canonicalKey: string;
  record: import('./professional/types').RegulatedEntityRecord;
  fetchedAt: string;
}

export async function getProfessionalRegistryRecord(
  canonicalKey: string
): Promise<ProfessionalRegistryCacheRow | undefined> {
  return (await getDB()).get('professionalRegistry', canonicalKey);
}

export async function putProfessionalRegistryRecord(
  row: ProfessionalRegistryCacheRow
): Promise<void> {
  await (await getDB()).put('professionalRegistry', row);
}

// ── Professional signet.json cache ──────────────────────────────────────────

export interface ProfessionalSignetJsonCacheRow {
  /** Bare hostname e.g. "springfield-school.example" */
  canonicalDomain: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
  fetchedAt: string;
}

export async function getSignetJsonCache(
  canonicalDomain: string
): Promise<ProfessionalSignetJsonCacheRow | undefined> {
  return (await getDB()).get('professionalSignetJson', canonicalDomain);
}

export async function putSignetJsonCache(
  row: ProfessionalSignetJsonCacheRow
): Promise<void> {
  await (await getDB()).put('professionalSignetJson', row);
}

// ── Verify-chain cache helpers (plan-alias wrappers) ──────────────────────────
// These thin wrappers bridge the verify-chain module's expected API to the
// canonical getProfessionalRegistryRecord / getSignetJsonCache functions above.

export interface ProRegistryCacheEntry {
  record: import('./professional/types').RegulatedEntityRecord;
  cachedAt: number;
}

/**
 * `professionKind` is required — the canonical store is keyed by
 * `${professionKind}:${identifier}`, and two DIFFERENT registries can
 * assign colliding identifiers of the same shape (e.g. a 6-digit GIAS URN
 * and a 6-digit SRA firm number). Looking up by identifier suffix alone
 * (pre-M5 behaviour) could return the WRONG profession's cached record —
 * see 2026-07-02 audit finding M5.
 */
export async function getProRegistryRecord(
  identifier: string,
  professionKind: string,
): Promise<ProRegistryCacheEntry | null> {
  const db = await getDB();
  const canonicalKey = `${professionKind}:${identifier}`;
  const match = await db.get('professionalRegistry', canonicalKey);
  if (!match) return null;
  return {
    record: match.record,
    cachedAt: new Date(match.fetchedAt).getTime(),
  };
}

export async function setProRegistryRecord(
  identifier: string,
  record: import('./professional/types').RegulatedEntityRecord
): Promise<void> {
  const canonicalKey = `${record.professionKind}:${identifier}`;
  await putProfessionalRegistryRecord({
    canonicalKey,
    record,
    fetchedAt: record.fetchedAt,
  });
}

export interface ProSignetJsonCacheEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: Record<string, any>;
  cachedAt: number;
}

export async function getProSignetJson(
  domain: string
): Promise<ProSignetJsonCacheEntry | null> {
  const row = await getSignetJsonCache(domain);
  if (!row) return null;
  return {
    json: row.data,
    cachedAt: new Date(row.fetchedAt).getTime(),
  };
}

export async function setProSignetJson(
  domain: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: Record<string, any>
): Promise<void> {
  await putSignetJsonCache({
    canonicalDomain: domain,
    data: json,
    fetchedAt: new Date().toISOString(),
  });
}

/** See `getProRegistryRecord` for why `professionKind` is required (M5). */
export async function invalidateProRegistryRecord(identifier: string, professionKind: string): Promise<void> {
  const db = await getDB();
  await db.delete('professionalRegistry', `${professionKind}:${identifier}`);
}

export async function invalidateProSignetJson(domain: string): Promise<void> {
  await (await getDB()).delete('professionalSignetJson', domain);
}

/**
 * Persist the lead's directory-listing preference against the registry cache record.
 * A no-op if the record does not yet exist.
 */
export async function saveProDirectoryPreference(
  identifier: { kind: string; value: string },
  listed: boolean,
): Promise<void> {
  const db = await getDB();
  const key = `${identifier.kind}:${identifier.value}`;
  const existing = await db.get('professionalRegistry', key) as Record<string, unknown> | undefined;
  if (!existing) return;
  await db.put('professionalRegistry', { ...existing, directoryListed: listed });
}

// ─── Public profile sign-auth (kind-0 / kind-5 pre-authorisation) ──────────
//
// Per the per-persona public-profile design §5.4.1: when the guardian enables
// a dep persona's publicProfile, the bunker server should auto-sign the
// kid's subsequent kind-0 / kind-5 publish requests without prompting (the
// guardian already explicitly authorised the publish-on-behalf relationship
// at toggle time). Pre-auth records carry a TTL; expired records fall back
// to manual approval.

export interface PublicProfileSignAuthRecord {
  depId: string;
  personaPubkey: string;
  kidClientPubkey: string;
  kind: number;
  expiresAt: number;
  createdAt: number;
}

const PUBLIC_PROFILE_SIGN_AUTH_DEFAULT_TTL_S = 24 * 60 * 60;

/** Upsert a pre-auth record — refreshes TTL on each call. */
export async function savePublicProfileSignAuth(
  depId: string,
  personaPubkey: string,
  kidClientPubkey: string,
  kind: number,
  ttlSeconds: number = PUBLIC_PROFILE_SIGN_AUTH_DEFAULT_TTL_S,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const rec: PublicProfileSignAuthRecord = {
    depId,
    personaPubkey: personaPubkey.toLowerCase(),
    kidClientPubkey: kidClientPubkey.toLowerCase(),
    kind,
    expiresAt: now + ttlSeconds,
    createdAt: now,
  };
  const db = await getDB();
  await db.put('publicProfileSignAuth', rec);
}

export async function getPublicProfileSignAuth(
  depId: string,
  personaPubkey: string,
  kidClientPubkey: string,
  kind: number,
): Promise<PublicProfileSignAuthRecord | undefined> {
  const db = await getDB();
  return db.get('publicProfileSignAuth', [
    depId,
    personaPubkey.toLowerCase(),
    kidClientPubkey.toLowerCase(),
    kind,
  ]) as Promise<PublicProfileSignAuthRecord | undefined>;
}

/** Returns true when a non-expired pre-auth exists for the tuple. */
export async function isPublicProfileSignAuthorised(
  depId: string,
  personaPubkey: string,
  kidClientPubkey: string,
  kind: number,
): Promise<boolean> {
  const rec = await getPublicProfileSignAuth(depId, personaPubkey, kidClientPubkey, kind);
  if (!rec) return false;
  const now = Math.floor(Date.now() / 1000);
  return rec.expiresAt > now;
}

export async function deletePublicProfileSignAuth(
  depId: string,
  personaPubkey: string,
  kidClientPubkey: string,
  kind: number,
): Promise<void> {
  const db = await getDB();
  await db.delete('publicProfileSignAuth', [
    depId,
    personaPubkey.toLowerCase(),
    kidClientPubkey.toLowerCase(),
    kind,
  ]);
}

/** Sweep expired pre-auth records. Called on `useBunkerServer` mount. */
export async function sweepExpiredPublicProfileSignAuth(): Promise<number> {
  const db = await getDB();
  const all = await db.getAll('publicProfileSignAuth') as PublicProfileSignAuthRecord[];
  const now = Math.floor(Date.now() / 1000);
  let removed = 0;
  for (const rec of all) {
    if (rec.expiresAt <= now) {
      await db.delete('publicProfileSignAuth', [rec.depId, rec.personaPubkey, rec.kidClientPubkey, rec.kind]);
      removed++;
    }
  }
  return removed;
}

/** Read-all for the GuardianSettings "Manage public-profile sign permissions" UI. */
export async function listPublicProfileSignAuthForDep(depId: string): Promise<PublicProfileSignAuthRecord[]> {
  const db = await getDB();
  const all = await db.getAll('publicProfileSignAuth') as PublicProfileSignAuthRecord[];
  return all.filter(r => r.depId === depId);
}

/**
 * Sweep all pre-auth records for a given `(depId, kidClientPubkey)` —
 * used when the dep's bunker endpoint is regenerated. Without this, an
 * attacker holding the *old* `kidClientPubkey` could continue to auto-
 * sign kind-0 / kind-5 events for the remaining TTL of any in-flight
 * records (up to 24 hours).
 *
 * Match is case-insensitive on `kidClientPubkey` to mirror the lowercase
 * normalisation in `savePublicProfileSignAuth`.
 */
export async function deletePublicProfileSignAuthByClient(
  depId: string,
  oldKidClientPubkey: string,
): Promise<number> {
  const db = await getDB();
  const target = oldKidClientPubkey.toLowerCase();
  const all = await db.getAll('publicProfileSignAuth') as PublicProfileSignAuthRecord[];
  let removed = 0;
  for (const rec of all) {
    if (rec.depId === depId && rec.kidClientPubkey === target) {
      await db.delete('publicProfileSignAuth', [rec.depId, rec.personaPubkey, rec.kidClientPubkey, rec.kind]);
      removed++;
    }
  }
  return removed;
}

/**
 * Sweep all pre-auth records for a given `(depId, personaPubkey)` — used
 * when an extra persona is removed from the dep. Without this, stale
 * pre-auth records for the deleted persona could persist for up to 24h
 * (TTL fallback); the persona itself is gone so the records are also
 * unreachable to legitimate flow but should be cleaned for hygiene and
 * to keep the §5.4.1 pre-auth UI accurate.
 *
 * Match is case-insensitive on `personaPubkey` to mirror the lowercase
 * normalisation in `savePublicProfileSignAuth`.
 */
export async function deletePublicProfileSignAuthByPersona(
  depId: string,
  personaPubkey: string,
): Promise<number> {
  const db = await getDB();
  const target = personaPubkey.toLowerCase();
  const all = await db.getAll('publicProfileSignAuth') as PublicProfileSignAuthRecord[];
  let removed = 0;
  for (const rec of all) {
    if (rec.depId === depId && rec.personaPubkey === target) {
      await db.delete('publicProfileSignAuth', [rec.depId, rec.personaPubkey, rec.kidClientPubkey, rec.kind]);
      removed++;
    }
  }
  return removed;
}

/**
 * LEGACY (spec §9, one release only). Read path for the retired no-lock handle,
 * kept so an identity created under it can be migrated onto a PIN/biometric.
 * There is no writer any more — `setupGrace` is gone. Delete this, the two
 * `endGrace*` helpers and the `'grace'` literal in `getAuthMethod` after the
 * migration release.
 */
// --- Grace Period State (v19) ---

/** Presence-only flag: a row exists iff this identity predates the lock requirement. */
export interface GraceState {
  id: string;       // identity id this marker row belongs to
}

export async function getGraceState(id: string): Promise<GraceState | undefined> {
  const db = await getDB();
  return db.get('gracePeriodState', id) as Promise<GraceState | undefined>;
}

export async function clearGraceState(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('gracePeriodState', id);
}

/**
 * LEGACY (spec §9, one release only). Read path for the retired no-lock handle,
 * kept so an identity created under it can be migrated onto a PIN/biometric.
 * There is no writer any more — `setupGrace` is gone. Delete this, the two
 * `endGrace*` helpers and the `'grace'` literal in `getAuthMethod` after the
 * migration release.
 */
// --- Grace Key (v19) ---

export interface GraceKeyRecord {
  id: 'current';
  handle: CryptoKey;   // non-extractable AES-GCM key
  wrapped: string;     // base64(iv || ciphertext) of the encryption key
}

export async function getGraceKey(): Promise<GraceKeyRecord | undefined> {
  const db = await getDB();
  return db.get('graceKey', 'current') as Promise<GraceKeyRecord | undefined>;
}

export async function clearGraceKey(): Promise<void> {
  const db = await getDB();
  await db.delete('graceKey', 'current');
}
