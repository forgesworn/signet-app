// Tests for signet-me.ts
// Pure-logic module: no mocking required. Tests cover directional word
// generation, expiry countdown, echo-attack prevention (A != B), clock-skew
// tolerance, and the verify function.

import { describe, it, expect } from 'vitest';
import { getSignetMeDisplay, verifySignetMe } from './signet-me';

// Deterministic inputs.
// spoken-token normalises a string secret as hex, so it must be an even-length
// hex string (32 bytes = 64 chars minimum). Use a 64-char all-hex string.
const SHARED_SECRET = 'deadbeef'.repeat(8); // 64 hex chars = 32 bytes
const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);

// Fix the clock to the middle of a 30-second epoch so results are stable
// and we can reason about expiresIn deterministically.
const EPOCH_MS = 30_000;
const FIXED_NOW_MS = EPOCH_MS * 100 + 15_000; // 15 s into epoch 100

// -------------------------------------------------------------------------
describe('getSignetMeDisplay — basic shape', () => {
  it('returns an object with myWords, theirWords, and expiresIn', () => {
    const display = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, FIXED_NOW_MS);
    expect(Array.isArray(display.myWords)).toBe(true);
    expect(Array.isArray(display.theirWords)).toBe(true);
    expect(typeof display.expiresIn).toBe('number');
  });

  it('returns exactly wordCount words by default (1)', () => {
    const display = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, FIXED_NOW_MS);
    expect(display.myWords).toHaveLength(1);
    expect(display.theirWords).toHaveLength(1);
  });

  it('returns two words when wordCount is 2', () => {
    const display = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 2, FIXED_NOW_MS);
    expect(display.myWords).toHaveLength(2);
    expect(display.theirWords).toHaveLength(2);
  });
});

describe('getSignetMeDisplay — directionality (echo-attack prevention)', () => {
  it('A and B see different "my" words for the same secret', () => {
    const forA = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, FIXED_NOW_MS);
    const forB = getSignetMeDisplay(SHARED_SECRET, PUBKEY_B, PUBKEY_A, 1, FIXED_NOW_MS);
    // A's myWords should equal B's theirWords and vice versa
    expect(forA.myWords.join(' ')).toBe(forB.theirWords.join(' '));
    expect(forB.myWords.join(' ')).toBe(forA.theirWords.join(' '));
  });

  it('myWords and theirWords are different (no echo)', () => {
    const display = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, FIXED_NOW_MS);
    expect(display.myWords.join(' ')).not.toBe(display.theirWords.join(' '));
  });
});

describe('getSignetMeDisplay — determinism', () => {
  it('returns the same words for the same inputs', () => {
    const first = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, FIXED_NOW_MS);
    const second = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, FIXED_NOW_MS);
    expect(first.myWords).toEqual(second.myWords);
    expect(first.theirWords).toEqual(second.theirWords);
  });

  it('changes words when the epoch changes', () => {
    const epoch0 = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, EPOCH_MS * 0 + 1);
    const epoch1 = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, EPOCH_MS * 1 + 1);
    expect(epoch0.myWords.join(' ')).not.toBe(epoch1.myWords.join(' '));
  });

  it('returns the same words within the same 30-second epoch', () => {
    const start = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, EPOCH_MS * 5 + 0);
    const mid   = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, EPOCH_MS * 5 + 14_999);
    expect(start.myWords).toEqual(mid.myWords);
  });
});

describe('getSignetMeDisplay — expiresIn', () => {
  it('is between 1 and 30 (inclusive)', () => {
    const display = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, FIXED_NOW_MS);
    expect(display.expiresIn).toBeGreaterThanOrEqual(1);
    expect(display.expiresIn).toBeLessThanOrEqual(30);
  });

  it('is approximately 15 s when now is mid-epoch', () => {
    // FIXED_NOW_MS = 15_000 ms into epoch → 15 s remaining
    const display = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, FIXED_NOW_MS);
    expect(display.expiresIn).toBe(15);
  });

  it('is 30 s when now is exactly at epoch boundary', () => {
    const atBoundary = EPOCH_MS * 10; // 0 ms into epoch → ceil(30000/1000) = 30
    const display = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, atBoundary);
    expect(display.expiresIn).toBe(30);
  });

  it('is 1 s when now is 1 ms before the next epoch', () => {
    const nearEnd = EPOCH_MS * 10 - 1; // 1 ms remaining → ceil(1/1000) = 1
    const display = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, nearEnd);
    expect(display.expiresIn).toBe(1);
  });
});

