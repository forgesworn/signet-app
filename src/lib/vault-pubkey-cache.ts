/**
 * Persisted Heartwood vault pubkeys, across unlocks.
 *
 * `BunkerSigningBackend.vaultBackend` resolves each vault key with
 * `get_public_key` + a `signet:vault:*` context. The device answers that with
 * an `NPUB AS <label>?` card it NEVER remembers, and the in-memory cache only
 * lives for one connection generation — so every unlock put one card per
 * dataset back up. The vault pubkey for (master, purpose, index) is
 * deterministic, so once resolved it is kept here, encrypted at rest under the
 * unlock key (one `identity`-store row, see db.ts `saveHeartwoodVaultPubkeys`).
 *
 * The row is pinned to one master pubkey: a lookup under a different master
 * misses, and the first write under it replaces the whole row. A caller that
 * sees a signed event come back under a different pubkey than the cached one
 * calls `drop()` and resolves again.
 */
import { deleteHeartwoodVaultPubkeys, loadHeartwoodVaultPubkeys, saveHeartwoodVaultPubkeys } from './db';
import type { HeartwoodVaultPubkeys } from './db';

export interface VaultPubkeyStore {
  get(masterPubkey: string, key: string): Promise<string | null>;
  put(masterPubkey: string, key: string, pubkey: string): Promise<void>;
  drop(masterPubkey: string, key: string): Promise<void>;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * One store per unlock. The row is decrypted once (lazily) and held in memory;
 * writes are serialised so two datasets resolving in the same burst cannot
 * overwrite each other's entry. Failures degrade to a miss — never a throw —
 * since the device query is always a correct fallback.
 */
export function createVaultPubkeyStore(encryptionKey: string): VaultPubkeyStore {
  let loaded: Promise<HeartwoodVaultPubkeys | null> | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const load = () => (loaded ??= loadHeartwoodVaultPubkeys(encryptionKey).catch(() => null));
  const write = (mutate: (row: HeartwoodVaultPubkeys | null) => HeartwoodVaultPubkeys | null | undefined): Promise<void> => {
    const run = tail.then(async () => {
      const current = await load();
      const next = mutate(current);
      if (next === undefined) return;
      loaded = Promise.resolve(next);
      if (next) await saveHeartwoodVaultPubkeys(next, encryptionKey);
      else await deleteHeartwoodVaultPubkeys();
    }).catch(() => { /* a failed write is a later miss, not an error */ });
    tail = run;
    return run;
  };
  return {
    async get(masterPubkey, key) {
      await tail;
      const row = await load();
      if (!row || row.masterPubkey !== masterPubkey) return null;
      const pubkey = row.entries[key];
      return pubkey && HEX64.test(pubkey) ? pubkey : null;
    },
    put(masterPubkey, key, pubkey) {
      if (!HEX64.test(masterPubkey) || !HEX64.test(pubkey)) return Promise.resolve();
      return write(row => {
        // A different master replaces the row outright: nothing resolved
        // under another device's root may survive into this one's lookups.
        const entries = row && row.masterPubkey === masterPubkey ? row.entries : {};
        if (entries[key] === pubkey) return undefined;
        return { masterPubkey, entries: { ...entries, [key]: pubkey } };
      });
    },
    drop(masterPubkey, key) {
      return write(row => {
        if (!row || row.masterPubkey !== masterPubkey || !(key in row.entries)) return undefined;
        const entries = { ...row.entries };
        delete entries[key];
        return { masterPubkey, entries };
      });
    },
  };
}
