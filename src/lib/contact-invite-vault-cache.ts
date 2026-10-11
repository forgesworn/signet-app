import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * The last parsed contact-invite vault per record, reused only while the
 * stored ciphertext is byte-for-byte the one it came from. A read used to
 * decrypt and re-validate the whole vault (every invite, exchange transcript
 * and outbox signature), about a quarter of a second on a phone, and one
 * handshake pass reads it ten times. AES-GCM under the same key turns the same
 * ciphertext into the same plaintext, and the validation is a pure function of
 * that plaintext, so a hit returns exactly what a fresh read would. Any write
 * (a new salt and IV) is a miss. Bound to a digest of the key; held for one
 * unlock: cleared on lock and on purge. Its own module so db.ts can clear it
 * without importing the store.
 */
interface Entry { keyId: string; encrypted: string; value: unknown }
const MAX_ENTRIES = 8;
let entries = new Map<string, Entry>();
/** Bumped by every forget, so a decrypt still running at lock cannot refill it. */
let generation = 0;
/** Digests of exchange records that passed, per check function: a pass under
 * one check never stands in for another. */
let validExchanges = new WeakMap<object, Set<string>>();
const MAX_VALID_EXCHANGES = 2048;

export function contactInviteVaultCacheGeneration(): number { return generation; }
export function forgetContactInviteVaultCache(): void { entries = new Map(); validExchanges = new WeakMap(); generation++; }

/** Only a digest of the key is held, never the key itself. */
function keyId(key: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`signet:contact-invite-cache:${key}`)));
}

/** A copy of the value parsed from exactly this ciphertext under this key, if held. */
export function cachedContactInviteVault<T>(record: string, key: string, encrypted: string): T | undefined {
  const hit = entries.get(record);
  return hit && hit.encrypted === encrypted && hit.keyId === keyId(key) ? structuredClone(hit.value) as T : undefined;
}

/** Remember `value` as what `encrypted` holds. `since`: the generation read
 * before the work began; a forget in between drops it. */
export function rememberContactInviteVault(record: string, key: string, encrypted: string, value: unknown, since: number): void {
  if (since !== generation) return;
  entries.delete(record);
  entries.set(record, { keyId: keyId(key), encrypted, value: structuredClone(value) });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}

/**
 * Checking a stored exchange recomputes its transcript hashes and words, and
 * every write re-checks every exchange in the vault, nearly all unchanged. The
 * check is a pure function of the record's JSON (the vault is JSON-parsed
 * data), so a record whose SHA-256 matches one that passed passes again. Only
 * passes are remembered, by digest, never the record itself.
 */
export function checkedContactExchange<T>(record: T, check: (record: T) => boolean): boolean {
  const digest = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(record))));
  let passed = validExchanges.get(check);
  if (passed?.has(digest)) return true;
  if (!check(record)) return false;
  if (!passed || passed.size >= MAX_VALID_EXCHANGES) validExchanges.set(check, passed = new Set());
  passed.add(digest);
  return true;
}
