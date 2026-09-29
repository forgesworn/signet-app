import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import { buildChildRulesEvent, openChildRulesEvent, parseChildRuleRecord, CHILD_RULES_WIRE_D_TAG, type ChildRulesPayload } from './child-rules-wire';
import { childRuleId } from './child-rules';
import type { ChildRule } from '../types/child-rules';

const rail = generateSecretKey(), client = generateSecretKey();
const RAIL_SK = bytesToHex(rail), RAIL_PK = getPublicKey(rail);
const CLIENT_SK = bytesToHex(client), CLIENT_PK = getPublicKey(client);
const DEP = 'd'.repeat(64), PERSONA = 'a'.repeat(64);

function rule(over: Partial<ChildRule> = {}): ChildRule {
  const persona = over.persona ?? PERSONA, scope = over.scope ?? 'sign-in', target = over.target ?? 'site:https://roblox.com';
  const dependantId = over.dependantId ?? DEP;
  return { id: childRuleId(dependantId, persona, scope, target), dependantId, persona, scope, target, decision: 'allow',
    createdAt: 1000, updatedAt: 2000, ...over } as ChildRule;
}
function payload(rules: ChildRule[]): ChildRulesPayload {
  return { v: 1, dependantId: DEP, stage: 'request-approve', ceilingKinds: [1, 21236], rules, disconnectedApps: ['b'.repeat(64)], updatedAt: 5000 };
}
const expectOk = { railPubkey: RAIL_PK, dependantId: DEP };

describe('child rules wire', () => {
  it('round-trips, carrying live rules only and no lastUsedAt', async () => {
    const live = rule({ lastUsedAt: 1500 });
    const dead = rule({ scope: 'dm-private', tombstonedAt: 3000 });
    const ev = await buildChildRulesEvent(payload([live, dead]), RAIL_SK, CLIENT_PK, 1_000_000);
    expect(ev.tags[0]).toEqual(['d', CHILD_RULES_WIRE_D_TAG]);
    expect(ev.tags[1]).toEqual(['p', CLIENT_PK]);
    const out = await openChildRulesEvent(ev, CLIENT_SK, expectOk);
    expect(out).not.toBeNull();
    expect(out!.rules).toHaveLength(1);
    expect(out!.rules[0].id).toBe(live.id);
    expect(out!.rules[0].lastUsedAt).toBeUndefined();
    expect(out!.stage).toBe('request-approve');
    expect(out!.ceilingKinds).toEqual([1, 21236]);
    expect(out!.disconnectedApps).toEqual(['b'.repeat(64)]);
  });

  it('drops rules of another dependant on build', async () => {
    const other = rule({ dependantId: 'e'.repeat(64) });
    const ev = await buildChildRulesEvent(payload([other, rule()]), RAIL_SK, CLIENT_PK, 1_000_000);
    const out = await openChildRulesEvent(ev, CLIENT_SK, expectOk);
    expect(out!.rules).toHaveLength(1);
  });

  it('returns null for an event authored by anyone but the rail key', async () => {
    const ev = await buildChildRulesEvent(payload([rule()]), RAIL_SK, CLIENT_PK, 1_000_000);
    expect(await openChildRulesEvent(ev, CLIENT_SK, { railPubkey: 'c'.repeat(64), dependantId: DEP })).toBeNull();
    const attacker = generateSecretKey();
    const forged = finalizeEvent({ kind: 30078, created_at: 1, tags: ev.tags.map(t => [...t]), content: ev.content }, attacker) as unknown as NostrEvent;
    expect(await openChildRulesEvent(forged, CLIENT_SK, expectOk)).toBeNull();
  });

  it('returns null for a different dependant id', async () => {
    const ev = await buildChildRulesEvent(payload([rule()]), RAIL_SK, CLIENT_PK, 1_000_000);
    expect(await openChildRulesEvent(ev, CLIENT_SK, { railPubkey: RAIL_PK, dependantId: 'e'.repeat(64) })).toBeNull();
  });

  it('returns null when addressed to a different client', async () => {
    const other = getPublicKey(generateSecretKey());
    const ev = await buildChildRulesEvent(payload([rule()]), RAIL_SK, other, 1_000_000);
    expect(await openChildRulesEvent(ev, CLIENT_SK, expectOk)).toBeNull();
  });

  it("accepts scope '*', case-preserving app targets and kind:0..65535; rejects out-of-range kinds", () => {
    expect(parseChildRuleRecord(rule({ scope: '*', persona: '*', target: 'app:nip55:com.Bad.App', decision: 'deny' }))).not.toBeNull();
    expect(parseChildRuleRecord(rule({ scope: 'kind:65535' }))).not.toBeNull();
    expect(parseChildRuleRecord(rule({ scope: 'kind:65536' }))).toBeNull();
    expect(parseChildRuleRecord(rule({ scope: 'kind:99999999999' }))).toBeNull();
  });

  it('drops malformed rule entries individually', async () => {
    const good = rule();
    const bad = [
      { ...rule({ scope: 'dm-private' }), persona: 'zz' },
      { ...rule({ scope: 'post-public' }), decision: 'maybe' },
      { ...rule({ scope: 'upload-photo' }), id: 'f'.repeat(32) },
      { ...rule({ scope: 'venue-entry' }), target: 'javascript:alert(1)' },
    ] as unknown as ChildRule[];
    // Sealed directly so build's own check doesn't pre-filter: build via the
    // public API still runs the same parser, so the bad ones vanish there too.
    const ev = await buildChildRulesEvent(payload([good, ...bad]), RAIL_SK, CLIENT_PK, 1_000_000);
    const out = await openChildRulesEvent(ev, CLIENT_SK, expectOk);
    expect(out!.rules.map(r => r.id)).toEqual([good.id]);
    expect(parseChildRuleRecord(bad[0])).toBeNull();
    expect(parseChildRuleRecord(bad[1])).toBeNull();
    expect(parseChildRuleRecord(bad[2])).toBeNull();
    expect(parseChildRuleRecord(bad[3])).toBeNull();
  });

  it('throws too-large above the top bucket', async () => {
    const rules: ChildRule[] = [];
    for (let i = 0; i < 1500; i++) {
      rules.push(rule({ target: `site:https://site${i}.example.com`, label: 'x'.repeat(100) }));
    }
    await expect(buildChildRulesEvent(payload(rules), RAIL_SK, CLIENT_PK, 1_000_000)).rejects.toThrow('too-large');
  });
});
