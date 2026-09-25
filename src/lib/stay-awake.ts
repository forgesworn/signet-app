// src/lib/stay-awake.ts

/** Duration options (minutes) offered by the Stay-awake chooser. */
export const STAY_AWAKE_OPTIONS_MINUTES = [2, 5, 10] as const;

/** Arm a window: the absolute epoch-ms at which it expires. */
export function stayAwakeUntil(nowMs: number, minutes: number): number {
  return nowMs + minutes * 60_000;
}

/** Whether a window is currently active. `until === null` → inactive. */
export function isStayAwakeActive(until: number | null, nowMs: number): boolean {
  return until !== null && until > nowMs;
}

/** Milliseconds remaining, clamped at 0. */
export function stayAwakeRemainingMs(until: number | null, nowMs: number): number {
  if (until === null) return 0;
  return Math.max(0, until - nowMs);
}

/** Format a remaining-ms value as `m:ss` for the countdown (rounds up). */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
