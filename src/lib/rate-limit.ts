/**
 * Per-dependant rate-limit for the phone-as-family-bunker sign-event path.
 *
 * Plain fixed-window counter (vs. token-bucket / sliding-window) because:
 *  - The only attacker we care about is a compromised child device trying
 *    to DoS the guardian's approval modal, not a sophisticated pacing
 *    attack — the fixed window's burstiness at window edges is fine.
 *  - The state is in-memory only; a page reload resets it. That's acceptable
 *    because a reload also tears down the bunker subscription and the
 *    attacker would need to trigger the counter again from scratch.
 *  - Keeping it pure + immutable lets us unit-test without React.
 */

export interface RateLimitState {
  /** Number of requests counted in the current window. */
  count: number;
  /** Wall-clock ms when the current window started. */
  windowStart: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  /** State to write back — may be a brand-new window or an incremented counter. */
  newState: RateLimitState;
}

/** Default cap: 10 sign requests per minute per dependant. */
export const DEFAULT_RATE_LIMIT = 10;
/** Window length in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Check whether a new request is allowed under the per-dependant cap.
 *
 * Pure function — no clock, no storage. Caller supplies `now` and the
 * previous state (if any) and receives the decision plus the next state
 * to persist.
 */
export function checkRateLimit(
  state: RateLimitState | undefined,
  now: number,
  limit: number = DEFAULT_RATE_LIMIT,
): RateLimitCheckResult {
  // Fresh window — either first request ever or previous window expired.
  if (!state || now - state.windowStart >= RATE_LIMIT_WINDOW_MS) {
    return { allowed: true, newState: { count: 1, windowStart: now } };
  }
  const nextCount = state.count + 1;
  if (nextCount > limit) {
    // Reject — keep the window anchored to the original start so a flood
    // can't rotate the window by resetting itself mid-minute.
    return { allowed: false, newState: state };
  }
  return { allowed: true, newState: { count: nextCount, windowStart: state.windowStart } };
}
