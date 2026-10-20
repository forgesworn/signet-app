import { describe, expect, it } from 'vitest';
import { keepAuthorPubkeys } from './keep-owner';

const NP = 'a1'.repeat(32), PERSONA = 'b2'.repeat(32), MASTER = 'c3'.repeat(32), LIVE = 'd4'.repeat(32);

describe('keepAuthorPubkeys', () => {
  it('local install: the slot keys only, even if a bunker address is lying around', () => {
    expect(keepAuthorPubkeys({ slotPubkeys: [NP, PERSONA], signingMode: 'local', bunkerUri: `bunker://${MASTER}?relay=wss://r` }).sort())
      .toEqual([NP, PERSONA].sort());
  });

  it('bunker install: adds the signer key from the stored address and the live connection', () => {
    const got = keepAuthorPubkeys({
      slotPubkeys: [NP, PERSONA], signingMode: 'bunker',
      bunkerUri: `bunker://${MASTER.toUpperCase()}?relay=wss%3A%2F%2Frelay.example&secret=x`, liveSignerPubkey: LIVE.toUpperCase(),
    });
    expect(got.sort()).toEqual([NP, PERSONA, MASTER, LIVE].sort());
  });

  it('bunker install, not yet connected and no usable address: just the slot keys; duplicates and junk dropped', () => {
    expect(keepAuthorPubkeys({ slotPubkeys: [NP, NP, 'junk', ''], signingMode: 'bunker', bunkerUri: 'bunker://nope', liveSignerPubkey: '' }))
      .toEqual([NP]);
  });
});
