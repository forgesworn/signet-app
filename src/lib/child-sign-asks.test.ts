import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { getConversationKey, encrypt } from 'nostr-tools/nip44';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import { buildAskEvent, openAskEvent, askInScope, buildVerdictEvent, openVerdictEvent, openRailVerdictEvent, templateHash, type ChildSignAsk } from './child-sign-asks';

const rail = generateSecretKey(), client = generateSecretKey();
const RAIL_SK = bytesToHex(rail), RAIL_PK = getPublicKey(rail);
const CLIENT_SK = bytesToHex(client), CLIENT_PK = getPublicKey(client);
const DEP = 'd'.repeat(64), PERSONA = 'a'.repeat(64), PEER = 'e'.repeat(64), ID = '1'.repeat(32);
const NOW = 1_800_000_000;

function ask(over: Partial<ChildSignAsk> = {}): ChildSignAsk {
  return { v: 1, id: ID, dependantId: DEP, persona: PERSONA, scope: 'sign-in', kind: 21236, method: 'sign_event',
    target: 'site:https://a.example', targetLabel: 'a.example',
    template: { kind: 21236, pubkey: PERSONA, created_at: NOW, tags: [['origin', 'https://a.example']], content: '' },
    createdAt: NOW, expiresAt: NOW + 600, ...over };
}
const scope = { clientPubkey: CLIENT_PK, dependantId: DEP, personas: [PERSONA], nowS: NOW + 5 };

