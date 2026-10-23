import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { unwrapEvent } from 'nostr-tools/nip59';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import { LocalSigningBackend } from './signing-backend';
import { unwrapKeepAck, unwrapKeepMessage } from './keep-messages';
import { FIXTURE } from './keep-fixture-values';
import { applyOwnersAck, composeUpdate, linkPersona } from './keep-owners';
import { applyPassReport, newPendingKeep } from './keep-store';

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
const B = getPublicKey(hexToBytes(FIXTURE.secondOwnerSk));
const player = getPublicKey(hexToBytes(FIXTURE.playerSk));

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

describe('K1e M fixtures, opened as the Keep', () => {
  it('owners update wrap: rev 1, both owner personas, games', () => {
    const wrap = read('keep-m-update.json');
    expect(wrap.kind).toBe(1059);
    expect(wrap.tags).toEqual([['p', K]]);
    expect(verifyEvent(wrap as never)).toBe(true);
    const rumor = unwrapEvent(wrap as never, keepSk);
    expect(rumor.kind).toBe(27664);
    expect(rumor.pubkey).toBe(O);
    expect(rumor.content).toBe('');
    expect(rumor.created_at).toBe(FIXTURE.createdAt);
    expect(rumor.tags).toEqual([['keep', K], ['rev', '1'], ['persona', O, 'games'], ['persona', B, 'games']]);
  });

  it('owner accept wrap: rev 1, signed by the second owner persona', () => {
    const wrap = read('keep-m-accept.json');
    expect(wrap.kind).toBe(1059);
    expect(wrap.tags).toEqual([['p', K]]);
    expect(verifyEvent(wrap as never)).toBe(true);
    const rumor = unwrapEvent(wrap as never, keepSk);
    expect(rumor.kind).toBe(27665);
    expect(rumor.pubkey).toBe(B);
    expect(rumor.content).toBe('');
    expect(rumor.created_at).toBe(FIXTURE.createdAt);
    expect(rumor.tags).toEqual([['keep', K], ['rev', '1']]);
  });
});

/** The Keep's own `updated` ack (made by the Keep's code, copied here as given). */
describe('K updated fixture, opened as the owner', () => {
  it('unwraps as an updated ack with a revision, addressed to the owner persona', async () => {
    const wrap = JSON.parse(readFileSync(new URL('./fixtures/k-updated.json', import.meta.url), 'utf8')) as NostrEvent;
    const ack = await unwrapKeepAck(wrap, new LocalSigningBackend(FIXTURE.ownerSk), new Set([K]));
    expect(wrap.kind).toBe(1059);
    expect(wrap.tags).toEqual([['p', O]]);
    expect(ack).toMatchObject({ keep: K, status: 'updated', claim: false, owners: true, to: O });
    expect(Number.isSafeInteger(ack?.rev)).toBe(true);
    expect(ack?.rev).toBeGreaterThanOrEqual(1);
  });

  it('is applied to a pending update at that revision: the update is in', async () => {
    const wrap = JSON.parse(readFileSync(new URL('./fixtures/k-updated.json', import.meta.url), 'utf8')) as NostrEvent;
    const ack = (await unwrapKeepAck(wrap, new LocalSigningBackend(FIXTURE.ownerSk), new Set([K])))!;
    const keep = composeUpdate({ ...linkPersona(newPaired(), B)!, rev: ack.rev! - 1 }, O, ack.at);
    expect(keep.update!.rev).toBe(ack.rev);
    const [next] = applyOwnersAck([keep], ack, ack.at);
    expect(next.update).toBeUndefined();
    expect(next.rev).toBe(ack.rev);
  });
});

function newPaired() {
  const { code: _c, ...rest } = newPendingKeep({ keep: K, name: 'Home', relays: ['wss://a.example'], claimedBy: O, code: '33'.repeat(16), now: 1, scope: 'all' });
  return { ...rest, status: 'paired' as const };
}

