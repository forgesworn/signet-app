import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CAPABILITIES, CAPABILITY_DESCRIPTIONS, DEFAULT_STALENESS_SECONDS,
  buildPairingUriV2, buildProjection, parsePairingAckV2, parsePairingRequestV2, parseProjection,
  parseProposalBatch, projectionTag, proposalTag, sanitizeWireText, scopedContactId,
} from '@forgesworn/signet-contacts/wire';
import type { Capability, ContactProjectionV2 } from '@forgesworn/signet-contacts/wire';

describe('@forgesworn/signet-contacts is resolvable from the app', () => {
  it('exposes the capability list and its descriptions', () => {
    expect(CAPABILITIES).toContain('signet.contacts.read:method:email');
    expect(CAPABILITIES).not.toContain('signet.contacts.read:methods');
    const cap: Capability = 'signet.contacts.read:directory';
    expect(CAPABILITY_DESCRIPTIONS[cap]).toMatch(/names.*pubkeys only/i);
    expect(DEFAULT_STALENESS_SECONDS).toBe(21600);
  });

  it('agrees with the SDK on the one sanitiser (R-6)', () => {
    // The shipped vectors, read from the installed package by path rather than
    // through the exports map (a JSON subpath is not exported, and a `file:`
    // install is a symlink `readFileSync` follows). If a future change to
    // either side moves the character class, this fails in BOTH repositories.
    const vectors = JSON.parse(readFileSync(
      'node_modules/@forgesworn/signet-contacts/vectors/sanitise.json', 'utf8',
    )) as { maxLen: number; pairs: { input: string; output: string }[] };
    expect(vectors.pairs.length).toBeGreaterThan(5);
    for (const { input, output } of vectors.pairs) {
      expect(sanitizeWireText(input, vectors.maxLen)).toBe(output);
    }
  });

  it('round-trips a pairing URI through the shared parser', () => {
    const nowSec = 1_700_000_000;
    const uri = buildPairingUriV2({
      appPubkey: 'a'.repeat(64), appName: 'Flock',
      capabilities: ['signet.contacts.read:directory'],
      directory: 'owner', relay: 'wss://relay.example.com', nowSec, challenge: 'D'.repeat(32),
    });
    expect(parsePairingRequestV2(uri, { nowSec }).request?.appName).toBe('Flock');
  });

  it('derives the routing tags the app will publish under', () => {
    const grantId = 'f'.repeat(32);
    expect(projectionTag(grantId)).toMatch(/^[0-9a-f]{32}$/);
    expect(proposalTag(grantId, 'a'.repeat(64))).not.toBe(projectionTag(grantId));
    expect(scopedContactId(grantId, 'contact-1')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('types a projection without redeclaring it app-side', () => {
    const projection: ContactProjectionV2 = {
      v: 2, grantId: 'f'.repeat(32),
      scopes: ['signet.contacts.read:directory'],
      frontier: { maxClock: 0, opCount: 0, publishedAt: 1, deviceId: '2'.repeat(32) },
      issuedAt: 1, expiresAt: 2, contacts: [],
    };
    expect(projection.v).toBe(2);
  });
});

/**
 * A/M5: three of the five frozen vectors were asserted on the SDK side only.
 * Parity rested on the app never re-implementing a wire serialisation — true
 * today, because every wire byte the app emits comes out of an SDK function,
 * but nothing pinned it. These read the SAME files the SDK's own
 * `vectors.test.ts` reads, from the installed package, and assert both
 * directions where a builder exists. A future app-side re-implementation, or
 * an unannounced SDK rebuild that moves the bytes, now fails here too.
 *
 * `projection.v2.json` carries a `regenerated` field: R-31 removed
 * `ownerPubkey`, the one authorised regeneration of this vector. These
 * assertions are written against the REGENERATED file, never hand-edited from
 * the old one.
 */
describe('frozen wire vectors, asserted app-side too (A/M5)', () => {
  const vector = (name: string): Record<string, never> => JSON.parse(readFileSync(
    `node_modules/@forgesworn/signet-contacts/vectors/${name}`, 'utf8',
  ));

  it('parses and rebuilds every projection case, with no owner pubkey anywhere (R-31)', () => {
    const v = vector('projection.v2.json') as unknown as {
      regenerated: string;
      malformed: string[];
      [k: string]: unknown;
    };
    // The regeneration is recorded in the file itself, so a silent second
    // regeneration is visible rather than inferred from a diff.
    expect(v.regenerated).toContain('ownerPubkey');
    for (const key of ['full', 'blocksOnly', 'revocation', 'truncated']) {
      const c = v[key] as { plaintext: string; parsed: ContactProjectionV2 };
      expect(parseProjection(c.plaintext), key).toEqual(c.parsed);
      expect(buildProjection(c.parsed), key).toBe(c.plaintext);
      expect(c.plaintext, key).not.toContain('ownerPubkey');
    }
    // Not every malformed case is fatal, and that is the point: a smuggled
    // `ownerPubkey` is not rejected, it is simply not a field of this wire, so
    // the parser drops it and no consumer ever sees it. Anything that DOES
    // parse must therefore carry none of it.
    const refused = v.malformed.filter((bad) => {
      const parsed = parseProjection(bad);
      if (parsed === null) return true;
      expect(JSON.stringify(parsed)).not.toContain('ownerPubkey');
      return false;
    });
    expect(refused.length).toBeGreaterThan(0);
  });

  it('parses the pairing request URI and the ack, and derives the same routing tags', () => {
    const v = vector('pairing.v2.json') as unknown as {
      nowSec: number;
      request: { uri: string; parsed: { appPubkey: string } };
      ack: { plaintext: string; parsed: { grantId: string; challenge: string }; wrongChallenge: string };
      tags: { projectionTag: string; proposalTag: string };
    };
    expect(parsePairingRequestV2(v.request.uri, { nowSec: v.nowSec }).request).toEqual(v.request.parsed);
    expect(parsePairingAckV2(v.ack.plaintext, v.ack.parsed.challenge)).toEqual(v.ack.parsed);
    // The challenge is the binding: an ack for a different pairing is refused.
    expect(parsePairingAckV2(v.ack.wrongChallenge, v.ack.parsed.challenge)).toBeNull();
    expect(projectionTag(v.ack.parsed.grantId)).toBe(v.tags.projectionTag);
    expect(proposalTag(v.ack.parsed.grantId, v.request.parsed.appPubkey)).toBe(v.tags.proposalTag);
  });

  it('parses the proposal batch and refuses every malformed case', () => {
    const v = vector('proposal.v1.json') as unknown as {
      batch: { plaintext: string; parsed: unknown };
      malformed: string[];
    };
    expect(parseProposalBatch(v.batch.plaintext)).toEqual(v.batch.parsed);
    // A malformed proposal INSIDE an otherwise valid batch is dropped rather
    // than failing the batch, so "refused" here means "nothing survives to be
    // acted on", not always "null".
    for (const bad of v.malformed) {
      const parsed = parseProposalBatch(bad);
      expect(parsed === null || parsed.proposals.length === 0, bad).toBe(true);
    }
  });
});
