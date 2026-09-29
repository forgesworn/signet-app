import { describe, it, expect, vi, beforeEach } from 'vitest';

const relayMock = vi.hoisted(() => ({
  fetchReturns: {} as Record<string, Array<{ id: string; created_at: number; content: string }>>,
  fetchThrows: new Set<string>(),
  published: [] as Array<{ url: string; id: string }>,
}));
vi.mock('signet-protocol', async () => {
  const actual = await vi.importActual<typeof import('signet-protocol')>('signet-protocol');
  return {
    ...actual,
    RelayClient: class MockRelayClient {
      url: string;
      constructor(url: string) { this.url = url; }
      async connect(): Promise<void> { if (relayMock.fetchThrows.has(this.url)) throw new Error('connect failed'); }
      async fetch(filters: Array<{ authors?: string[] }>) {
        const author = filters?.[0]?.authors?.[0];
        return (relayMock.fetchReturns[this.url] ?? []).map((e) => ({ pubkey: author, ...e }));
      }
      async publish(ev: { id: string }): Promise<{ ok: boolean }> { relayMock.published.push({ url: this.url, id: ev.id }); return { ok: true }; }
      disconnect(): void {}
    },
  };
});
beforeEach(() => { relayMock.fetchReturns = {}; relayMock.fetchThrows = new Set(); relayMock.published = []; });

import { mergeChildRules, publishChildRulesSync, fetchChildRulesSync } from './child-rules-sync';
import { childRuleId } from './child-rules';
import type { ChildRule } from '../types/child-rules';

const DEP = 'd'.repeat(64), AUTHOR = 'a'.repeat(64);
function rule(over: Partial<ChildRule> = {}): ChildRule {
  const persona = '*', scope = 'sign-in', target = 'site:https://roblox.com';
  return { id: childRuleId(DEP, persona, scope, target), dependantId: DEP, persona, scope, target: target as ChildRule['target'],
    decision: 'allow', createdAt: 100, updatedAt: 100, ...over };
}
function fakeNip44(plaintext: string): string {
  const body = new TextEncoder().encode(plaintext.padEnd(96, ' '));
  const bytes = new Uint8Array(1 + body.length); bytes[0] = 2; bytes.set(body, 1);
  let b = ''; for (const x of bytes) b += String.fromCharCode(x);
  return btoa(b);
}
function openFakeNip44(c: string): string {
  const bytes = Uint8Array.from(atob(c), ch => ch.charCodeAt(0));
  if (bytes[0] !== 2) throw new Error('not ours');
  return new TextDecoder().decode(bytes.subarray(1));
}
function backend(pub = AUTHOR) {
  return {
    activePublicKeyHex: pub, type: 'local',
    nip44Encrypt: vi.fn(async (_p: string, t: string) => fakeNip44(t)),
    nip44Decrypt: vi.fn(async (_p: string, c: string) => openFakeNip44(c)),
    signEvent: vi.fn(async (ev: Record<string, unknown>) => ({ ...ev, id: 'sig'.padEnd(64, '0'), sig: 's'.repeat(128) })),
  } as never;
}

describe('mergeChildRules', () => {
  it('adds remote-only and keeps local-only', () => {
    const r = mergeChildRules([rule({ scope: 'dm-private', id: 'x'.repeat(32) })], [rule()]);
    expect(r.merged).toHaveLength(2);
    expect(r.changed).toBe(true);
    expect(mergeChildRules([rule()], []).changed).toBe(false);
  });
  it('newer wins in both directions', () => {
    expect(mergeChildRules([rule({ decision: 'deny', updatedAt: 100 })], [rule({ updatedAt: 200 })]).merged[0].decision).toBe('allow');
    const keep = mergeChildRules([rule({ updatedAt: 200 })], [rule({ decision: 'deny', updatedAt: 100 })]);
    expect(keep.merged[0].decision).toBe('allow');
    expect(keep.changed).toBe(false);
  });
  it('tombstone wins when newer, and on a tie', () => {
    expect(mergeChildRules([rule()], [rule({ tombstonedAt: 150, updatedAt: 150 })]).merged[0].tombstonedAt).toBe(150);
    expect(mergeChildRules([rule()], [rule({ tombstonedAt: 100 })]).merged[0].tombstonedAt).toBe(100);
  });
  it('a newer rule supersedes an older tombstone', () => {
    const m = mergeChildRules([rule({ tombstonedAt: 150, updatedAt: 150 })], [rule({ updatedAt: 300 })]);
    expect(m.merged[0].tombstonedAt).toBeUndefined();
  });
  it('an old tombstone does not beat a newer local edit', () => {
    const m = mergeChildRules([rule({ updatedAt: 300 })], [rule({ tombstonedAt: 150, updatedAt: 100 })]);
    expect(m.merged[0].updatedAt).toBe(300);
  });
});

describe('publish/fetch', () => {
  it('never publishes an information-free record', async () => {
    expect(await publishChildRulesSync([], backend(), ['wss://a.example'])).toBe(false);
    expect(relayMock.published).toEqual([]);
  });
  it('publishes a non-empty set', async () => {
    expect(await publishChildRulesSync([rule()], backend(), ['wss://a.example'])).toBe(true);
    expect(relayMock.published).toHaveLength(1);
  });
  it('fetch returns unreachable when every relay fails', async () => {
    relayMock.fetchThrows = new Set(['wss://a.example']);
    expect(await fetchChildRulesSync(AUTHOR, backend(), ['wss://a.example'])).toBe('unreachable');
  });
  it('fetch decodes rules and drops malformed entries', async () => {
    const payload = JSON.stringify({ v: 1, rules: [rule(), { ...rule(), persona: 'nope' }, 7] });
    relayMock.fetchReturns = { 'wss://a.example': [{ id: '1'.repeat(64), created_at: 1000, content: fakeNip44(payload) }] };
    const r = await fetchChildRulesSync(AUTHOR, backend(), ['wss://a.example']);
    expect(r).not.toBeNull();
    if (r && r !== 'unreachable') expect(r.rules).toHaveLength(1);
  });
});