describe('K1f M fixtures, opened as the Keep', () => {
  it('settings wrap: setrev 1, return passes off', () => {
    const wrap = read('keep-m-settings.json');
    expect(wrap.kind).toBe(1059);
    expect(wrap.tags).toEqual([['p', K]]);
    expect(verifyEvent(wrap as never)).toBe(true);
    expect(wrap.pubkey).not.toBe(O);
    const rumor = unwrapEvent(wrap as never, keepSk);
    expect(rumor.kind).toBe(27666);
    expect(rumor.pubkey).toBe(O);
    expect(rumor.content).toBe('');
    expect(rumor.created_at).toBe(FIXTURE.createdAt);
    expect(rumor.tags).toEqual([['keep', K], ['setrev', '1'], ['return_passes', 'off']]);
  });

  it('passes request wrap: only the keep tag', () => {
    const wrap = read('keep-m-passes-request.json');
    expect(wrap.kind).toBe(1059);
    expect(wrap.tags).toEqual([['p', K]]);
    expect(verifyEvent(wrap as never)).toBe(true);
    const rumor = unwrapEvent(wrap as never, keepSk);
    expect(rumor.kind).toBe(27668);
    expect(rumor.pubkey).toBe(O);
    expect(rumor.content).toBe('');
    expect(rumor.created_at).toBe(FIXTURE.createdAt);
    expect(rumor.tags).toEqual([['keep', K]]);
  });
});

/**
 * A pass report built here from the contract's text (the Keep's own fixture will replace it, as `k-pass-report.json`).
 * Opened the way My Signet opens a report from the Keep.
 */
describe('a pass report built per the K1f contract, opened as the owner', () => {
  const wrap = () => read('keep-m-pass-report-sample.json');

  it('is a gift wrap to the owner persona with the contract tags and no secret', () => {
    expect(wrap().kind).toBe(1059);
    expect(wrap().tags).toEqual([['p', O]]);
    expect(verifyEvent(wrap() as never)).toBe(true);
    const rumor = unwrapEvent(wrap() as never, hexToBytes(FIXTURE.ownerSk));
    expect(rumor.kind).toBe(27667);
    expect(rumor.pubkey).toBe(K);
    expect(rumor.content).toBe('');
    expect(rumor.tags).toEqual([
      ['keep', K], ['grant', FIXTURE.passGrant], ['p', player], ['state', 'active'],
      ['expiration', String(FIXTURE.createdAt + 30 * 86400)], ['seen', String(FIXTURE.createdAt)], ['via', 'code'], ['name', FIXTURE.seatName],
    ]);
    expect(JSON.stringify(rumor)).not.toMatch(/secret/);
  });

  it('unwraps with every field, for the owner persona only', async () => {
    const message = await unwrapKeepMessage(wrap(), new LocalSigningBackend(FIXTURE.ownerSk), new Set([K]));
    expect(message).toEqual({
      kind: 'report',
      report: {
        keep: K, grant: FIXTURE.passGrant, persona: player, state: 'active', expiration: FIXTURE.createdAt + 30 * 86400,
        seen: FIXTURE.createdAt, via: 'code', name: FIXTURE.seatName, at: FIXTURE.createdAt,
      },
    });
    expect(await unwrapKeepMessage(wrap(), new LocalSigningBackend(FIXTURE.ownerSk), new Set([player]))).toBeNull(); // not from a Keep we hold
    expect(await unwrapKeepMessage(wrap(), new LocalSigningBackend(FIXTURE.friendSk), new Set([K]))).toBeNull(); // not addressed to this persona
  });

  it('is stored as a returning player', async () => {
    const message = await unwrapKeepMessage(wrap(), new LocalSigningBackend(FIXTURE.ownerSk), new Set([K]));
    if (message?.kind !== 'report') throw new Error('not a report');
    const [keep] = applyPassReport([newPaired()], message.report, FIXTURE.createdAt);
    expect(keep.passes).toEqual([{
      grant: FIXTURE.passGrant, persona: player, name: FIXTURE.seatName, state: 'active', expiration: FIXTURE.createdAt + 30 * 86400,
      seenAt: FIXTURE.createdAt, via: 'code', reportAt: FIXTURE.createdAt,
    }]);
  });
});
