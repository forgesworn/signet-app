import { describe, it, expect } from 'vitest';
import { checkRateLimit, DEFAULT_RATE_LIMIT, RATE_LIMIT_WINDOW_MS } from './rate-limit';

describe('checkRateLimit', () => {
  it('allows the first request and seeds a fresh window', () => {
    const r = checkRateLimit(undefined, 1_000);
    expect(r.allowed).toBe(true);
    expect(r.newState).toEqual({ count: 1, windowStart: 1_000 });
  });

  it('allows up to the default limit within one window', () => {
    let state = undefined as ReturnType<typeof checkRateLimit>['newState'] | undefined;
    for (let i = 1; i <= DEFAULT_RATE_LIMIT; i++) {
      const r = checkRateLimit(state, 1_000 + i);
      expect(r.allowed).toBe(true);
      expect(r.newState.count).toBe(i);
      state = r.newState;
    }
  });

  it('rejects the (limit + 1)-th request within the same window', () => {
    let state = checkRateLimit(undefined, 1_000).newState;
    for (let i = 2; i <= DEFAULT_RATE_LIMIT; i++) {
      state = checkRateLimit(state, 1_000 + i).newState;
    }
    const r = checkRateLimit(state, 1_000 + DEFAULT_RATE_LIMIT + 1);
    expect(r.allowed).toBe(false);
    // State is unchanged on reject — window stays anchored.
    expect(r.newState).toEqual(state);
  });

  it('starts a fresh window once the previous one expires', () => {
    const first = checkRateLimit(undefined, 1_000);
    const later = checkRateLimit(first.newState, 1_000 + RATE_LIMIT_WINDOW_MS);
    expect(later.allowed).toBe(true);
    expect(later.newState).toEqual({ count: 1, windowStart: 1_000 + RATE_LIMIT_WINDOW_MS });
  });

  it('does not rotate the window when a flood hits the reject branch', () => {
    let state = checkRateLimit(undefined, 1_000).newState;
    for (let i = 2; i <= DEFAULT_RATE_LIMIT; i++) {
      state = checkRateLimit(state, 1_000 + i).newState;
    }
    // Attempt (limit + 5) extra requests within the same window — all rejected,
    // and crucially the window start must not move forward.
    const windowStartBefore = state.windowStart;
    for (let i = 1; i <= 5; i++) {
      const r = checkRateLimit(state, 1_000 + DEFAULT_RATE_LIMIT + i);
      expect(r.allowed).toBe(false);
      state = r.newState;
    }
    expect(state.windowStart).toBe(windowStartBefore);
  });

  it('honours a custom limit', () => {
    const first = checkRateLimit(undefined, 0, 2);
    const second = checkRateLimit(first.newState, 1, 2);
    const third = checkRateLimit(second.newState, 2, 2);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
  });

  it('does not mutate the input state', () => {
    const state = { count: 3, windowStart: 1_000 };
    const frozen = { ...state };
    checkRateLimit(state, 1_500);
    expect(state).toEqual(frozen);
  });
});
