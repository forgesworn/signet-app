import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent } from 'signet-protocol';
import type { DecryptingSigningBackend } from './signing-backend';

// Stub verifyEvent so tests can build synthetic seals without signing.
// Pass-4 added a verifySeal step to the unwrap path; the negative path
// (forged seal sig) is tested explicitly below.
vi.mock('nostr-tools/pure', async () => {
  const orig = await vi.importActual<typeof import('nostr-tools/pure')>('nostr-tools/pure');
  return { ...orig, verifyEvent: vi.fn(() => true) };
});

import { verifyEvent } from 'nostr-tools/pure';
import {
  unwrapAuditEvent,
  unwrapAuditEventWithKey,
  parseAuditRumor,
  summariseAudit,
  groupAuditByDay,
  type AuditRumor,
  type AuditEntry,
} from './audit-fetch';
import { AUDIT_EVENT_KIND } from './audit';

const GUARDIAN = 'a'.repeat(64);
const DEPENDANT = 'b'.repeat(64);
const COUNTERPARTY = 'c'.repeat(64);
const EPHEMERAL = 'd'.repeat(64);

/** Build a synthetic gift-wrap pointing at the given seal/rumor JSON. */
function makeWrap(content: string = '«wrap-ciphertext»'): NostrEvent {
  return {
    id: 'e'.repeat(64),
    pubkey: EPHEMERAL,
    created_at: 1_700_000_000,
    kind: 1059,
    tags: [['p', GUARDIAN]],
    content,
    sig: '0'.repeat(128),
  };
}

/** Build a stub backend whose decrypt returns scripted plaintexts in order. */
function backendWithDecrypts(plaintexts: Array<string | Error>): DecryptingSigningBackend {
  const queue = [...plaintexts];
  const decrypt = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('decrypt called more times than scripted');
    if (next instanceof Error) throw next;
    return next;
  });
  return {
    type: 'local',
    activePublicKeyHex: GUARDIAN,
    signEvent: vi.fn(async () => { throw new Error('not used'); }),
    nip44Encrypt: vi.fn(async () => { throw new Error('not used'); }),
    nip44Decrypt: decrypt,
    destroy: vi.fn(),
  } as unknown as DecryptingSigningBackend;
}

/** Synthetic NIP-17 seal in the shape audit-fetch's verifySeal expects.
 *  verifyEvent is mocked at module scope so the signature itself can be
 *  bogus — flip the mock to false to exercise the rejection path. */
function buildSeal(overrides: Partial<{
  id: string; pubkey: string; sig: string; kind: number;
  created_at: number; tags: string[][]; content: string;
}> = {}): Record<string, unknown> {
  return {
    id: 's'.repeat(64),
    pubkey: GUARDIAN,
    sig: '0'.repeat(128),
    kind: 13,
    created_at: 1_700_000_000,
    tags: [],
    content: 'rumor-cipher',
    ...overrides,
  };
}

function buildRumor(overrides: Partial<AuditRumor> = {}): AuditRumor {
  return {
    id: 'r'.repeat(64),
    pubkey: GUARDIAN,
    created_at: 1_700_000_000,
    kind: AUDIT_EVENT_KIND,
    content: '',
    tags: [
      ['t', 'audit'],
      ['d', `${DEPENDANT}:1700000000000`],
      ['k', '22242'],
      ['outcome', 'approved'],
    ],
    ...overrides,
  };
}

