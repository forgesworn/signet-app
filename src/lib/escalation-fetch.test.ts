/**
 * Tests for `escalation-fetch.ts` — C4 notice parsing, coalescing and
 * park-expiry helpers (§C4).
 */
import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import { giftWrap } from './relay-publish';
import { LocalSigningBackend } from './signing-backend';
import type { AuditRumor } from './audit-fetch';
import {
  ESCALATION_EVENT_KIND,
  parseEscalationNotice,
  coalesceNotices,
  isParkExpired,
  unwrapEscalationNotice,
  type EscalationNotice,
} from './escalation-fetch';

const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);
const HEX64_PARK = 'c'.repeat(64);

function baseRumor(overrides: Partial<{ kind: number; created_at: number; pubkey: string; tags: string[][]; content: string }> = {}): AuditRumor {
  return {
    id: 'fixture-id',
    pubkey: HEX64_A,
    created_at: 1_700_000_000,
    kind: ESCALATION_EVENT_KIND,
    tags: [],
    content: '',
    ...overrides,
  };
}

function approvalTags(over: Record<string, string> = {}): string[][] {
  const t: Record<string, string> = {
    t: 'approval',
    d: `${HEX64_A}:sign_event`,
    client: HEX64_A,
    identity: HEX64_B,
    method: 'sign_event',
    park: HEX64_PARK,
    ...over,
  };
  return Object.entries(t)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, v]);
}

function petitionTags(over: Record<string, string> = {}): string[][] {
  const t: Record<string, string> = {
    t: 'petition',
    d: `${HEX64_A}:petition-1`,
    client: HEX64_A,
    identity: HEX64_B,
    method: 'sign_event',
    ...over,
  };
  return Object.entries(t)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, v]);
}

