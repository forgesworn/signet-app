import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { getConversationKey, encrypt } from 'nostr-tools/nip44';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  buildChildPairUri, parseChildPairUri, buildChildPairRequestEvent, openChildPairRequestEvent,
  buildChildPairReplyEvent, openChildPairReplyEvent, newPairCode, pairRequestDTag, pairReplyDTag, pairCheckWords,
  type ChildPairOffer, type ChildPairRequest, type ChildPairReply,
} from './child-pair-wire';

const NOW = 1_800_000_000;
const kp = () => { const sk = generateSecretKey(); return { sk: bytesToHex(sk), pk: getPublicKey(sk) }; };
const h = (c: string) => c.repeat(64);
const offer = (over: Partial<ChildPairOffer> = {}): ChildPairOffer => ({
  v: 2, rail: h('a'), guardian: h('b'), dependant: h('c'), persona: h('d'), name: 'Alex',
  relay: 'wss://rail.example.com', hwRelays: ['wss://hw.example.com'], code: newPairCode(), t: NOW, ...over,
});
const nc = (pk: string, secret = 'sekrit') => `nostrconnect://${pk}?relay=${encodeURIComponent('wss://hw.example.com')}&secret=${secret}&name=My%20Signet`;
const mkReq = (client: string, code: string, over: Partial<ChildPairRequest> = {}): ChildPairRequest =>
  ({ v: 1, code, nostrconnect: nc(client), clientPubkey: client, createdAt: NOW, ...over });