describe('unwrapAuditEvent', () => {
  it('decrypts wrap → seal → audit rumor and returns it', async () => {
    const rumor = buildRumor();
    const seal = buildSeal();
    const backend = backendWithDecrypts([
      JSON.stringify(seal),
      JSON.stringify(rumor),
    ]);
    const out = await unwrapAuditEvent(makeWrap(), backend, GUARDIAN);
    expect(out).not.toBeNull();
    expect(out?.kind).toBe(AUDIT_EVENT_KIND);
  });

  it('returns null when the outer wrap NIP-44 decrypt fails', async () => {
    const backend = backendWithDecrypts([new Error('boom')]);
    const out = await unwrapAuditEvent(makeWrap(), backend, GUARDIAN);
    expect(out).toBeNull();
  });

  it('returns null when the inner rumor decrypt fails', async () => {
    const seal = buildSeal();
    const backend = backendWithDecrypts([
      JSON.stringify(seal),
      new Error('boom-inner'),
    ]);
    const out = await unwrapAuditEvent(makeWrap(), backend, GUARDIAN);
    expect(out).toBeNull();
  });

  it('returns null when the rumor is the wrong kind (e.g. a DM)', async () => {
    const rumor = buildRumor({ kind: 14 });
    const seal = buildSeal();
    const backend = backendWithDecrypts([
      JSON.stringify(seal),
      JSON.stringify(rumor),
    ]);
    const out = await unwrapAuditEvent(makeWrap(), backend, GUARDIAN);
    expect(out).toBeNull();
  });

  it('returns null when the rumor lacks the t:audit marker', async () => {
    const rumor = buildRumor({
      tags: [['d', `${DEPENDANT}:1`], ['k', '22242'], ['outcome', 'approved']],
    });
    const seal = buildSeal();
    const backend = backendWithDecrypts([
      JSON.stringify(seal),
      JSON.stringify(rumor),
    ]);
    const out = await unwrapAuditEvent(makeWrap(), backend, GUARDIAN);
    expect(out).toBeNull();
  });

  it('returns null when the wrap is not kind 1059', async () => {
    const wrong = { ...makeWrap(), kind: 1 };
    const backend = backendWithDecrypts([]);
    const out = await unwrapAuditEvent(wrong as NostrEvent, backend, GUARDIAN);
    expect(out).toBeNull();
  });

  it('returns null when the seal carries an invalid BIP-340 signature (audit-4)', async () => {
    // Forged gift-wrap: the seal claims `pubkey = GUARDIAN` and trusted
    // tags, but the sig was synthesised by an attacker. verifyEvent
    // returns false → unwrap must reject before trusting the seal's
    // pubkey or any of its contents.
    const rumor = buildRumor();
    const seal = buildSeal();
    const backend = backendWithDecrypts([
      JSON.stringify(seal),
      JSON.stringify(rumor),
    ]);
    (verifyEvent as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    const out = await unwrapAuditEvent(makeWrap(), backend, GUARDIAN);
    expect(out).toBeNull();
  });

  it('returns null when the seal is not kind 13 (audit-4)', async () => {
    const rumor = buildRumor();
    const seal = buildSeal({ kind: 1 });
    const backend = backendWithDecrypts([
      JSON.stringify(seal),
      JSON.stringify(rumor),
    ]);
    const out = await unwrapAuditEvent(makeWrap(), backend, GUARDIAN);
    expect(out).toBeNull();
  });

  // ── C1: seal/rumor signer must match the trusted guardian pubkey ─────────

  it('rejects a seal self-signed by a random throwaway key impersonating the guardian (C1)', async () => {
    // Forgery scenario: an attacker self-signs a VALID kind-13 seal (so
    // verifyEvent passes) with their own throwaway key, wrapping a fake
    // kind-31000 rumor. Without a signer allowlist this would render as
    // genuine child activity.
    const forger = 'f'.repeat(64);
    const rumor = buildRumor({ pubkey: forger });
    const seal = buildSeal({ pubkey: forger });
    const backend = backendWithDecrypts([
      JSON.stringify(seal),
      JSON.stringify(rumor),
    ]);
    const out = await unwrapAuditEvent(makeWrap(), backend, GUARDIAN);
    expect(out).toBeNull();
  });

  it('rejects when the seal is signed by the guardian but the inner rumor claims a different pubkey', async () => {
    const forger = 'f'.repeat(64);
    const rumor = buildRumor({ pubkey: forger });
    const seal = buildSeal(); // seal.pubkey = GUARDIAN
    const backend = backendWithDecrypts([
      JSON.stringify(seal),
      JSON.stringify(rumor),
    ]);
    const out = await unwrapAuditEvent(makeWrap(), backend, GUARDIAN);
    expect(out).toBeNull();
  });

  it('accepts a seal genuinely signed by the expected guardian pubkey', async () => {
    const rumor = buildRumor();
    const seal = buildSeal();
    const backend = backendWithDecrypts([
      JSON.stringify(seal),
      JSON.stringify(rumor),
    ]);
    const out = await unwrapAuditEvent(makeWrap(), backend, GUARDIAN);
    expect(out).not.toBeNull();
  });

  it('rejects when expectedSignerPubkey is malformed', async () => {
    const rumor = buildRumor();
    const seal = buildSeal();
    const backend = backendWithDecrypts([
      JSON.stringify(seal),
      JSON.stringify(rumor),
    ]);
    const out = await unwrapAuditEvent(makeWrap(), backend, 'not-hex');
    expect(out).toBeNull();
  });
});

describe('unwrapAuditEventWithKey', () => {
  // 64-char hex, valid format. Real nip44Decrypt will fail with an
  // unrelated cipher payload — we want null, not a throw, on every
  // structural mismatch and decrypt error. The full positive path is
  // implicitly covered by the guardian-side `unwrapAuditEvent` tests
  // and the production round-trip; here we focus on the error-paths
  // that distinguish the key-based path from the backend-based one.
  const VALID_PRIVKEY = '1'.repeat(64);

  it('returns null when the wrap is not kind 1059', async () => {
    const wrong = { ...makeWrap(), kind: 1 };
    const out = await unwrapAuditEventWithKey(wrong as NostrEvent, VALID_PRIVKEY, GUARDIAN);
    expect(out).toBeNull();
  });

  it('returns null when the outer NIP-44 decrypt fails', async () => {
    // Wrap content is a placeholder string, not real ciphertext. The
    // decrypt step will throw; we expect a clean null rather than the
    // throw bubbling up to the caller.
    const out = await unwrapAuditEventWithKey(makeWrap('not-real-ciphertext'), VALID_PRIVKEY, GUARDIAN);
    expect(out).toBeNull();
  });

  it('returns null when the wrap is missing required fields', async () => {
    // Cast to any so we can construct a structurally-broken event.
    const broken = { ...makeWrap(), pubkey: 123 as unknown as string };
    const out = await unwrapAuditEventWithKey(broken as NostrEvent, VALID_PRIVKEY, GUARDIAN);
    expect(out).toBeNull();
  });

  it('returns null when expectedSignerPubkey is malformed', async () => {
    const out = await unwrapAuditEventWithKey(makeWrap('anything'), VALID_PRIVKEY, 'not-hex');
    expect(out).toBeNull();
  });
});

describe('parseAuditRumor', () => {
  it('parses a full sign-in rumor', () => {
    const rumor = buildRumor({
      tags: [
        ['t', 'audit'],
        ['d', `${DEPENDANT}:1700000000000`],
        ['k', '22242'],
        ['outcome', 'approved'],
        ['origin', 'https://fathom.example'],
      ],
    });
    const e = parseAuditRumor(rumor);
    expect(e).not.toBeNull();
    expect(e?.dependantPubkey).toBe(DEPENDANT);
    expect(e?.eventKind).toBe(22242);
    expect(e?.outcome).toBe('approved');
    expect(e?.origin).toBe('https://fathom.example');
  });

  it('parses a DM rumor with counterparty pubkey', () => {
    const rumor = buildRumor({
      tags: [
        ['t', 'audit'],
        ['d', `${DEPENDANT}:1700000000001`],
        ['k', '4'],
        ['outcome', 'approved'],
        ['p', COUNTERPARTY],
      ],
    });
    const e = parseAuditRumor(rumor);
    expect(e?.eventKind).toBe(4);
    expect(e?.counterpartyPubkey).toBe(COUNTERPARTY);
    expect(e?.origin).toBeUndefined();
  });

  it('parses a ceremony-complete rumor (no k tag)', () => {
    const rumor = buildRumor({
      tags: [
        ['t', 'audit'],
        ['d', `${DEPENDANT}:1700000000002`],
        ['outcome', 'ceremony-complete'],
      ],
    });
    const e = parseAuditRumor(rumor);
    expect(e?.outcome).toBe('ceremony-complete');
    expect(e?.eventKind).toBeUndefined();
  });

  it('returns null when t:audit is missing', () => {
    const rumor = buildRumor({
      tags: [
        ['d', `${DEPENDANT}:1`],
        ['k', '1'],
        ['outcome', 'approved'],
      ],
    });
    expect(parseAuditRumor(rumor)).toBeNull();
  });

  it('returns null when the d tag is missing or malformed', () => {
    const r1 = buildRumor({ tags: [['t', 'audit'], ['k', '1'], ['outcome', 'approved']] });
    expect(parseAuditRumor(r1)).toBeNull();
    const r2 = buildRumor({
      tags: [['t', 'audit'], ['d', 'no-colon'], ['k', '1'], ['outcome', 'approved']],
    });
    expect(parseAuditRumor(r2)).toBeNull();
  });

  it('returns null when the outcome tag is unrecognised', () => {
    const rumor = buildRumor({
      tags: [
        ['t', 'audit'],
        ['d', `${DEPENDANT}:1`],
        ['k', '1'],
        ['outcome', 'maybe'],
      ],
    });
    expect(parseAuditRumor(rumor)).toBeNull();
  });

  it('round-trips a clause-blocked rumor (audit-3 regression)', () => {
    // isAuditOutcome previously omitted 'clause-blocked' from its allowlist,
    // so charter-block audit entries were silently dropped by the consumer.
    const rumor = buildRumor({
      tags: [
        ['t', 'audit'],
        ['d', `${DEPENDANT}:1700000000099`],
        ['k', '22242'],
        ['outcome', 'clause-blocked'],
        ['origin', 'https://blocked.example'],
      ],
    });
    const e = parseAuditRumor(rumor);
    expect(e).not.toBeNull();
    expect(e?.outcome).toBe('clause-blocked');
  });

  it('uses the d-tag prefix as the dependantPubkey, lowercasing it', () => {
    const upper = DEPENDANT.toUpperCase();
    const rumor = buildRumor({
      tags: [
        ['t', 'audit'],
        ['d', `${upper}:42`],
        ['k', '1'],
        ['outcome', 'approved'],
      ],
    });
    const e = parseAuditRumor(rumor);
    expect(e?.dependantPubkey).toBe(DEPENDANT);
  });
});

describe('summariseAudit', () => {
  function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
    return {
      id: `${DEPENDANT}:1`,
      dependantPubkey: DEPENDANT,
      createdAt: 1_700_000_000,
      outcome: 'approved',
      eventKind: 22242,
      ...overrides,
    };
  }

  it('summarises sign-in with origin', () => {
    expect(summariseAudit(entry({ origin: 'https://fathom.example' }), 'Alex'))
      .toBe('Signed in to fathom.example');
  });

  it('summarises sign-in without origin', () => {
    expect(summariseAudit(entry({ origin: undefined }), 'Alex'))
      .toBe('Signed in');
  });

  it('marks auto-approved sign-ins', () => {
    expect(summariseAudit(entry({ outcome: 'auto-approved', origin: 'https://x.test' }), 'Alex'))
      .toBe('Signed in to x.test (auto-approved)');
  });

  it('marks denied sign-ins', () => {
    expect(summariseAudit(entry({ outcome: 'denied', origin: 'https://x.test' }), 'Alex'))
      .toBe('Signed in to x.test (denied)');
  });

  it('summarises DMs without exposing counterparty pubkey', () => {
    const out = summariseAudit(entry({ eventKind: 4, counterpartyPubkey: COUNTERPARTY }), 'Alex');
    expect(out).toBe('Sent a direct message');
    expect(out).not.toContain(COUNTERPARTY);
    expect(out).not.toContain(COUNTERPARTY.slice(0, 16));
  });

  it('summarises credential issuance (kind 30470)', () => {
    expect(summariseAudit(entry({ eventKind: 30470 }), 'Alex'))
      .toBe('Issued a credential');
  });

  it('summarises ceremony-complete', () => {
    expect(summariseAudit(entry({ outcome: 'ceremony-complete', eventKind: undefined }), 'Alex'))
      .toBe('Transition to independent identity completed');
  });

  it('falls back to a generic kind label for unknown kinds', () => {
    expect(summariseAudit(entry({ eventKind: 9999 }), 'Alex'))
      .toBe('Signed a kind-9999 event');
  });
});