describe('ask rail', () => {
  it('round-trips', async () => {
    const ev = await buildAskEvent(ask(), CLIENT_SK, RAIL_PK);
    expect(ev.tags[0]).toEqual(['d', 'signet:child-sign-request:v1:' + ID]);
    const out = await openAskEvent(ev, RAIL_SK, scope);
    expect(out).toEqual({ ...ask(), templateHash: templateHash(ask().template!), contentTruncated: false, contentLength: 0, tagsTruncated: false });
  });
  it('round-trips a nip44 ask', async () => {
    const a = ask({ method: 'nip44_encrypt', scope: 'dm-private', kind: 0, target: `peer:${PEER}`, template: undefined });
    delete a.template;
    const ev = await buildAskEvent(a, CLIENT_SK, RAIL_PK);
    expect((await openAskEvent(ev, RAIL_SK, scope))?.method).toBe('nip44_encrypt');
  });
  it('unknown persona -> null', async () => {
    const ev = await buildAskEvent(ask({ persona: 'b'.repeat(64), template: { ...ask().template!, pubkey: 'b'.repeat(64) } }), CLIENT_SK, RAIL_PK);
    expect(await openAskEvent(ev, RAIL_SK, scope)).toBeNull();
  });
  it('kind/scope mismatch -> null', async () => {
    // claims dm-private but the template is a sign-in
    const ev = await buildAskEvent(ask({ scope: 'dm-private' }), CLIENT_SK, RAIL_PK);
    expect(await openAskEvent(ev, RAIL_SK, scope)).toBeNull();
    // claims kind 1 but template is kind 21236
    const ev2 = await buildAskEvent(ask({ kind: 1 }), CLIENT_SK, RAIL_PK);
    expect(await openAskEvent(ev2, RAIL_SK, scope)).toBeNull();
    expect(askInScope(ask({ kind: 1 }), scope)).toBe(false);
  });
  it('expired -> null', async () => {
    const ev = await buildAskEvent(ask(), CLIENT_SK, RAIL_PK);
    expect(await openAskEvent(ev, RAIL_SK, { ...scope, nowS: NOW + 601 })).toBeNull();
  });
  it('wrong author or wrong dependant -> null', async () => {
    const ev = await buildAskEvent(ask(), CLIENT_SK, RAIL_PK);
    expect(await openAskEvent(ev, RAIL_SK, { ...scope, clientPubkey: 'c'.repeat(64) })).toBeNull();
    expect(await openAskEvent(ev, RAIL_SK, { ...scope, dependantId: 'c'.repeat(64) })).toBeNull();
    const attacker = generateSecretKey();
    const forged = finalizeEvent({ kind: 30078, created_at: NOW, tags: ev.tags.map(t => [...t]), content: encrypt(JSON.stringify(ask()), getConversationKey(attacker, RAIL_PK)) }, attacker) as unknown as NostrEvent;
    expect(await openAskEvent(forged, RAIL_SK, scope)).toBeNull();
  });
  it('oversize template content is truncated, not rejected', async () => {
    const a = ask({ template: { kind: 21236, pubkey: PERSONA, created_at: NOW, tags: [['origin', 'https://a.example']], content: 'x'.repeat(50_000) } });
    const ev = await buildAskEvent(a, CLIENT_SK, RAIL_PK);
    expect(ev.content.length).toBeLessThanOrEqual(16384);
    const out = await openAskEvent(ev, RAIL_SK, scope);
    expect(out?.template?.content).toHaveLength(4096);
    expect(out).toMatchObject({ contentTruncated: true, contentLength: 50_000, tagsTruncated: false, templateHash: templateHash(a.template!) });
  });
  it('A12: keeps tags to a 4 KB budget and flags the truncation', async () => {
    const tags = Array.from({ length: 40 }, (_, i) => ['t', `tag-${i}-` + 'y'.repeat(200)]);
    const a = ask({ target: `app:${'f'.repeat(64)}`, template: { kind: 21236, pubkey: PERSONA, created_at: NOW, tags: [['origin', 'https://a.example'], ...tags], content: '' } });
    const out = await openAskEvent(await buildAskEvent(a, CLIENT_SK, RAIL_PK), RAIL_SK, scope);
    expect(out?.tagsTruncated).toBe(true);
    expect(out?.template?.tags[0]).toEqual(['origin', 'https://a.example']);
    expect(JSON.stringify(out?.template?.tags).length).toBeLessThanOrEqual(4096);
    expect(out?.templateHash).toBe(templateHash(a.template!));
  });
  it('A12: templateHash is sha256 of [pubkey, kind, tags, content]', () => {
    const t = ask().template!;
    expect(templateHash(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(templateHash({ ...t, content: 'x' })).not.toBe(templateHash(t));
    expect(templateHash({ ...t, created_at: t.created_at + 1 })).toBe(templateHash(t));
  });
  it('A12: template.pubkey must equal persona', async () => {
    const bad = ask({ template: { ...ask().template!, pubkey: 'b'.repeat(64) } });
    await expect(buildAskEvent(bad, CLIENT_SK, RAIL_PK)).rejects.toThrow();
    expect(askInScope(bad, scope)).toBe(false);
  });
  it('A12: a site target the template does not yield is dropped', async () => {
    const forged = ask({ target: 'site:https://evil.example' });
    expect(askInScope({ ...forged, templateHash: templateHash(forged.template!), contentTruncated: false, contentLength: 0, tagsTruncated: false }, scope)).toBe(false);
    expect(askInScope({ ...ask(), templateHash: templateHash(ask().template!), contentTruncated: false, contentLength: 0, tagsTruncated: false }, scope)).toBe(true);
    // an app target is not re-derivable from the template and passes
    expect(askInScope({ ...ask({ target: `app:${'f'.repeat(64)}` }), templateHash: templateHash(ask().template!), contentTruncated: false, contentLength: 0, tagsTruncated: false }, scope)).toBe(true);
  });
  it('A12: an untruncated template whose hash does not match is dropped', () => {
    const a = { ...ask(), templateHash: '0'.repeat(64), contentTruncated: false, contentLength: 0, tagsTruncated: false };
    expect(askInScope(a, scope)).toBe(false);
  });
  it('rejects a wildcard target and a malformed id on build', async () => {
    await expect(buildAskEvent(ask({ target: '*' }), CLIENT_SK, RAIL_PK)).rejects.toThrow();
    await expect(buildAskEvent(ask({ id: 'zz' }), CLIENT_SK, RAIL_PK)).rejects.toThrow();
  });
});

describe('verdict rail', () => {
  it('round-trips', async () => {
    const ev = await buildVerdictEvent({ v: 1, id: ID, verdict: 'always', ruleId: '2'.repeat(32), decidedAt: NOW }, RAIL_SK, CLIENT_PK);
    expect(ev.tags[0]).toEqual(['d', 'signet:child-sign-reply:v1:' + ID]);
    expect(await openVerdictEvent(ev, CLIENT_SK, { railPubkey: RAIL_PK, id: ID })).toEqual({ v: 1, id: ID, verdict: 'always', ruleId: '2'.repeat(32), decidedAt: NOW });
  });
  it('carries reason and alwaysDeny', async () => {
    const ev = await buildVerdictEvent({ v: 1, id: ID, verdict: 'deny', alwaysDeny: true, reason: 'device-unreachable', decidedAt: NOW }, RAIL_SK, CLIENT_PK);
    const out = await openVerdictEvent(ev, CLIENT_SK, { railPubkey: RAIL_PK, id: ID });
    expect(out).toMatchObject({ verdict: 'deny', alwaysDeny: true, reason: 'device-unreachable' });
  });
  it('a verdict for a different id -> null', async () => {
    const ev = await buildVerdictEvent({ v: 1, id: ID, verdict: 'once', decidedAt: NOW }, RAIL_SK, CLIENT_PK);
    expect(await openVerdictEvent(ev, CLIENT_SK, { railPubkey: RAIL_PK, id: '3'.repeat(32) })).toBeNull();
  });
  it('wrong author -> null', async () => {
    const attacker = generateSecretKey();
    const forged = finalizeEvent({ kind: 30078, created_at: NOW, tags: [['d', 'signet:child-sign-reply:v1:' + ID], ['p', CLIENT_PK]],
      content: encrypt(JSON.stringify({ v: 1, id: ID, verdict: 'once', decidedAt: NOW }), getConversationKey(attacker, CLIENT_PK)) }, attacker) as unknown as NostrEvent;
    expect(await openVerdictEvent(forged, CLIENT_SK, { railPubkey: RAIL_PK, id: ID })).toBeNull();
  });
});

describe('A35: openRailVerdictEvent (guardian side)', () => {
  it('the rail key opens its own published verdict; anything else is null', async () => {
    const ev = await buildVerdictEvent({ v: 1, id: ID, verdict: 'once', decidedAt: NOW }, RAIL_SK, CLIENT_PK);
    expect(await openRailVerdictEvent(ev, RAIL_SK, { clientPubkey: CLIENT_PK })).toMatchObject({ id: ID, verdict: 'once' });
    expect(await openRailVerdictEvent(ev, bytesToHex(generateSecretKey()), { clientPubkey: CLIENT_PK })).toBeNull();
    expect(await openRailVerdictEvent(ev, RAIL_SK, { clientPubkey: getPublicKey(generateSecretKey()) })).toBeNull();
    expect(await openRailVerdictEvent({ ...ev, tags: [['d', 'signet:child-sign-request:v1:' + ID], ev.tags[1]] }, RAIL_SK, { clientPubkey: CLIENT_PK })).toBeNull();
  });
});