describe('parseEscalationNotice', () => {
  it('parses a valid approval notice with k, park, park-ttl', () => {
    const rumor = baseRumor({
      tags: [...approvalTags(), ['k', '22242'], ['park-ttl', '300']],
    });
    const n = parseEscalationNotice(rumor);
    expect(n).toEqual<EscalationNotice>({
      id: `${HEX64_A}:sign_event`,
      kind: 'approval',
      clientPubkey: HEX64_A,
      identityPubkey: HEX64_B,
      method: 'sign_event',
      eventKind: 22242,
      parkId: HEX64_PARK,
      parkTtlSeconds: 300,
      createdAt: 1_700_000_000,
    });
  });

  it('parses a valid petition notice with count, no park', () => {
    const rumor = baseRumor({
      tags: [...petitionTags(), ['count', '3']],
    });
    const n = parseEscalationNotice(rumor);
    expect(n).toEqual<EscalationNotice>({
      id: `${HEX64_A}:petition-1`,
      kind: 'petition',
      clientPubkey: HEX64_A,
      identityPubkey: HEX64_B,
      method: 'sign_event',
      count: 3,
      createdAt: 1_700_000_000,
    });
  });

  it('rejects when t is missing or not approval/petition', () => {
    expect(parseEscalationNotice(baseRumor({ tags: approvalTags({ t: 'verify' }) }))).toBeNull();
    expect(parseEscalationNotice(baseRumor({ tags: approvalTags({ t: '' }) }))).toBeNull();
  });

  it('rejects when d is missing or empty', () => {
    expect(parseEscalationNotice(baseRumor({ tags: approvalTags({ d: '' }) }))).toBeNull();
    const tags = approvalTags();
    const withoutD = tags.filter(([k]) => k !== 'd');
    expect(parseEscalationNotice(baseRumor({ tags: withoutD }))).toBeNull();
  });

  it('rejects when client is missing or not hex64', () => {
    expect(parseEscalationNotice(baseRumor({ tags: approvalTags({ client: 'not-hex' }) }))).toBeNull();
    const tags = approvalTags().filter(([k]) => k !== 'client');
    expect(parseEscalationNotice(baseRumor({ tags }))).toBeNull();
  });

  it('rejects when identity is missing or not hex64', () => {
    expect(parseEscalationNotice(baseRumor({ tags: approvalTags({ identity: 'short' }) }))).toBeNull();
    const tags = approvalTags().filter(([k]) => k !== 'identity');
    expect(parseEscalationNotice(baseRumor({ tags }))).toBeNull();
  });

  it('lowercases client and identity hex', () => {
    const rumor = baseRumor({
      tags: approvalTags({ client: HEX64_A.toUpperCase(), identity: HEX64_B.toUpperCase() }),
    });
    const n = parseEscalationNotice(rumor);
    expect(n?.clientPubkey).toBe(HEX64_A);
    expect(n?.identityPubkey).toBe(HEX64_B);
  });

  it('rejects when method is missing or empty', () => {
    expect(parseEscalationNotice(baseRumor({ tags: approvalTags({ method: '' }) }))).toBeNull();
    const tags = approvalTags().filter(([k]) => k !== 'method');
    expect(parseEscalationNotice(baseRumor({ tags }))).toBeNull();
  });

  it('k is optional; a negative value is dropped, not rejecting the whole parse', () => {
    const rumor = baseRumor({ tags: [...approvalTags(), ['k', '-1']] });
    const n = parseEscalationNotice(rumor);
    expect(n).not.toBeNull();
    expect(n?.eventKind).toBeUndefined();
  });

  it('approval requires park (hex64) else null', () => {
    const withoutPark = approvalTags().filter(([k]) => k !== 'park');
    expect(parseEscalationNotice(baseRumor({ tags: withoutPark }))).toBeNull();
    expect(parseEscalationNotice(baseRumor({ tags: approvalTags({ park: 'not-hex' }) }))).toBeNull();
  });

  it('park-ttl is optional non-negative int; negative is dropped', () => {
    const rumor = baseRumor({ tags: [...approvalTags(), ['park-ttl', '-5']] });
    const n = parseEscalationNotice(rumor);
    expect(n).not.toBeNull();
    expect(n?.parkTtlSeconds).toBeUndefined();
  });

  it('petition: park is ignored/absent even if present', () => {
    const rumor = baseRumor({ tags: [...petitionTags(), ['park', HEX64_PARK]] });
    const n = parseEscalationNotice(rumor);
    expect(n).not.toBeNull();
    expect(n?.parkId).toBeUndefined();
  });

  it('petition: count is optional positive int; zero/negative dropped', () => {
    const zero = parseEscalationNotice(baseRumor({ tags: [...petitionTags(), ['count', '0']] }));
    expect(zero).not.toBeNull();
    expect(zero?.count).toBeUndefined();

    const negative = parseEscalationNotice(baseRumor({ tags: [...petitionTags(), ['count', '-2']] }));
    expect(negative).not.toBeNull();
    expect(negative?.count).toBeUndefined();

    const noCount = parseEscalationNotice(baseRumor({ tags: petitionTags() }));
    expect(noCount).not.toBeNull();
    expect(noCount?.count).toBeUndefined();
  });

  it('unknown extra tags are ignored', () => {
    const rumor = baseRumor({ tags: [...approvalTags(), ['k', '1'], ['park-ttl', '60'], ['mystery', 'value']] });
    const n = parseEscalationNotice(rumor);
    expect(n).not.toBeNull();
  });

  it('content is ignored', () => {
    const rumor = baseRumor({ tags: approvalTags(), content: 'anything goes here' });
    const n = parseEscalationNotice(rumor);
    expect(n).not.toBeNull();
  });

  it('rejects when kind does not match ESCALATION_EVENT_KIND', () => {
    const rumor = baseRumor({ kind: 31000, tags: approvalTags() });
    expect(parseEscalationNotice(rumor)).toBeNull();
  });
});

