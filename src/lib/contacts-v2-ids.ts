/**
 * Contacts v2 identifiers (§8.2).
 *
 * Two kinds of id live here and they must not be confused:
 *   - RANDOM (`newContactId`, `newOperationId`, `newDeviceId`) — a brand-new
 *     contact, a brand-new operation, this device. 16 random bytes, 32 hex.
 *   - DETERMINISTIC (`importContactId`, `importOperationId`) — a legacy row
 *     lifted into v2. Domain-separated SHA-256, truncated to 32 hex, so a
 *     re-run of the import produces byte-identical operations and is a no-op.
 *
 * The truncation is deliberate: these are idempotency keys inside one device's
 * own encrypted store, not collision-resistant commitments.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Which legacy store a v2 record was imported from. */
export type LegacyRecordClass = 'contact' | 'ken';

const HEX32_RE = /^[0-9a-f]{32}$/;

/**
 * Every dependant — tree-derived or imported alike — is addressed by its own
 * stable record pubkey, never by a derivation index. This is deliberate: a
 * paired-child device has no `derivationPath` of its own to consult, so the
 * ONLY id it can compute for itself is one derived from its own pubkey — and
 * that must be byte-identical to the directory id the guardian's device uses
 * for the same dependant. A derivation-index scheme (`dependant:<N>`) can
 * never satisfy that on both sides at once; a pubkey-keyed scheme can.
 */
export function directoryIdForDependant(dep: { id: string }): string {
  return `dependant:${dep.id.toLowerCase()}`;
}

function randomHex32(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

export function newContactId(): string {
  return randomHex32();
}

export function newOperationId(): string {
  return randomHex32();
}

export function newDeviceId(): string {
  return randomHex32();
}

/** Keep a well-formed stored device id; mint a fresh one for anything else. */
export function ensureContactsDeviceId(existing: string | undefined): string {
  return typeof existing === 'string' && HEX32_RE.test(existing) ? existing : newDeviceId();
}

/**
 * Gate for initial device-ID allocation: wait for loaded preferences and an
 * unlocked session. The database allocator patches the ID transactionally,
 * preserving concurrent settings changes and an already allocated valid ID.
 */
export function shouldMintContactsDeviceId(state: {
  prefsLoading: boolean;
  encryptionKey: string | null;
  contactsDeviceId: string | undefined;
}): boolean {
  return !state.prefsLoading && !!state.encryptionKey && !state.contactsDeviceId;
}

function hash32(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input))).slice(0, 32);
}

export function importContactId(directoryId: string, pubkey: string): string {
  return hash32(`signet:contacts:v2:contact:${directoryId}:${pubkey}`);
}

export function importOperationId(
  directoryId: string,
  cls: LegacyRecordClass,
  pubkey: string,
  fieldGroup: string,
): string {
  return hash32(`signet:contacts:v2:import:${directoryId}:${cls}:${pubkey}:${fieldGroup}`);
}

/** Marker key written to `contactImportSources` once a legacy row has been imported. */
export function importSourceKey(cls: LegacyRecordClass, pubkey: string): string {
  return `${cls}:${pubkey}`;
}
