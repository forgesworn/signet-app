import { describe, expect, it } from 'vitest';
import { finalizeEvent, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import { LocalSigningBackend } from './signing-backend';
import {
  parseAckRumor, parsePassReportRumor, passesRequestRumor, settingsRumor, unwrapKeepAck, unwrapKeepMessage, wrapForKeep, type KeepAck, type KeepPassReport,
} from './keep-messages';
import {
  applyAck, applyPassReport, applySettingsAck, composeSettings, lastReportAt, newPendingKeep, passRevokesDue, passStatusLabel, passesRequestDue,
  restartedSettings, returnPassesLabel, returnPassesOn, returningPlayers, settingsDue, markPassRevokeSent, parseStoredKeeps, repairKeep,
  type StoredKeep, type StoredPass,
} from './keep-store';
import { KEEP_MAX_PASSES } from './keep-wire';

const KEEP_SK_HEX = '0'.repeat(63) + '1';
const OWNER_SK_HEX = '0'.repeat(63) + '2';
const keepSk = hexToBytes(KEEP_SK_HEX);
const K = getPublicKey(keepSk);
const O = getPublicKey(hexToBytes(OWNER_SK_HEX));
const P = getPublicKey(hexToBytes('0'.repeat(63) + '4'));
const owner = new LocalSigningBackend(OWNER_SK_HEX);
const NOW = 1_800_000_000;
const DAY = 86400;
const G1 = '0a'.repeat(16);
const G2 = '0b'.repeat(16);
const keeps = new Set([K]);

const reportTags = (over: Record<string, string | null> = {}, extra: string[][] = []): string[][] => {
  const base: Record<string, string> = {
    keep: K, grant: G1, p: P, state: 'active', expiration: String(NOW + 30 * DAY), seen: String(NOW), via: 'code', name: 'Dave',
  };
  return [...Object.entries({ ...base, ...over }).filter(([, v]) => v !== null).map(([k, v]) => [k, v as string]), ...extra];
};
const rumorOf = (tags: string[][], at = NOW, kind = 27667, content = '') => ({ kind, tags, created_at: at, content });

describe('settings and passes request (what the Keep receives)', () => {
  it('a settings message carries keep, setrev and return_passes, in that order', async () => {
    const wrap = await wrapForKeep(settingsRumor(owner, K, 7, false, NOW), K, owner);
    expect(wrap.kind).toBe(1059);
    expect(wrap.tags).toEqual([['p', K]]);
    expect(verifyEvent(wrap as never)).toBe(true);
    const rumor = unwrapEvent(wrap as never, keepSk);
    expect(rumor).toMatchObject({ kind: 27666, pubkey: O, content: '', created_at: NOW });
    expect(rumor.tags).toEqual([['keep', K], ['setrev', '7'], ['return_passes', 'off']]);
    expect(settingsRumor(owner, K, 8, true, NOW).tags).toEqual([['keep', K], ['setrev', '8'], ['return_passes', 'on']]);
  });

  it('a passes request carries only the keep tag', async () => {
    const rumor = unwrapEvent((await wrapForKeep(passesRequestRumor(owner, K, NOW), K, owner)) as never, keepSk);
    expect(rumor).toMatchObject({ kind: 27668, pubkey: O, content: '', created_at: NOW });
    expect(rumor.tags).toEqual([['keep', K]]);
  });

  it('refuses a revision of 0 or past 2^53, and a bad Keep key', () => {
    expect(() => settingsRumor(owner, K, 0, true, NOW)).toThrow();
    expect(() => settingsRumor(owner, K, 2 ** 53 + 2, true, NOW)).toThrow();
    expect(() => settingsRumor(owner, K, 1.5, true, NOW)).toThrow();
    expect(() => settingsRumor(owner, 'xx', 1, true, NOW)).toThrow();
    expect(() => passesRequestRumor(owner, 'xx', NOW)).toThrow();
  });
});

describe('parsing a pass report (27667)', () => {
  it('reads every field', () => {
    expect(parsePassReportRumor(rumorOf(reportTags()), K)).toEqual({
      keep: K, grant: G1, persona: P, state: 'active', expiration: NOW + 30 * DAY, seen: NOW, via: 'code', name: 'Dave', at: NOW,
    });
  });

  it('via and name are optional; lan is a way in; an unknown way in is left out', () => {
    expect(parsePassReportRumor(rumorOf(reportTags({ via: null, name: null })), K)).toEqual({
      keep: K, grant: G1, persona: P, state: 'active', expiration: NOW + 30 * DAY, seen: NOW, at: NOW,
    });
    expect(parsePassReportRumor(rumorOf(reportTags({ via: 'lan' })), K)?.via).toBe('lan');
    expect(parsePassReportRumor(rumorOf(reportTags({ via: 'carrier-pigeon' })), K)).not.toHaveProperty('via');
  });

  it.each([
    ['an expiration past 2^53', { expiration: '9999999999999999' }],
    ['a seen time past 2^53', { seen: '9999999999999999' }],
    ['an expiration of 2^53', { expiration: '9007199254740992' }],
    ['an expiration of 17 digits', { expiration: '10000000000000000' }],
    ['a negative seen time', { seen: '-1' }],
    ['a fractional expiration', { expiration: '1.5' }],
    ['an exponent', { seen: '1e3' }],
  ])('refuses a report with %s', (_label, over) => {
    expect(parsePassReportRumor(rumorOf(reportTags(over)), K)).toBeNull();
  });

  it('accepts the largest safe expiration and seen time', () => {
    const max = String(Number.MAX_SAFE_INTEGER);
    expect(parsePassReportRumor(rumorOf(reportTags({ expiration: max, seen: max })), K))
      .toMatchObject({ expiration: Number.MAX_SAFE_INTEGER, seen: Number.MAX_SAFE_INTEGER });
  });

  it.each(['active', 'revoked', 'expired'])('accepts state %s', state => {
    expect(parsePassReportRumor(rumorOf(reportTags({ state })), K)?.state).toBe(state);
  });

  it('cleans the name like an invite label: no control or bidi characters, at most 40, dropped when empty', () => {
    const name = parsePassReportRumor(rumorOf(reportTags({ name: '  Da‮ve\u0007  ' })), K)?.name;
    expect(name).toBe('Dave');
    expect(parsePassReportRumor(rumorOf(reportTags({ name: 'x'.repeat(60) })), K)?.name).toBe('x'.repeat(40));
    expect(parsePassReportRumor(rumorOf(reportTags({ name: ' ​ ' })), K)).not.toHaveProperty('name');
  });

  it('drops the whole report when it carries a secret tag, whatever its value or case', () => {
    expect(parsePassReportRumor(rumorOf(reportTags({}, [['secret', '22'.repeat(32)]])), K)).toBeNull();
    expect(parsePassReportRumor(rumorOf(reportTags({}, [['Secret', 'x']])), K)).toBeNull();
    expect(parsePassReportRumor(rumorOf(reportTags({}, [['secret']])), K)).toBeNull();
  });

  it('refuses a rumor of another kind, another Keep, or with content', () => {
    expect(parsePassReportRumor(rumorOf(reportTags(), NOW, 27663), K)).toBeNull();
    expect(parsePassReportRumor(rumorOf(reportTags({ keep: 'ab'.repeat(32) })), K)).toBeNull();
    expect(parsePassReportRumor(rumorOf(reportTags(), NOW, 27667, 'hello'), K)).toBeNull();
    expect(parsePassReportRumor(rumorOf(reportTags({ keep: null })), K)).toBeNull();
  });

  it.each([
    ['no grant', { grant: null }],
    ['a short grant', { grant: 'ab' }],
    ['an upper-case grant', { grant: 'AB'.repeat(16) }],
    ['no p', { p: null }],
    ['a short p', { p: 'ab' }],
    ['an unknown state', { state: 'frozen' }],
    ['no state', { state: null }],
    ['no expiration', { expiration: null }],
    ['a non-decimal expiration', { expiration: '12x' }],
    ['a negative expiration', { expiration: '-5' }],
    ['no seen', { seen: null }],
    ['a fractional seen', { seen: '1.5' }],
  ])('refuses a report with %s', (_label, over) => {
    expect(parsePassReportRumor(rumorOf(reportTags(over)), K)).toBeNull();
  });

  it('refuses a repeated tag (two states, two grants, two names), junk tags, and a very long tag list', () => {
    expect(parsePassReportRumor(rumorOf(reportTags({}, [['state', 'revoked']])), K)).toBeNull();
    expect(parsePassReportRumor(rumorOf(reportTags({}, [['grant', G2]])), K)).toBeNull();
    expect(parsePassReportRumor(rumorOf(reportTags({}, [['name', 'Eve']])), K)).toBeNull();
    expect(parsePassReportRumor(rumorOf([...reportTags(), [] as unknown as string[]]), K)).toBeNull();
    expect(parsePassReportRumor(rumorOf([...reportTags(), ...Array.from({ length: 20 }, (_, i) => ['x', String(i)])]), K)).toBeNull();
  });

  it('ignores tags it does not know, within the limit', () => {
    expect(parsePassReportRumor(rumorOf(reportTags({}, [['future', 'thing']])), K)).not.toBeNull();
  });
});

/** A report as the Keep sends it: a NIP-59 wrap of the rumor, seal signed by `signer`. */
function reportWrap(tags: string[][], o: { signer?: Uint8Array; to?: string; at?: number } = {}) {
  return wrapEvent({ kind: 27667, content: '', created_at: o.at ?? NOW, tags }, o.signer ?? keepSk, o.to ?? O) as unknown as NostrEvent;
}

describe('opening a pass report wrap', () => {
  it('unwraps to a report, and unwrapKeepAck does not take it for an ack', async () => {
    const wrap = reportWrap(reportTags());
    const message = await unwrapKeepMessage(wrap, owner, keeps);
    expect(message).toEqual({ kind: 'report', report: expect.objectContaining({ keep: K, grant: G1, persona: P, state: 'active' }) });
    expect(await unwrapKeepAck(wrap, owner, keeps)).toBeNull();
  });

  it('drops a seal signed by anyone but a known Keep, a keep tag naming another Keep, and a wrap for another persona', async () => {
    const other = hexToBytes('0'.repeat(63) + '9');
    expect(await unwrapKeepMessage(reportWrap(reportTags(), { signer: other }), owner, keeps)).toBeNull();
    expect(await unwrapKeepMessage(reportWrap(reportTags({ keep: 'ab'.repeat(32) })), owner, keeps)).toBeNull();
    expect(await unwrapKeepMessage(reportWrap(reportTags(), { to: P }), owner, keeps)).toBeNull();
  });

  it('drops a report whose rumor author is not the seal signer', async () => {
    const rumor = { kind: 27667, content: '', created_at: NOW, tags: reportTags(), pubkey: O };
    const sealed = await new LocalSigningBackend(KEEP_SK_HEX).nip44Encrypt(O, JSON.stringify({ ...rumor, id: getEventHash(rumor) }));
    const seal = finalizeEvent({ kind: 13, content: sealed, created_at: NOW, tags: [] }, keepSk);
    const eph = hexToBytes('0'.repeat(63) + '7');
    const inner = await new LocalSigningBackend(bytesToHex(eph)).nip44Encrypt(O, JSON.stringify(seal));
    const wrap = finalizeEvent({ kind: 1059, content: inner, created_at: NOW, tags: [['p', O]] }, eph) as unknown as NostrEvent;
    expect(await unwrapKeepMessage(wrap, owner, keeps)).toBeNull();
  });

  it('drops a report with a secret inside a valid wrap', async () => {
    expect(await unwrapKeepMessage(reportWrap(reportTags({}, [['secret', '22'.repeat(32)]])), owner, keeps)).toBeNull();
  });
});

describe('settings acks (27663)', () => {
  const ack = (tags: string[][]) => parseAckRumor({ kind: 27663, created_at: NOW, tags: [['keep', K], ...tags] }, K);

  it('updated with the setting and setrev', () => {
    expect(ack([['status', 'updated'], ['setting', 'return_passes'], ['setrev', '3']]))
      .toEqual({ keep: K, status: 'updated', claim: false, settings: true, setrev: 3, at: NOW });
  });

  it('refused stale carries the current setrev', () => {
    expect(ack([['status', 'refused'], ['reason', 'stale'], ['setrev', '5']]))
      .toEqual({ keep: K, status: 'refused', claim: false, settings: true, reason: 'stale', setrev: 5, at: NOW });
    expect(ack([['status', 'refused'], ['reason', 'stale'], ['setting', 'return_passes'], ['setrev', '5']])).toMatchObject({ settings: true, setrev: 5 });
  });

  it.each([
    ['updated for another setting', [['status', 'updated'], ['setting', 'dark_mode'], ['setrev', '3']]],
    ['updated without the setting', [['status', 'updated'], ['setrev', '3']]],
    ['updated without a setrev', [['status', 'updated'], ['setting', 'return_passes']]],
    ['a rev beside the setrev', [['status', 'updated'], ['setting', 'return_passes'], ['setrev', '3'], ['rev', '3']]],
    ['a grant beside the setrev', [['status', 'updated'], ['setting', 'return_passes'], ['setrev', '3'], ['grant', '0a'.repeat(16)]]],
    ['two setrevs', [['status', 'updated'], ['setting', 'return_passes'], ['setrev', '3'], ['setrev', '4']]],
    ['a setrev of text', [['status', 'updated'], ['setting', 'return_passes'], ['setrev', 'x']]],
    ['a setrev past 2^53', [['status', 'updated'], ['setting', 'return_passes'], ['setrev', '9999999999999999']]],
    ['a setrev of 2^53', [['status', 'refused'], ['reason', 'stale'], ['setrev', '9007199254740992']]],
    ['a negative setrev', [['status', 'updated'], ['setting', 'return_passes'], ['setrev', '-1']]],
    ['a fractional setrev', [['status', 'updated'], ['setting', 'return_passes'], ['setrev', '1.5']]],
    ['a setrev too high to add one to', [['status', 'updated'], ['setting', 'return_passes'], ['setrev', String(Number.MAX_SAFE_INTEGER)]]],
    ['refused for another reason', [['status', 'refused'], ['reason', 'full'], ['setrev', '5']]],
    ['pending', [['status', 'pending'], ['setting', 'return_passes'], ['setrev', '5']]],
  ])('refuses %s', (_label, tags) => {
    expect(ack(tags as string[][])).toBeNull();
  });

  it('an owners ack (rev) is not a settings ack, and is read as before', () => {
    expect(ack([['status', 'updated'], ['rev', '4']])).toMatchObject({ owners: true, rev: 4 });
    expect(ack([['status', 'updated'], ['rev', '4']])).not.toHaveProperty('settings');
  });

  it('is addressed (`to`) to the persona that opened it', async () => {
    const wrap = wrapEvent({ kind: 27663, content: '', created_at: NOW, tags: [['keep', K], ['status', 'updated'], ['setting', 'return_passes'], ['setrev', '2']] }, keepSk, O) as unknown as NostrEvent;
    expect(await unwrapKeepAck(wrap, owner, keeps)).toMatchObject({ settings: true, setrev: 2, to: O });
  });
});

// ---- the store -------------------------------------------------------------

const paired = (over: Partial<StoredKeep> = {}): StoredKeep => {
  const { code: _c, ...rest } = newPendingKeep({ keep: K, name: 'Home', relays: ['wss://a.example'], claimedBy: O, code: '33'.repeat(16), now: NOW - 10 * DAY });
  return { ...rest, status: 'paired', ...over };
};
const report = (over: Partial<KeepPassReport> = {}): KeepPassReport => ({
  keep: K, grant: G1, persona: P, state: 'active', expiration: NOW + 30 * DAY, seen: NOW, via: 'code', name: 'Dave', at: NOW, ...over,
});
const passOf = (list: StoredKeep[], grant = G1): StoredPass | undefined => list[0].passes?.find(p => p.grant === grant);

describe('applyPassReport', () => {
  it('a report dated far ahead is stored at now plus the skew, so a later honest report still applies', () => {
    const ahead = applyPassReport([paired()], report({ at: NOW + 10 * DAY }), NOW);
    expect(passOf(ahead)?.reportAt).toBe(NOW + 600);
    const later = applyPassReport(ahead, report({ at: NOW + 700, state: 'active', seen: NOW + 700 }), NOW + 700);
    expect(passOf(later)?.seenAt).toBe(NOW + 700);
  });

  it('a report with a number the saved list could not read back is not stored', () => {
    expect(applyPassReport([paired()], report({ expiration: 1e16 }), NOW)[0].passes ?? []).toEqual([]);
    expect(applyPassReport([paired()], report({ seen: 1e16 }), NOW)[0].passes ?? []).toEqual([]);
  });

  it('stores a new pass, without any secret', () => {
    const list = applyPassReport([paired()], report(), NOW);
    expect(passOf(list)).toEqual({
      grant: G1, persona: P, name: 'Dave', state: 'active', expiration: NOW + 30 * DAY, seenAt: NOW, via: 'code', reportAt: NOW,
    });
    expect(JSON.stringify(list)).not.toMatch(/secret/);
  });

  it('ignores a report for a Keep it does not hold', () => {
    const list = [paired()];
    expect(applyPassReport(list, report({ keep: 'cd'.repeat(32) }), NOW)).toBe(list);
  });

  it('dedupes by grant: the newest report wins, an older one is ignored, a repeat changes nothing', () => {
    let list = applyPassReport([paired()], report({ at: NOW, seen: NOW }), NOW);
    list = applyPassReport(list, report({ at: NOW + 100, seen: NOW + 100, expiration: NOW + 31 * DAY }), NOW);
    expect(list[0].passes).toHaveLength(1);
    expect(passOf(list)).toMatchObject({ seenAt: NOW + 100, expiration: NOW + 31 * DAY, reportAt: NOW + 100 });
    const same = applyPassReport(list, report({ at: NOW + 100, seen: NOW + 100, expiration: NOW + 31 * DAY }), NOW);
    expect(same).toBe(list);
    const older = applyPassReport(list, report({ at: NOW + 50, seen: NOW + 50 }), NOW);
    expect(older).toBe(list);
  });

  it('a later report without a name keeps the name already known', () => {
    let list = applyPassReport([paired()], report({ name: 'Dave' }), NOW);
    list = applyPassReport(list, report({ name: undefined, at: NOW + 5 }), NOW);
    expect(passOf(list)?.name).toBe('Dave');
  });

  it('keeps separate passes for separate grants (and one persona may hold two)', () => {
    let list = applyPassReport([paired()], report(), NOW);
    list = applyPassReport(list, report({ grant: G2 }), NOW);
    expect(list[0].passes?.map(p => p.grant)).toEqual([G1, G2]);
  });

  it('does not take a report that moves a grant to another persona', () => {
    const list = applyPassReport([paired()], report(), NOW);
    expect(applyPassReport(list, report({ persona: O, at: NOW + 9 }), NOW)).toBe(list);
  });

  it('revoked is final: a later active report does not undo it', () => {
    let list = applyPassReport([paired()], report(), NOW);
    list = applyPassReport(list, report({ state: 'revoked', at: NOW + 10 }), NOW);
    expect(passOf(list)?.state).toBe('revoked');
    const after = applyPassReport(list, report({ state: 'active', at: NOW + 20, seen: NOW + 20 }), NOW);
    expect(after).toBe(list);
    expect(applyPassReport(list, report({ state: 'expired', at: NOW + 30 }), NOW)).toBe(list);
  });

  it('revoked is final the other way round too: a revoked report dated before the active one still ends the pass', () => {
    let list = applyPassReport([paired()], report({ state: 'active', at: NOW + 20, seen: NOW + 20 }), NOW);
    list = applyPassReport(list, report({ state: 'revoked', at: NOW + 10, seen: NOW + 10 }), NOW);
    expect(passOf(list)).toMatchObject({ state: 'revoked', seenAt: NOW + 20, reportAt: NOW + 20 });
  });

  it('a revoked report that arrives first is kept, and the older active one then ignored', () => {
    let list = applyPassReport([paired()], report({ state: 'revoked', at: NOW + 10 }), NOW);
    list = applyPassReport(list, report({ state: 'active', at: NOW }), NOW);
    expect(passOf(list)?.state).toBe('revoked');
  });

  it('a revoked report clears a revoke that was waiting for the Keep', () => {
    let list = applyPassReport([paired()], report(), NOW);
    list = [markPassRevokeSent(list[0], G1, NOW + 1)];
    expect(passOf(list)?.revokeSent).toBe(true);
    list = applyPassReport(list, report({ at: NOW + 2 }), NOW + 2);
    expect(passOf(list)).toMatchObject({ revokeSent: true, revokeSentAt: NOW + 1 }); // an active report does not end it
    list = applyPassReport(list, report({ state: 'revoked', at: NOW + 3 }), NOW + 3);
    expect(passOf(list)?.state).toBe('revoked');
    expect(passOf(list)?.revokeSent).toBeUndefined();
  });

  it('holds at most 256: expired passes go first, then revoked ones; a full table of live passes turns the new one away', () => {
    const grant = (i: number) => i.toString(16).padStart(32, '0');
    let list = [paired()];
    for (let i = 0; i < KEEP_MAX_PASSES; i++) list = applyPassReport(list, report({ grant: grant(i), at: NOW + i }), NOW);
    expect(list[0].passes).toHaveLength(KEEP_MAX_PASSES);
    // all live: the 257th is not stored
    const full = applyPassReport(list, report({ grant: grant(1000), at: NOW + 1000 }), NOW);
    expect(full).toBe(list);
    // one expired: it makes room
    list = applyPassReport(list, report({ grant: grant(5), state: 'expired', at: NOW + 2000 }), NOW);
    list = applyPassReport(list, report({ grant: grant(1000), at: NOW + 3000 }), NOW);
    expect(list[0].passes).toHaveLength(KEEP_MAX_PASSES);
    expect(passOf(list, grant(5))).toBeUndefined();
    expect(passOf(list, grant(1000))).toBeDefined();
    // one revoked: it makes room when nothing is expired
    list = applyPassReport(list, report({ grant: grant(6), state: 'revoked', at: NOW + 4000 }), NOW);
    list = applyPassReport(list, report({ grant: grant(1001), at: NOW + 5000 }), NOW);
    expect(list[0].passes).toHaveLength(KEEP_MAX_PASSES);
    expect(passOf(list, grant(6))).toBeUndefined();
    expect(passOf(list, grant(1001))).toBeDefined();
  });

  it('a pass past its expiration counts as expired for eviction even if last reported active', () => {
    const grant = (i: number) => i.toString(16).padStart(32, '0');
    let list = [paired()];
    for (let i = 0; i < KEEP_MAX_PASSES; i++) list = applyPassReport(list, report({ grant: grant(i), at: NOW + i, expiration: i === 3 ? NOW + 10 : NOW + 30 * DAY }), NOW);
    list = applyPassReport(list, report({ grant: grant(999), at: NOW + 999 }), NOW + 100);
    expect(passOf(list, grant(3))).toBeUndefined();
    expect(passOf(list, grant(999))).toBeDefined();
  });
});

describe('applyAck for a pass revoke', () => {
  const revokedAck = (grant: string): KeepAck => ({ keep: K, status: 'revoked', grant, claim: false, at: NOW + 5 });

  it('the revoked ack by the pass grant makes it revoked and ends the waiting', () => {
    let list = applyPassReport([paired()], report(), NOW);
    list = [markPassRevokeSent(list[0], G1, NOW + 1)];
    list = applyAck(list, revokedAck(G1));
    expect(passOf(list)).toMatchObject({ state: 'revoked', revokeSent: false });
  });

  it('other acks by a pass grant change nothing, and an unknown grant is still ignored', () => {
    const list = applyPassReport([paired()], report(), NOW);
    expect(applyAck(list, { ...revokedAck(G1), status: 'active' })).toBe(list);
    expect(applyAck(list, revokedAck(G2))).toBe(list);
  });
});

describe('who is listed, and the words for a pass', () => {
  it('lists active passes and revokes in progress; not revoked, expired or lapsed ones; newest seen first', () => {
    let list = [paired()];
    const add = (r: Partial<KeepPassReport>) => { list = applyPassReport(list, report(r), NOW); };
    add({ grant: '01'.repeat(16), seen: NOW - 5 * DAY });
    add({ grant: '02'.repeat(16), seen: NOW - DAY });
    add({ grant: '03'.repeat(16), state: 'revoked' });
    add({ grant: '04'.repeat(16), state: 'expired' });
    add({ grant: '05'.repeat(16), expiration: NOW - 1 });
    expect(returningPlayers(list[0], NOW).map(p => p.grant)).toEqual(['02'.repeat(16), '01'.repeat(16)]);
    list = [markPassRevokeSent(list[0], '05'.repeat(16), NOW)];
    expect(returningPlayers(list[0], NOW).map(p => p.grant)).toContain('05'.repeat(16));
  });

  it('Active, Expired, Revoking, Revoked', () => {
    const base = applyPassReport([paired()], report(), NOW)[0].passes![0];
    expect(passStatusLabel(base, NOW)).toBe('Active');
    expect(passStatusLabel(base, NOW + 31 * DAY)).toBe('Expired');
    expect(passStatusLabel({ ...base, revokeSent: true }, NOW)).toBe('Revoking, waiting for the Keep');
    expect(passStatusLabel({ ...base, state: 'revoked' }, NOW)).toBe('Revoked');
  });
});

describe('pass revokes, and when the Keep is asked for its passes', () => {
  it('a revoke with no ack is due again after 10 minutes, even for a pass that has lapsed, and not once revoked', () => {
    let k = applyPassReport([paired()], report(), NOW)[0];
    k = markPassRevokeSent(k, G1, NOW);
    expect(passRevokesDue(k, NOW + 500)).toEqual([]);
    expect(passRevokesDue(k, NOW + 601).map(p => p.grant)).toEqual([G1]);
    expect(passRevokesDue(k, NOW + 40 * DAY).map(p => p.grant)).toEqual([G1]);
    expect(passRevokesDue({ ...k, status: 'pending' }, NOW + 601)).toEqual([]);
    expect(passRevokesDue(applyAck([k], { keep: K, status: 'revoked', grant: G1, claim: false, at: NOW + 1 })[0], NOW + 700)).toEqual([]);
  });

  it('opening asks unless a request went out in the last 10 minutes; a pending Keep is never asked', () => {
    const k = paired();
    expect(passesRequestDue(k, NOW, true)).toBe(true);
    expect(passesRequestDue({ ...k, passesRequestedAt: NOW - 300 }, NOW, true)).toBe(false);
    expect(passesRequestDue({ ...k, passesRequestedAt: NOW - 601 }, NOW, true)).toBe(true);
    expect(passesRequestDue({ ...k, status: 'pending' }, NOW, true)).toBe(false);
  });

  it('a catch-up asks only a Keep whose last report and last request are both over 7 days old', () => {
    const k = applyPassReport([paired()], report({ at: NOW - 8 * DAY }), NOW)[0];
    expect(lastReportAt(k)).toBe(NOW - 8 * DAY);
    expect(passesRequestDue(k, NOW, false)).toBe(true);
    expect(passesRequestDue({ ...k, passesRequestedAt: NOW - DAY }, NOW, false)).toBe(false);
    const fresh = applyPassReport([paired()], report({ at: NOW - 6 * DAY }), NOW)[0];
    expect(passesRequestDue(fresh, NOW, false)).toBe(false);
    expect(passesRequestDue(paired(), NOW, false)).toBe(false); // never reported: nobody has opened it yet
  });
});

describe('the return passes switch', () => {
  it('is on until the owner changes it, and nothing is waiting', () => {
    const k = paired();
    expect(returnPassesOn(k)).toBe(true);
    expect(returnPassesLabel(k, NOW)).toBeUndefined();
    expect(settingsDue(k, NOW)).toBe(false);
  });

  it('a change is the next revision, waiting, and due at once', () => {
    const k = composeSettings(paired(), false, NOW);
    expect(k.settings).toEqual({ returnPasses: false, setrev: 1, composedAt: NOW, sentAt: 0, confirmed: false });
    expect(returnPassesOn(k)).toBe(false);
    expect(returnPassesLabel(k, NOW)).toBe('Waiting for the Keep');
    expect(settingsDue(k, NOW)).toBe(true);
    expect(composeSettings(k, true, NOW + 5).settings).toMatchObject({ setrev: 2, returnPasses: true });
  });

  it('says the Keep cannot do this yet once the resend window has passed with no ack, and Waiting again after a new change', () => {
    const k = composeSettings(paired(), false, NOW);
    expect(returnPassesLabel(k, NOW + 600)).toBe('Waiting for the Keep');
    expect(returnPassesLabel(k, NOW + 601)).toBe('This Keep can’t do this yet');
    expect(returnPassesLabel(composeSettings(k, true, NOW + 700), NOW + 701)).toBe('Waiting for the Keep');
  });

  it('is sent again 10 minutes after the last send while unanswered, not once acked or given up', () => {
    const k = { ...composeSettings(paired(), false, NOW), };
    const sent = { ...k, settings: { ...k.settings!, sentAt: NOW } };
    expect(settingsDue(sent, NOW + 600)).toBe(false);
    expect(settingsDue(sent, NOW + 601)).toBe(true);
    expect(settingsDue({ ...sent, settings: { ...sent.settings, confirmed: true } }, NOW + 9999)).toBe(false);
    expect(settingsDue({ ...sent, settings: { ...sent.settings, failed: 'stale' } }, NOW + 9999)).toBe(false);
    expect(settingsDue({ ...sent, status: 'pending' }, NOW + 9999)).toBe(false);
  });

  const settingsAck = (over: Partial<KeepAck>): KeepAck => ({ keep: K, status: 'updated', claim: false, settings: true, setrev: 1, at: NOW + 5, to: O, ...over });
  const sentAt = (k: StoredKeep, at = NOW): StoredKeep => ({ ...k, settings: { ...k.settings!, sentAt: at } });

  it('updated at our setrev confirms; at another setrev, before the message was made, or repeated, it does not', () => {
    const k = sentAt(composeSettings(paired(), false, NOW));
    const done = applySettingsAck([k], settingsAck({}), NOW + 6);
    expect(done[0].settings?.confirmed).toBe(true);
    expect(returnPassesLabel(done[0], NOW + 9999)).toBeUndefined();
    expect(applySettingsAck([k], settingsAck({ setrev: 2 }), NOW + 6)[0]).toBe(k);
    expect(applySettingsAck([k], settingsAck({ setrev: 0 }), NOW + 6)[0]).toBe(k);
    expect(applySettingsAck([k], settingsAck({ at: NOW - 3 * DAY }), NOW + 6)[0]).toBe(k); // an old ack returned again by a relay
    expect(applySettingsAck(done, settingsAck({}), NOW + 7)).toBe(done);
  });

  it('an ack for a Keep with no pending change is ignored', () => {
    const list = [paired()];
    expect(applySettingsAck(list, settingsAck({}), NOW)).toBe(list);
  });

  it('refused stale: takes the Keep\'s setrev, makes the change again one higher, once; the second refusal gives up', () => {
    const k = sentAt(composeSettings(paired(), false, NOW));
    const stale = (setrev: number, at: number): KeepAck => settingsAck({ status: 'refused', reason: 'stale', setrev, at });
    const again = applySettingsAck([k], stale(4, NOW + 5), NOW + 6)[0];
    expect(again.settings).toEqual({ returnPasses: false, setrev: 5, composedAt: NOW + 6, sentAt: 0, confirmed: false, refusedAt: NOW + 5, retried: true });
    expect(settingsDue(again, NOW + 6)).toBe(true);
    // a repeat of the same refusal (a relay returning it) is not an answer to the new message
    expect(applySettingsAck([again], stale(4, NOW + 5), NOW + 7)[0]).toBe(again);
    // the refusal of an older send of ours: the newer one stands
    expect(applySettingsAck([again], stale(3, NOW + 8), NOW + 9)[0]).toBe(again);
    const failed = applySettingsAck([again], stale(5, NOW + 20), NOW + 21)[0];
    expect(failed.settings).toMatchObject({ failed: 'stale', setrev: 5 });
    expect(settingsDue(failed, NOW + 9999)).toBe(false);
    expect(returnPassesLabel(failed, NOW + 30)).toBe('The Keep has a newer setting. Switch it again.');
    // switching again after giving up starts afresh, above the Keep's number
    expect(composeSettings(failed, false, NOW + 40).settings).toMatchObject({ setrev: 6, confirmed: false, sentAt: 0 });
    expect(composeSettings(failed, false, NOW + 40).settings).not.toHaveProperty('failed');
  });

  it('a lost ack then a resend of the same revision: the Keep says stale at our own revision and the retry confirms', () => {
    const k = sentAt(composeSettings(paired(), false, NOW));
    const retried = applySettingsAck([k], settingsAck({ status: 'refused', reason: 'stale', setrev: 1, at: NOW + 700 }), NOW + 701)[0];
    expect(retried.settings).toMatchObject({ setrev: 2, returnPasses: false, retried: true, confirmed: false });
    const done = applySettingsAck([retried], settingsAck({ setrev: 2, at: NOW + 705 }), NOW + 706)[0];
    expect(done.settings?.confirmed).toBe(true);
  });

  it('a stale ack at a revision this app cannot add one to gives up instead of composing', () => {
    const k = sentAt(composeSettings(paired(), false, NOW));
    const stale = settingsAck({ status: 'refused', reason: 'stale', setrev: Number.MAX_SAFE_INTEGER - 1, at: NOW + 5 });
    expect(applySettingsAck([k], stale, NOW + 6)[0].settings?.failed).toBe('stale');
  });
});

describe('storage', () => {
  it('a record with passes and settings is read back as stored; a record without them still reads', () => {
    const k = applyPassReport([composeSettings(paired({ passesRequestedAt: NOW }), false, NOW)], report(), NOW);
    const raw = JSON.parse(JSON.stringify(k));
    expect(parseStoredKeeps(raw)).toEqual(k);
    expect(parseStoredKeeps(JSON.parse(JSON.stringify([paired()])))).toEqual([paired()]);
  });

  // A bad piece of the return-pass data is dropped; the Keep, its invites and the other passes still load.
  it.each([
    ['a pass with a short grant', (k: Record<string, any>) => { k.passes[0].grant = 'ab'; }],
    ['a pass with an unknown state', (k: Record<string, any>) => { k.passes[0].state = 'frozen'; }],
    ['a pass with a fractional expiration', (k: Record<string, any>) => { k.passes[0].expiration = 1.5; }],
    ['a pass with an expiration past 2^53', (k: Record<string, any>) => { k.passes[0].expiration = 1e16; }],
    ['a pass with a seen time past 2^53', (k: Record<string, any>) => { k.passes[0].seenAt = 1e16; }],
    ['a pass with a negative expiration', (k: Record<string, any>) => { k.passes[0].expiration = -1; }],
    ['a pass that is not an object', (k: Record<string, any>) => { k.passes[0] = 7; }],
  ])('drops only %s', (_label, mutate) => {
    const raw = JSON.parse(JSON.stringify(applyPassReport(applyPassReport([composeSettings(paired(), false, NOW)], report(), NOW), report({ grant: G2 }), NOW)));
    mutate(raw[0]);
    const list = parseStoredKeeps(raw);
    expect(list).not.toBeNull();
    expect(list![0].passes?.map(p => p.grant)).toEqual([G2]);
    expect(list![0].settings).toEqual(raw[0].settings);
  });

  it('drops a repeated grant, keeping the first', () => {
    const raw = JSON.parse(JSON.stringify(applyPassReport([paired()], report(), NOW)));
    raw[0].passes.push({ ...raw[0].passes[0], expiration: raw[0].passes[0].expiration + 1 });
    expect(parseStoredKeeps(raw)![0].passes).toEqual([raw[0].passes[0]]);
  });

  it.each([
    ['settings with a text setrev', (k: Record<string, any>) => { k.settings.setrev = 'x'; }, 'settings'],
    ['settings with a setrev past 2^53', (k: Record<string, any>) => { k.settings.setrev = 1e16; }, 'settings'],
    ['a text request time', (k: Record<string, any>) => { k.passesRequestedAt = 'x'; }, 'passesRequestedAt'],
    ['passes that are not a list', (k: Record<string, any>) => { k.passes = 'x'; }, 'passes'],
  ])('drops %s and keeps the rest of the Keep', (_label, mutate, field) => {
    const raw = JSON.parse(JSON.stringify(applyPassReport([composeSettings(paired({ passesRequestedAt: NOW }), false, NOW)], report(), NOW)));
    mutate(raw[0]);
    const list = parseStoredKeeps(raw);
    expect(list).not.toBeNull();
    expect(list![0]).not.toHaveProperty(field);
    expect(list![0].keep).toBe(K);
  });

  it('one bad pass in one Keep does not stop the other Keeps loading', () => {
    const other = '77'.repeat(32);
    const second = { ...paired(), keep: other };
    const raw = JSON.parse(JSON.stringify([applyPassReport([paired()], report(), NOW)[0], second]));
    raw[0].passes[0].expiration = 1e16;
    const list = parseStoredKeeps(raw);
    expect(list?.map(k => k.keep)).toEqual([K, other]);
    expect(list![0].passes).toEqual([]);
  });

  it('a bad invite or Keep field still makes the list unreadable (invites hold secrets and are never dropped)', () => {
    const raw = JSON.parse(JSON.stringify([paired()]));
    raw[0].claimedAt = 'x';
    expect(parseStoredKeeps(raw)).toBeNull();
  });

  it('adding the Keep again keeps its passes, asks again, and sends the switch again as a new message', () => {
    let k = applyPassReport([composeSettings(paired({ passesRequestedAt: NOW }), false, NOW)], report(), NOW)[0];
    k = { ...k, settings: { ...k.settings!, confirmed: true, sentAt: NOW, retried: true, refusedAt: NOW } };
    const repaired = repairKeep(k, { name: 'Home', relays: ['wss://a.example'], code: '44'.repeat(16), now: NOW + 100 });
    expect(repaired.passes).toEqual(k.passes);
    expect(repaired).not.toHaveProperty('passesRequestedAt');
    expect(repaired.settings).toEqual(restartedSettings(k.settings!, NOW + 100));
    expect(repaired.settings).toEqual({ returnPasses: false, setrev: 1, composedAt: NOW + 100, sentAt: 0, confirmed: false });
  });
});
