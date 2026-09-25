import { describe, it, expect } from 'vitest';
import { detectDrift } from './drift-detection';
import type { ConsumerHint, OriginPolicy } from '../types';

const now = Math.floor(Date.now() / 1000);

function mem(allows: Array<ConsumerHint['allow']>): OriginPolicy {
  return {
    origin: 'https://example.com',
    lastKeypair: 'persona',
    lastUsed: now,
    pinned: false,
    userOverrode: false,
    acceptHistory: allows.map((allow, i) => ({ at: now - (allows.length - i) * 60, allow })),
  };
}

describe('detectDrift', () => {
  it('returns null when there is no memory', () => {
    expect(detectDrift({ allow: ['persona'] }, null)).toBeNull();
    expect(detectDrift(null, null)).toBeNull();
  });

  it('returns null when memory has less than 3 entries', () => {
    const m = mem([['persona'], ['persona']]);
    expect(detectDrift({ allow: ['natural-person'] }, m)).toBeNull();
  });

  it('persona→NP drift fires when last 3 were persona and current is NP', () => {
    const m = mem([['persona'], ['persona'], ['persona']]);
    const signal = detectDrift({ allow: ['natural-person'] }, m);
    expect(signal?.kind).toBe('persona-to-np');
  });

  it('persona→none drift fires when last 3 were persona and current sends no hint', () => {
    const m = mem([['persona'], ['persona'], ['persona']]);
    expect(detectDrift(null, m)?.kind).toBe('persona-to-none');
  });

  it('stays silent when history has mixed shapes', () => {
    const m = mem([['persona'], [], ['persona']]);
    expect(detectDrift({ allow: ['natural-person'] }, m)).toBeNull();
  });

  it('stays silent when current hint is also persona-shaped (no drift)', () => {
    const m = mem([['persona'], ['persona'], ['persona']]);
    expect(detectDrift({ allow: ['persona'] }, m)).toBeNull();
  });

  it('first-time NP request fires when no memory and hint is NP-shaped', () => {
    const signal = detectDrift({ allow: ['natural-person'] }, null);
    expect(signal?.kind).toBe('first-np-request');
  });

  it('first-time request with persona hint stays silent', () => {
    expect(detectDrift({ allow: ['persona'] }, null)).toBeNull();
  });

  it('persona+extra-persona counts as persona-shaped in history', () => {
    const m = mem([
      ['persona', 'extra-persona'],
      ['persona', 'extra-persona'],
      ['persona', 'extra-persona'],
    ]);
    expect(detectDrift({ allow: ['natural-person'] }, m)?.kind).toBe('persona-to-np');
  });
});
