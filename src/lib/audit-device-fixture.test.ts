/**
 * C5 device-format fixture test (§11.1.6, CP5 guardrail).
 *
 * Deliberately a NEW test file: audit-fetch.test.ts installs a repo-wide
 * mock of `nostr-tools/pure`'s `verifyEvent`, which would make the
 * "author gate" test below meaningless. This file mocks nothing — every
 * rumor here goes through a REAL `giftWrap` (real NIP-44 seal + wrap) and
 * a REAL `unwrapAuditEvent` (real NIP-44 decrypt + real BIP-340
 * `verifyEvent` on the seal).
 *
 * The rumor builder below (`deviceAuditRumor`) is intentionally NOT
 * imported from `audit.ts` — it mirrors the ratified C5 schema §2
 * independently, so a pass here is proof of byte-compatibility between
 * the schema and the consumer, not just proof that the consumer can
 * read its own producer's output.
 */
import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import { giftWrap } from './relay-publish';
import { LocalSigningBackend } from './signing-backend';
import { unwrapAuditEvent, parseAuditRumor } from './audit-fetch';

// Device-format rumor builder — mirrors the C5 schema §2, NOT audit.ts
// (the point is byte-compat of an independently-constructed shape).
function deviceAuditRumor(guardianPk: string, depPk: string, opts: {
  createdAt: number; counter: number; outcome: string;
  eventKind?: number; method?: string; counterparty?: string;
}) {
  const tags: string[][] = [
    ['t', 'audit'],
    ['d', `${depPk}:${opts.createdAt * 1000 + opts.counter}`],
  ];
  if (opts.eventKind !== undefined) tags.push(['k', String(opts.eventKind)]);
  if (opts.method) tags.push(['method', opts.method]);
  tags.push(['outcome', opts.outcome]);
  if (opts.counterparty) tags.push(['p', opts.counterparty]);
  return { kind: 31000, pubkey: guardianPk, created_at: opts.createdAt, tags, content: '' };
}

describe('C5 device-format fixture — real crypto path', () => {
  const guardianSk = generateSecretKey();
  const guardianSkHex = bytesToHex(guardianSk);
  const guardianPk = getPublicKey(guardianSk);
  const depPk = getPublicKey(generateSecretKey());

  const createdAt = 1_700_000_000;

  it('1. silent sign_event outcome round-trips with matching device id', async () => {
    const rumorTemplate = deviceAuditRumor(guardianPk, depPk, {
      createdAt,
      counter: 3,
      outcome: 'auto-approved',
      eventKind: 1,
    });

    const wrap = await giftWrap(rumorTemplate, guardianPk, new LocalSigningBackend(guardianSkHex));
    const rumor = await unwrapAuditEvent(wrap, new LocalSigningBackend(guardianSkHex), guardianPk);
    expect(rumor).not.toBeNull();

    const entry = parseAuditRumor(rumor!);
    expect(entry).not.toBeNull();
    expect(entry!.dependantPubkey).toBe(depPk);
    expect(entry!.outcome).toBe('auto-approved');
    expect(entry!.eventKind).toBe(1);
    expect(entry!.origin).toBeUndefined();
    expect(entry!.id).toBe(`${depPk}:${createdAt * 1000 + 3}`);
  });

  it('2. transport outcome, method-only (no k) — no eventKind, still round-trips', async () => {
    const rumorTemplate = deviceAuditRumor(guardianPk, depPk, {
      createdAt,
      counter: 7,
      outcome: 'auto-denied',
      method: 'nip44_decrypt',
    });

    const wrap = await giftWrap(rumorTemplate, guardianPk, new LocalSigningBackend(guardianSkHex));
    const rumor = await unwrapAuditEvent(wrap, new LocalSigningBackend(guardianSkHex), guardianPk);
    expect(rumor).not.toBeNull();

    const entry = parseAuditRumor(rumor!);
    expect(entry).not.toBeNull();
    expect(entry!.eventKind).toBeUndefined();
    expect(entry!.outcome).toBe('auto-denied');
    expect(entry!.id).toBe(`${depPk}:${createdAt * 1000 + 7}`);
  });

  it('3. C4-resolved outcomes — approved and denied are both accepted', async () => {
    for (const [counter, outcome] of [[11, 'approved'], [12, 'denied']] as const) {
      const rumorTemplate = deviceAuditRumor(guardianPk, depPk, {
        createdAt,
        counter,
        outcome,
        eventKind: 22242,
      });

      const wrap = await giftWrap(rumorTemplate, guardianPk, new LocalSigningBackend(guardianSkHex));
      const rumor = await unwrapAuditEvent(wrap, new LocalSigningBackend(guardianSkHex), guardianPk);
      expect(rumor).not.toBeNull();

      const entry = parseAuditRumor(rumor!);
      expect(entry).not.toBeNull();
      expect(entry!.outcome).toBe(outcome);
    }
  });

  it('4. counterparty p tag round-trips lowercased', async () => {
    const counterparty = getPublicKey(generateSecretKey());
    const rumorTemplate = deviceAuditRumor(guardianPk, depPk, {
      createdAt,
      counter: 21,
      outcome: 'approved',
      eventKind: 4,
      counterparty: counterparty.toUpperCase(),
    });

    const wrap = await giftWrap(rumorTemplate, guardianPk, new LocalSigningBackend(guardianSkHex));
    const rumor = await unwrapAuditEvent(wrap, new LocalSigningBackend(guardianSkHex), guardianPk);
    expect(rumor).not.toBeNull();

    const entry = parseAuditRumor(rumor!);
    expect(entry).not.toBeNull();
    expect(entry!.counterpartyPubkey).toBe(counterparty.toLowerCase());
  });

  it('5. author gate — a rumor sealed by an attacker keypair is rejected by real verifyEvent', async () => {
    const attackerSk = generateSecretKey();
    const attackerSkHex = bytesToHex(attackerSk);

    // Attacker crafts a rumor that CLAIMS to be authored by the guardian
    // (rumor.pubkey = guardianPk) but seals/wraps it with their own key,
    // addressed to the guardian so it lands in the same inbox.
    const rumorTemplate = deviceAuditRumor(guardianPk, depPk, {
      createdAt,
      counter: 99,
      outcome: 'auto-approved',
      eventKind: 1,
    });

    const wrap = await giftWrap(rumorTemplate, guardianPk, new LocalSigningBackend(attackerSkHex));
    const rumor = await unwrapAuditEvent(wrap, new LocalSigningBackend(guardianSkHex), guardianPk);
    expect(rumor).toBeNull();
  });

  it('6. dependant filter — parsed dependantPubkey matches the fixture dep key for equality filtering', async () => {
    const rumorTemplate = deviceAuditRumor(guardianPk, depPk, {
      createdAt,
      counter: 42,
      outcome: 'approved',
      eventKind: 1,
    });

    const wrap = await giftWrap(rumorTemplate, guardianPk, new LocalSigningBackend(guardianSkHex));
    const rumor = await unwrapAuditEvent(wrap, new LocalSigningBackend(guardianSkHex), guardianPk);
    expect(rumor).not.toBeNull();

    const entry = parseAuditRumor(rumor!);
    expect(entry).not.toBeNull();
    expect(entry!.dependantPubkey).toBe(depPk);
    // useAuditLog filters entries by `entry.dependantPubkey === selectedDep`.
    const selectedDep = depPk;
    expect(entry!.dependantPubkey === selectedDep).toBe(true);
  });
});