describe('newPairCode', () => {
  it('is 32 lowercase hex and unique', () => {
    const a = newPairCode(), b = newPairCode();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('pair URI', () => {
  it('round trips', () => {
    const o = offer({ hwRelays: ['wss://hw1.example.com', 'wss://hw2.example.com'], name: 'Zoë & Co' });
    const uri = buildChildPairUri(o);
    expect(uri.startsWith('signet-child:?v=2&')).toBe(true);
    expect(parseChildPairUri(uri, NOW + 5)).toEqual(o);
  });
  it('rejects ws:// non-localhost relay (rail or hw)', () => {
    expect(parseChildPairUri(buildChildPairUri(offer({ relay: 'ws://evil.example.com' })), NOW)).toBeNull();
    expect(parseChildPairUri(buildChildPairUri(offer({ hwRelays: ['ws://evil.example.com'] })), NOW)).toBeNull();
    expect(parseChildPairUri(buildChildPairUri(offer({ relay: 'ws://localhost:7777' })), NOW)).not.toBeNull();
  });
  it('rejects uppercase hex', () => {
    expect(parseChildPairUri(buildChildPairUri(offer({ rail: 'A'.repeat(64) })), NOW)).toBeNull();
    expect(parseChildPairUri(buildChildPairUri(offer({ code: 'A'.repeat(32) })), NOW)).toBeNull();
  });
  it('rejects stale or far-future t', () => {
    const uri = buildChildPairUri(offer());
    expect(parseChildPairUri(uri, NOW + 601)).toBeNull();
    expect(parseChildPairUri(uri, NOW + 600)).not.toBeNull();
    expect(parseChildPairUri(uri, NOW - 400)).toBeNull();
  });
  it('rejects oversize input', () => {
    expect(parseChildPairUri(buildChildPairUri(offer()) + '&x=' + 'a'.repeat(9000), NOW)).toBeNull();
  });
  it('rejects missing hwrelay, wrong scheme, wrong version, empty name', () => {
    const uri = buildChildPairUri(offer());
    expect(parseChildPairUri(uri.replace(/&hwrelay=[^&]*/, ''), NOW)).toBeNull();
    expect(parseChildPairUri(uri.replace('signet-child:', 'other:'), NOW)).toBeNull();
    expect(parseChildPairUri(uri.replace('v=2', 'v=1'), NOW)).toBeNull();
    expect(parseChildPairUri(buildChildPairUri(offer({ name: '‮' })), NOW)).toBeNull();
    expect(parseChildPairUri('', NOW)).toBeNull();
  });
});

describe('request event', () => {
  it('round trips', async () => {
    const child = kp(), rail = kp(), code = newPairCode();
    const req = mkReq(child.pk, code);
    const ev = await buildChildPairRequestEvent(req, child.sk, rail.pk);
    expect(ev.kind).toBe(30078);
    expect(ev.tags).toContainEqual(['d', pairRequestDTag(code)]);
    expect(ev.tags).toContainEqual(['p', rail.pk]);
    expect(ev.content).not.toContain('nostrconnect');
    expect(await openChildPairRequestEvent(ev, rail.sk, { code, nowS: NOW + 10 })).toEqual(req);
  });
  it('wrong author (event signed by another key) -> null', async () => {
    const child = kp(), other = kp(), rail = kp(), code = newPairCode();
    const ev = await buildChildPairRequestEvent(mkReq(child.pk, code), other.sk, rail.pk);
    expect(await openChildPairRequestEvent(ev, rail.sk, { code, nowS: NOW })).toBeNull();
  });
  it('wrong code -> null', async () => {
    const child = kp(), rail = kp(), code = newPairCode();
    const ev = await buildChildPairRequestEvent(mkReq(child.pk, code), child.sk, rail.pk);
    expect(await openChildPairRequestEvent(ev, rail.sk, { code: newPairCode(), nowS: NOW })).toBeNull();
  });
  it('inner code differing from d tag -> null', async () => {
    const child = kp(), rail = kp(), code = newPairCode(), inner = newPairCode();
    const ev = await buildChildPairRequestEvent(mkReq(child.pk, inner), child.sk, rail.pk);
    const forged = finalizeEvent({ kind: 30078, created_at: NOW, tags: [['d', pairRequestDTag(code)], ['p', rail.pk]], content: ev.content }, hexToBytes(child.sk));
    expect(await openChildPairRequestEvent(forged, rail.sk, { code, nowS: NOW })).toBeNull();
  });
  it('stale or future -> null', async () => {
    const child = kp(), rail = kp(), code = newPairCode();
    const ev = await buildChildPairRequestEvent(mkReq(child.pk, code), child.sk, rail.pk);
    expect(await openChildPairRequestEvent(ev, rail.sk, { code, nowS: NOW + 601 })).toBeNull();
    expect(await openChildPairRequestEvent(ev, rail.sk, { code, nowS: NOW - 400 })).toBeNull();
  });
  it('nostrconnect for a different pubkey -> null', async () => {
    const child = kp(), rail = kp(), code = newPairCode();
    const ev = await buildChildPairRequestEvent(mkReq(child.pk, code, { nostrconnect: nc(kp().pk) }), child.sk, rail.pk);
    expect(await openChildPairRequestEvent(ev, rail.sk, { code, nowS: NOW })).toBeNull();
  });
  it('nostrconnect without a secret -> null', async () => {
    const child = kp(), rail = kp(), code = newPairCode();
    const req = mkReq(child.pk, code, { nostrconnect: `nostrconnect://${child.pk}?relay=${encodeURIComponent('wss://hw.example.com')}` });
    const ev = await buildChildPairRequestEvent(req, child.sk, rail.pk);
    expect(await openChildPairRequestEvent(ev, rail.sk, { code, nowS: NOW })).toBeNull();
  });
  it('clientPubkey naming a key other than the author -> null', async () => {
    const child = kp(), named = kp(), rail = kp(), code = newPairCode();
    const ev = await buildChildPairRequestEvent(mkReq(named.pk, code), child.sk, rail.pk);
    expect(await openChildPairRequestEvent(ev, rail.sk, { code, nowS: NOW })).toBeNull();
  });
  it('tampered event or wrong rail key -> null', async () => {
    const child = kp(), rail = kp(), code = newPairCode();
    const ev = await buildChildPairRequestEvent(mkReq(child.pk, code), child.sk, rail.pk);
    expect(await openChildPairRequestEvent({ ...ev, content: ev.content + 'A' }, rail.sk, { code, nowS: NOW })).toBeNull();
    expect(await openChildPairRequestEvent(ev, kp().sk, { code, nowS: NOW })).toBeNull();
  });
  it('garbage plaintext -> null', async () => {
    const child = kp(), rail = kp(), code = newPairCode();
    const content = encrypt('not json', getConversationKey(hexToBytes(child.sk), rail.pk));
    const ev = finalizeEvent({ kind: 30078, created_at: NOW, tags: [['d', pairRequestDTag(code)], ['p', rail.pk]], content }, hexToBytes(child.sk));
    expect(await openChildPairRequestEvent(ev as never, rail.sk, { code, nowS: NOW })).toBeNull();
  });
});

describe('reply event', () => {
  const reply = (code: string): ChildPairReply => ({
    v: 1, code, ok: true, stage: 'request-approve',
    personas: [{ pubkey: h('e'), name: 'Alex', role: 'persona' }, { pubkey: h('f'), name: 'Alex Smith', role: 'natural-person' }],
  });
  it('round trips', async () => {
    const child = kp(), rail = kp(), code = newPairCode();
    const ev = await buildChildPairReplyEvent(reply(code), rail.sk, child.pk);
    expect(ev.tags).toContainEqual(['d', pairReplyDTag(code)]);
    expect(await openChildPairReplyEvent(ev, child.sk, { code, railPubkey: rail.pk })).toEqual(reply(code));
  });
  it('round trips a refusal', async () => {
    const child = kp(), rail = kp(), code = newPairCode();
    const r: ChildPairReply = { v: 1, code, ok: false, reason: 'expired', personas: [], stage: 'full-control' };
    const ev = await buildChildPairReplyEvent(r, rail.sk, child.pk);
    expect(await openChildPairReplyEvent(ev, child.sk, { code, railPubkey: rail.pk })).toEqual(r);
  });
  it('wrong author -> null', async () => {
    const child = kp(), rail = kp(), other = kp(), code = newPairCode();
    const ev = await buildChildPairReplyEvent(reply(code), other.sk, child.pk);
    expect(await openChildPairReplyEvent(ev, child.sk, { code, railPubkey: rail.pk })).toBeNull();
  });
  it('wrong code or wrong recipient -> null', async () => {
    const child = kp(), rail = kp(), code = newPairCode();
    const ev = await buildChildPairReplyEvent(reply(code), rail.sk, child.pk);
    expect(await openChildPairReplyEvent(ev, child.sk, { code: newPairCode(), railPubkey: rail.pk })).toBeNull();
    expect(await openChildPairReplyEvent(ev, kp().sk, { code, railPubkey: rail.pk })).toBeNull();
  });
  it('bad stage is refused at build', async () => {
    const child = kp(), rail = kp(), code = newPairCode();
    const bad = { ...reply(code), stage: 'nope' } as unknown as ChildPairReply;
    await expect(buildChildPairReplyEvent(bad, rail.sk, child.pk)).rejects.toThrow();
  });
});

describe('A2 hashed d-tags', () => {
  it('never carries the code in clear', () => {
    const code = 'ab'.repeat(16);
    expect(pairRequestDTag(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(pairRequestDTag(code)).not.toContain(code);
    expect(pairReplyDTag(code)).not.toBe(pairRequestDTag(code));
  });
});

describe('A3 pairCheckWords', () => {
  it('is deterministic with a fixed vector', () => {
    const w = pairCheckWords('ab'.repeat(16), 'cd'.repeat(32));
    expect(w).toEqual(pairCheckWords('ab'.repeat(16), 'cd'.repeat(32)));
    expect(w).toEqual(VECTOR);
  });
  it('changes with either input', () => {
    const base = pairCheckWords('ab'.repeat(16), 'cd'.repeat(32));
    expect(pairCheckWords('ac'.repeat(16), 'cd'.repeat(32))).not.toEqual(base);
    expect(pairCheckWords('ab'.repeat(16), 'ce'.repeat(32))).not.toEqual(base);
  });
});
const VECTOR: string[] = ['claw', 'planet', 'junk', 'present'];