describe('groupAuditByDay', () => {
  function at(date: string, idSuffix: string): AuditEntry {
    return {
      id: `${DEPENDANT}:${idSuffix}`,
      dependantPubkey: DEPENDANT,
      createdAt: Math.floor(new Date(date).getTime() / 1000),
      outcome: 'approved',
      eventKind: 22242,
    };
  }

  it('returns an empty array for no entries', () => {
    expect(groupAuditByDay([], new Date('2026-05-04T12:00:00Z'))).toEqual([]);
  });

  it('groups single-day entries under "Today"', () => {
    const now = new Date('2026-05-04T20:00:00');
    const e = at('2026-05-04T08:00:00', '1');
    const groups = groupAuditByDay([e], now);
    expect(groups).toHaveLength(1);
    expect(groups[0].dayLabel).toBe('Today');
    expect(groups[0].entries).toHaveLength(1);
  });

  it('groups across Today / Yesterday / older days', () => {
    const now = new Date('2026-05-04T20:00:00');
    const e1 = at('2026-05-04T08:00:00', '1');  // Today
    const e2 = at('2026-05-03T11:00:00', '2');  // Yesterday
    const e3 = at('2026-04-28T11:00:00', '3');  // a Tuesday-ish
    const groups = groupAuditByDay([e2, e3, e1], now); // unsorted on input
    expect(groups[0].dayLabel).toBe('Today');
    expect(groups[1].dayLabel).toBe('Yesterday');
    expect(groups[2].dayLabel).not.toBe('Today');
    expect(groups[2].dayLabel).not.toBe('Yesterday');
  });

  it('preserves descending order within a day', () => {
    const now = new Date('2026-05-04T20:00:00');
    const a = at('2026-05-04T08:00:00', 'a');
    const b = at('2026-05-04T14:00:00', 'b');
    const c = at('2026-05-04T11:00:00', 'c');
    const groups = groupAuditByDay([a, b, c], now);
    expect(groups[0].entries.map(e => e.id)).toEqual([b.id, c.id, a.id]);
  });
});
