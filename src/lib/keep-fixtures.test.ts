import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { unwrapEvent } from 'nostr-tools/nip59';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import { LocalSigningBackend } from './signing-backend';
import { unwrapKeepAck } from './keep-messages';
import { FIXTURE } from './keep-fixture-values';

/*
 * Cross-check fixtures (K1d contract, last section). `fixtures/keep-m-*.json`
 * were made by this app's own code (see keep-fixture-values.ts) and are opened
 * here the way the Keep opens them: with the Keep's key and nostr-tools' NIP-59
 * reader, checking every field of the contract.
 */
const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as NostrEvent;
const keepSk = hexToBytes(FIXTURE.keepSk);
const K = getPublicKey(keepSk);
const O = getPublicKey(hexToBytes(FIXTURE.ownerSk));
const friend = getPublicKey(hexToBytes(FIXTURE.friendSk));

describe('M fixtures, opened as the Keep', () => {
  it('claim wrap', () => {
    const wrap = read('keep-m-claim.json');
    expect(wrap.kind).toBe(1059);
    expect(wrap.tags).toEqual([['p', K]]);
    expect(verifyEvent(wrap as never)).toBe(true);
    expect(wrap.pubkey).not.toBe(O);
    const rumor = unwrapEvent(wrap as never, keepSk);
    expect(rumor.kind).toBe(27660);
    expect(rumor.pubkey).toBe(O);
    expect(rumor.content).toBe('');
    expect(rumor.created_at).toBe(FIXTURE.createdAt);
    expect(rumor.tags).toEqual([['keep', K], ['code', FIXTURE.code]]);
  });

  it('invite wrap', () => {
    const wrap = read('keep-m-invite.json');
    expect(wrap.kind).toBe(1059);
    expect(wrap.tags).toEqual([['p', K]]);
    expect(verifyEvent(wrap as never)).toBe(true);
    const rumor = unwrapEvent(wrap as never, keepSk);
    expect(rumor.kind).toBe(27661);
    expect(rumor.pubkey).toBe(O);
    expect(rumor.content).toBe('');
    expect(rumor.created_at).toBe(FIXTURE.createdAt);
    expect(rumor.tags).toEqual([
      ['keep', K], ['grant', FIXTURE.grant], ['secret', FIXTURE.secret],
      ['expiration', String(FIXTURE.createdAt + 30 * 86400)], ['p', friend], ['name', FIXTURE.label],
    ]);
  });
});

/** The Keep's own ack fixture (made by the Keep's code, copied here as given). */
const ACK_PATH = new URL('./fixtures/k-ack-active.json', import.meta.url);
describe('K ack fixture, opened as the owner', () => {
  it('unwraps as an active ack for a grant', async () => {
    const wrap = JSON.parse(readFileSync(ACK_PATH, 'utf8')) as NostrEvent;
    const ack = await unwrapKeepAck(wrap, new LocalSigningBackend(FIXTURE.ownerSk), new Set([K]));
    expect(wrap.kind).toBe(1059);
    expect(wrap.tags).toEqual([['p', O]]);
    expect(ack).toMatchObject({ keep: K, status: 'active', claim: false });
    expect(ack?.grant).toMatch(/^[0-9a-f]{32}$/);
  });
});