describe('coalesceNotices', () => {
  function notice(over: Partial<EscalationNotice>): EscalationNotice {
    return {
      id: 'shared-id',
      kind: 'approval',
      clientPubkey: HEX64_A,
      identityPubkey: HEX64_B,
      method: 'sign_event',
      createdAt: 100,
      ...over,
    };
  }

  it('keeps the highest createdAt for a duplicated id', () => {
    const older = notice({ createdAt: 100, parkId: HEX64_PARK });
    const newer = notice({ createdAt: 200, parkId: undefined });
    const out = coalesceNotices([older, newer]);
    expect(out).toHaveLength(1);
    expect(out[0].createdAt).toBe(200);
    expect(out[0].parkId).toBeUndefined();
  });

  it('keeps the first-seen entry on a tie', () => {
    const first = notice({ createdAt: 100, method: 'first' });
    const second = notice({ createdAt: 100, method: 'second' });
    const out = coalesceNotices([first, second]);
    expect(out).toHaveLength(1);
    expect(out[0].method).toBe('first');
  });

  it('returns distinct ids newest-first', () => {
    const a = notice({ id: 'a', createdAt: 100 });
    const b = notice({ id: 'b', createdAt: 300 });
    const c = notice({ id: 'c', createdAt: 200 });
    const out = coalesceNotices([a, b, c]);
    expect(out.map((n) => n.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('isParkExpired', () => {
  function approval(createdAt: number, parkTtlSeconds?: number): EscalationNotice {
    return {
      id: 'x',
      kind: 'approval',
      clientPubkey: HEX64_A,
      identityPubkey: HEX64_B,
      method: 'sign_event',
      parkId: HEX64_PARK,
      parkTtlSeconds,
      createdAt,
    };
  }

  it('true when createdAt + ttl < now', () => {
    const n = approval(1000, 60);
    expect(isParkExpired(n, 1061)).toBe(true);
  });

  it('false when createdAt + ttl >= now', () => {
    const n = approval(1000, 60);
    expect(isParkExpired(n, 1060)).toBe(false);
    expect(isParkExpired(n, 1000)).toBe(false);
  });

  it('false when no ttl is set', () => {
    const n = approval(1000, undefined);
    expect(isParkExpired(n, 999_999)).toBe(false);
  });

  it('petitions never expire this way', () => {
    const n: EscalationNotice = {
      id: 'x',
      kind: 'petition',
      clientPubkey: HEX64_A,
      identityPubkey: HEX64_B,
      method: 'sign_event',
      createdAt: 100,
      count: 5,
    };
    expect(isParkExpired(n, 999_999)).toBe(false);
  });
});

describe('unwrapEscalationNotice — real crypto path', () => {
  const guardianSk = generateSecretKey();
  const guardianSkHex = bytesToHex(guardianSk);
  const guardianPk = getPublicKey(guardianSk);

  function rumorTemplate(kindTag: string, kind = ESCALATION_EVENT_KIND) {
    return {
      kind,
      pubkey: guardianPk,
      created_at: 1_700_000_000,
      tags: [
        ['t', kindTag],
        ['d', `${HEX64_A}:sign_event`],
        ['client', HEX64_A],
        ['identity', HEX64_B],
        ['method', 'sign_event'],
        ['park', HEX64_PARK],
      ],
      content: '',
    };
  }

  it('positive: unwraps a real gift-wrapped approval notice', async () => {
    const wrap = await giftWrap(rumorTemplate('approval'), guardianPk, new LocalSigningBackend(guardianSkHex));
    const rumor = await unwrapEscalationNotice(wrap, new LocalSigningBackend(guardianSkHex), guardianPk);
    expect(rumor).not.toBeNull();
    expect(rumor?.kind).toBe(ESCALATION_EVENT_KIND);

    const parsed = parseEscalationNotice(rumor!);
    expect(parsed?.kind).toBe('approval');
    expect(parsed?.clientPubkey).toBe(HEX64_A);
  });

  it('negative: wrong rumor kind is rejected', async () => {
    const wrap = await giftWrap(rumorTemplate('approval', 31000), guardianPk, new LocalSigningBackend(guardianSkHex));
    const rumor = await unwrapEscalationNotice(wrap, new LocalSigningBackend(guardianSkHex), guardianPk);
    expect(rumor).toBeNull();
  });

  it('negative: disallowed t tag value (verify) is rejected', async () => {
    const wrap = await giftWrap(rumorTemplate('verify'), guardianPk, new LocalSigningBackend(guardianSkHex));
    const rumor = await unwrapEscalationNotice(wrap, new LocalSigningBackend(guardianSkHex), guardianPk);
    expect(rumor).toBeNull();
  });
});