// -------------------------------------------------------------------------
describe('verifySignetMe — correct words pass', () => {
  it('verifies the correct words at the same time', () => {
    const { theirWords } = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, FIXED_NOW_MS);
    const ok = verifySignetMe(SHARED_SECRET, PUBKEY_A, PUBKEY_B, theirWords, 1, FIXED_NOW_MS);
    expect(ok).toBe(true);
  });

  it('verifies two-word tokens', () => {
    const { theirWords } = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 2, FIXED_NOW_MS);
    const ok = verifySignetMe(SHARED_SECRET, PUBKEY_A, PUBKEY_B, theirWords, 2, FIXED_NOW_MS);
    expect(ok).toBe(true);
  });
});

describe('verifySignetMe — wrong words fail', () => {
  it('rejects words from a different shared secret', () => {
    const { theirWords } = getSignetMeDisplay('cafecafe'.repeat(8), PUBKEY_A, PUBKEY_B, 1, FIXED_NOW_MS);
    const ok = verifySignetMe(SHARED_SECRET, PUBKEY_A, PUBKEY_B, theirWords, 1, FIXED_NOW_MS);
    expect(ok).toBe(false);
  });

  it('rejects the local "my" words (echo-attack guard)', () => {
    const { myWords } = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, FIXED_NOW_MS);
    // Verifying MY own words against theirPubkey slot should fail
    const ok = verifySignetMe(SHARED_SECRET, PUBKEY_A, PUBKEY_B, myWords, 1, FIXED_NOW_MS);
    expect(ok).toBe(false);
  });

  it('rejects completely wrong words', () => {
    const ok = verifySignetMe(SHARED_SECRET, PUBKEY_A, PUBKEY_B, ['zzz'], 1, FIXED_NOW_MS);
    expect(ok).toBe(false);
  });
});

describe('verifySignetMe — clock-skew tolerance', () => {
  // The implementation checks ±1 epoch (DEFAULT_TOLERANCE = 1).
  it('accepts words from the previous epoch', () => {
    // Generate words for epoch 99, verify at the start of epoch 100
    const prevEpochNow = EPOCH_MS * 99 + 5_000;
    const { theirWords } = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, prevEpochNow);
    const nextEpochNow = EPOCH_MS * 100 + 1;
    const ok = verifySignetMe(SHARED_SECRET, PUBKEY_A, PUBKEY_B, theirWords, 1, nextEpochNow);
    expect(ok).toBe(true);
  });

  it('accepts words from the next epoch', () => {
    // Generate words for epoch 101, verify at the end of epoch 100
    const nextEpochNow = EPOCH_MS * 101 + 1;
    const { theirWords } = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, nextEpochNow);
    const currentEpochNow = EPOCH_MS * 100 + 28_000;
    const ok = verifySignetMe(SHARED_SECRET, PUBKEY_A, PUBKEY_B, theirWords, 1, currentEpochNow);
    expect(ok).toBe(true);
  });

  it('rejects words from two epochs ago (beyond tolerance)', () => {
    const twoEpochsAgo = EPOCH_MS * 98 + 1;
    const { theirWords } = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, twoEpochsAgo);
    const ok = verifySignetMe(SHARED_SECRET, PUBKEY_A, PUBKEY_B, theirWords, 1, FIXED_NOW_MS);
    expect(ok).toBe(false);
  });
});

describe('verifySignetMe — case and whitespace normalisation', () => {
  it('accepts words regardless of letter case', () => {
    const { theirWords } = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, FIXED_NOW_MS);
    const upper = theirWords.map(w => w.toUpperCase());
    const ok = verifySignetMe(SHARED_SECRET, PUBKEY_A, PUBKEY_B, upper, 1, FIXED_NOW_MS);
    expect(ok).toBe(true);
  });

  it('accepts words with surrounding whitespace', () => {
    const { theirWords } = getSignetMeDisplay(SHARED_SECRET, PUBKEY_A, PUBKEY_B, 1, FIXED_NOW_MS);
    const padded = theirWords.map(w => `  ${w}  `);
    const ok = verifySignetMe(SHARED_SECRET, PUBKEY_A, PUBKEY_B, padded, 1, FIXED_NOW_MS);
    expect(ok).toBe(true);
  });
});
