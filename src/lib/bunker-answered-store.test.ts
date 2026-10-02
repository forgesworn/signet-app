// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { markAnswered, wasAnswered } from './bunker-answered-store';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('bunker-answered-store', () => {
  beforeEach(() => localStorage.clear());

  it('remembers an answered event id', () => {
    expect(wasAnswered(A)).toBe(false);
    markAnswered(A);
    expect(wasAnswered(A)).toBe(true);
    expect(wasAnswered(B)).toBe(false);
  });

  it('forgets entries after ten minutes', () => {
    markAnswered(A, localStorage, 1_000);
    expect(wasAnswered(A, localStorage, 1_000 + 9 * 60_000)).toBe(true);
    expect(wasAnswered(A, localStorage, 1_000 + 10 * 60_000)).toBe(false);
  });

  it('ignores ids that are not lowercase 64-hex', () => {
    markAnswered('nothex');
    markAnswered(A.toUpperCase());
    expect(localStorage.getItem('signet:bunker-answered:v1')).toBeNull();
  });

  it('survives corrupt storage', () => {
    localStorage.setItem('signet:bunker-answered:v1', '{oops');
    expect(wasAnswered(A)).toBe(false);
    markAnswered(A);
    expect(wasAnswered(A)).toBe(true);
  });

  it('keeps at most 1000 entries, dropping the oldest', () => {
    const now = 5_000;
    for (let i = 0; i < 1001; i++) markAnswered(i.toString(16).padStart(64, '0'), localStorage, now);
    expect(wasAnswered('0'.repeat(64), localStorage, now)).toBe(false);
    expect(wasAnswered((1000).toString(16).padStart(64, '0'), localStorage, now)).toBe(true);
  });
});
