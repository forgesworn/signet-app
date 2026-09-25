import { describe, it, expect, beforeEach } from 'vitest';
import { createSyncDecryptCache, forgetSyncCacheKeys, readSyncPlaintext } from './sync-decrypt-cache';
import { getSyncCacheEntry, putSyncCacheEntry } from './db';
import { deriveAesKey, aesEncrypt, SALT_LENGTH } from './aes-crypto';

const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));

const KEY = 'a'.repeat(64);
const AUTHOR = 'b'.repeat(64);

describe('sync decrypt cache', () => {
  beforeEach(() => { forgetSyncCacheKeys(); });

  it('round-trips plaintext by event id, encrypted at rest', async () => {
    const c = createSyncDecryptCache({ dTag: 'signet:contacts', authorPubkey: AUTHOR, encryptionKey: KEY });
    await c.put('ev1', 100, '{"v":1}');
    expect(await c.get('ev1')).toBe('{"v":1}');
    const row = await getSyncCacheEntry(`signet:contacts:${AUTHOR}`);
    expect(row?.eventId).toBe('ev1');
    expect(row?.createdAt).toBe(100);
    expect(row?.ciphertext).not.toContain('{"v":1}');
  });

  it('misses on a different event id and after a key change', async () => {
    const c = createSyncDecryptCache({ dTag: 'signet:kens', authorPubkey: AUTHOR, encryptionKey: KEY });
    await c.put('ev1', 100, 'x');
    expect(await c.get('ev2')).toBeNull();
    const other = createSyncDecryptCache({ dTag: 'signet:kens', authorPubkey: AUTHOR, encryptionKey: 'c'.repeat(64) });
    expect(await other.get('ev1')).toBeNull(); // wrong key → decrypt fails → miss, no throw
  });

  it('is scoped per dTag and author', async () => {
    const a = createSyncDecryptCache({ dTag: 'signet:grants', authorPubkey: AUTHOR, encryptionKey: KEY });
    const b = createSyncDecryptCache({ dTag: 'signet:grants', authorPubkey: 'd'.repeat(64), encryptionKey: KEY });
    await a.put('ev1', 1, 'A');
    expect(await b.get('ev1')).toBeNull();
  });

  it('round-trips a large payload (chunked base64, no call-stack blow-up)', async () => {
    const c = createSyncDecryptCache({ dTag: 'signet:credentials', authorPubkey: 'f'.repeat(64), encryptionKey: KEY });
    // ~600 kB — a credentials rail carrying merkleLeaves gets this big.
    const big = JSON.stringify({ v: 1, blob: 'x'.repeat(600_000) });
    await c.put('evBig', 7, big);
    expect(await c.get('evBig')).toBe(big);
  });

  it('misses when a row is relabelled with a different event id (ciphertext is bound to it)', async () => {
    const c = createSyncDecryptCache({ dTag: 'signet:contacts', authorPubkey: 'aa'.repeat(32), encryptionKey: KEY });
    await c.put('evReal', 100, 'SECRET');
    const row = await getSyncCacheEntry(`signet:contacts:${'aa'.repeat(32)}`);
    expect(row).toBeTruthy();
    // Same iv/ciphertext, cleartext eventId swapped — the row now claims to be
    // the decryption of a DIFFERENT relay event.
    await putSyncCacheEntry({ ...row!, eventId: 'evForged' });
    expect(await c.get('evForged')).toBeNull();
    expect(await c.get('evReal')).toBeNull(); // row no longer advertises evReal either
  });

  it('misses when a row is copied into another rail\'s slot', async () => {
    const src = createSyncDecryptCache({ dTag: 'signet:contacts', authorPubkey: 'ab'.repeat(32), encryptionKey: KEY });
    await src.put('evShared', 100, 'CONTACTS-PLAINTEXT');
    const row = await getSyncCacheEntry(`signet:contacts:${'ab'.repeat(32)}`);
    // Lift the ciphertext verbatim into the credentials rail's row id. Same
    // unlock key decrypts it, but the envelope's id no longer matches.
    const stolenId = `signet:credentials:${'ab'.repeat(32)}`;
    await putSyncCacheEntry({ ...row!, id: stolenId });
    const victim = createSyncDecryptCache({ dTag: 'signet:credentials', authorPubkey: 'ab'.repeat(32), encryptionKey: KEY });
    expect(await victim.get('evShared')).toBeNull();
  });

  it('treats an old-format (bare payload) row as a miss', async () => {
    // Rows written by the pre-envelope implementation hold the raw payload
    // with no id/eventId binding. Best-effort: they fail the envelope parse
    // and read as a miss (one device round-trip re-writes them).
    const dTag = 'signet:kens';
    const author = 'ac'.repeat(32);
    const id = `${dTag}:${author}`;
    const salt = new TextEncoder().encode('signet-sync-cache-v1').slice(0, SALT_LENGTH);
    const aesKey = await deriveAesKey(KEY, salt);
    const { iv, ciphertext } = await aesEncrypt('{"v":1}', aesKey);
    await putSyncCacheEntry({ id, eventId: 'evOld', createdAt: 1, iv: b64(iv), ciphertext: b64(ciphertext), updatedAt: Date.now() });
    const c = createSyncDecryptCache({ dTag, authorPubkey: author, encryptionKey: KEY });
    expect(await c.get('evOld')).toBeNull();
  });

  it('normalises the author pubkey case in the row id', async () => {
    const upper = createSyncDecryptCache({ dTag: 'signet:credentials', authorPubkey: AUTHOR.toUpperCase(), encryptionKey: KEY });
    await upper.put('ev9', 5, 'shared');
    const lower = createSyncDecryptCache({ dTag: 'signet:credentials', authorPubkey: AUTHOR, encryptionKey: KEY });
    expect(await lower.get('ev9')).toBe('shared');
  });
});

describe('readSyncPlaintext', () => {
  beforeEach(() => { forgetSyncCacheKeys(); });

  it('decrypts on a miss, then serves the cache without decrypting again', async () => {
    const cache = createSyncDecryptCache({ dTag: 'signet:dependants', authorPubkey: AUTHOR, encryptionKey: KEY });
    let calls = 0;
    const decrypt = async () => { calls++; return 'PLAIN'; };
    const event = { id: 'ev1', created_at: 42 };
    expect(await readSyncPlaintext(cache, event, decrypt)).toBe('PLAIN');
    expect(await readSyncPlaintext(cache, event, decrypt)).toBe('PLAIN');
    expect(calls).toBe(1);
  });

  it('decrypts again when the event id changes', async () => {
    const cache = createSyncDecryptCache({ dTag: 'signet:dependants', authorPubkey: 'e'.repeat(64), encryptionKey: KEY });
    let calls = 0;
    const decrypt = async () => { calls++; return `p${calls}`; };
    expect(await readSyncPlaintext(cache, { id: 'a1', created_at: 1 }, decrypt)).toBe('p1');
    expect(await readSyncPlaintext(cache, { id: 'a2', created_at: 2 }, decrypt)).toBe('p2');
    expect(calls).toBe(2);
  });

  it('falls through to decrypt when no cache is supplied', async () => {
    let calls = 0;
    const plaintext = await readSyncPlaintext(undefined, { id: 'x', created_at: 1 }, async () => { calls++; return 'nocache'; });
    expect(plaintext).toBe('nocache');
    expect(calls).toBe(1);
  });
});
