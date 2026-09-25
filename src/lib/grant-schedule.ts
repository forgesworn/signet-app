/**
 * Per-origin and dep-default schedule clauses (Charter clause #1).
 *
 * This module is the data + pure-function layer:
 * - Types for `GrantSchedule`, `WeeklySchedule`, `ScheduleWindow`
 * - `validateSchedule` — invariant check (throws on first violation)
 * - `isWithinSchedule` — time check used by the bunker on every sign
 * - `intersectSchedules` — AND two schedules (per-origin x dep-default)
 *
 * No I/O, no React, no Nostr. Bunker integration lives in
 * useBunkerServer; type wiring into RememberedGrant /
 * DependantIdentity / TrustedAppPairing lives in types.ts and db.ts.
 */

/** Schedule shape — used both per-origin and as the dep-level default. */
export interface GrantSchedule {
  /** Schema version for forward compat. v1 today. */
  v: 1;
  /** IANA timezone (e.g. "Europe/London"). Stamped at issue time. */
  tz: string;
  /**
   * If true, ALL signs are blocked while this schedule is active.
   * When `paused` is true the rest of the schedule is ignored.
   */
  paused?: boolean;
  /** Recurring weekly windows. Empty / missing = no weekly windows. */
  weekly: WeeklySchedule;
  /**
   * Per-date overrides (ISO date `YYYY-MM-DD`, interpreted in `tz`) —
   * replace the weekly entry for that date entirely. Empty array =
   * blocked all day; omit the date key to fall through to weekly.
   */
  overrides?: Record<string, ScheduleWindow[]>;
  /** Issue timestamp (unix seconds). Carried in audit-log entries. */
  issuedAt: number;
}

export interface WeeklySchedule {
  mon?: ScheduleWindow[];
  tue?: ScheduleWindow[];
  wed?: ScheduleWindow[];
  thu?: ScheduleWindow[];
  fri?: ScheduleWindow[];
  sat?: ScheduleWindow[];
  sun?: ScheduleWindow[];
}

export interface ScheduleWindow {
  /** Start time "HH:MM" in `GrantSchedule.tz`. */
  start: string;
  /** End time "HH:MM" in `GrantSchedule.tz`. Strictly > start. */
  end: string;
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type WeekdayKey = typeof WEEKDAY_KEYS[number];

/** Convert "HH:MM" to minutes-since-midnight. Caller must have validated. */
function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

/** ISO weekday (1 = Mon ... 7 = Sun) → 3-letter key used in WeeklySchedule. */
function isoWeekdayToKey(day: number): WeekdayKey {
  // day from `Date.prototype.getDay()` adjusted is preferred; we get
  // ISO weekday from a Date in a specific tz separately.
  return WEEKDAY_KEYS[day - 1];
}

/**
 * Validate the data-model invariants. Throws `Error` on first violation
 * with a human-readable message. Used both at editor save time and on
 * sync-incoming schedules (defence-in-depth — never trust wire shape).
 */
export function validateSchedule(schedule: GrantSchedule): void {
  if (!schedule || typeof schedule !== 'object') {
    throw new Error('Schedule must be an object');
  }
  if (schedule.v !== 1) {
    throw new Error(`Unsupported schedule schema version: ${schedule.v}`);
  }
  if (typeof schedule.tz !== 'string' || !schedule.tz) {
    throw new Error('Schedule.tz must be a non-empty string');
  }
  // Round-trip through Intl to validate IANA timezone. Throws RangeError
  // on unknown identifiers — we re-throw as our own message.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: schedule.tz });
  } catch {
    throw new Error(`Schedule.tz is not a valid IANA timezone: ${schedule.tz}`);
  }
  if (typeof schedule.issuedAt !== 'number' || !Number.isFinite(schedule.issuedAt) || schedule.issuedAt <= 0) {
    throw new Error('Schedule.issuedAt must be a positive number (unix seconds)');
  }
  if (typeof schedule.weekly !== 'object' || schedule.weekly === null) {
    throw new Error('Schedule.weekly must be an object');
  }
  for (const key of WEEKDAY_KEYS) {
    const windows = schedule.weekly[key];
    if (windows === undefined) continue;
    if (!Array.isArray(windows)) {
      throw new Error(`Schedule.weekly.${key} must be an array if present`);
    }
    windows.forEach((w, i) => validateWindow(w, `weekly.${key}[${i}]`));
  }
  if (schedule.overrides !== undefined) {
    if (typeof schedule.overrides !== 'object' || schedule.overrides === null) {
      throw new Error('Schedule.overrides must be an object if present');
    }
    for (const [date, windows] of Object.entries(schedule.overrides)) {
      if (!ISO_DATE_RE.test(date)) {
        throw new Error(`Schedule.overrides key "${date}" is not YYYY-MM-DD`);
      }
      // Verify the date actually parses (catches "2026-02-30" etc.)
      const [yy, mm, dd] = date.split('-').map(Number);
      const parsed = new Date(Date.UTC(yy, mm - 1, dd));
      if (parsed.getUTCFullYear() !== yy || parsed.getUTCMonth() !== mm - 1 || parsed.getUTCDate() !== dd) {
        throw new Error(`Schedule.overrides key "${date}" is not a real calendar date`);
      }
      if (!Array.isArray(windows)) {
        throw new Error(`Schedule.overrides["${date}"] must be an array`);
      }
      windows.forEach((w, i) => validateWindow(w, `overrides["${date}"][${i}]`));
    }
  }
  if (schedule.paused !== undefined && typeof schedule.paused !== 'boolean') {
    throw new Error('Schedule.paused must be a boolean if present');
  }
}

function validateWindow(w: ScheduleWindow, path: string): void {
  if (!w || typeof w !== 'object') {
    throw new Error(`Window ${path} must be an object`);
  }
  if (typeof w.start !== 'string' || !HHMM_RE.test(w.start)) {
    throw new Error(`Window ${path}.start must be "HH:MM" (00–23:00–59), got "${w.start}"`);
  }
  if (typeof w.end !== 'string' || !HHMM_RE.test(w.end)) {
    throw new Error(`Window ${path}.end must be "HH:MM" (00–23:00–59), got "${w.end}"`);
  }
  const startMin = hhmmToMinutes(w.start);
  const endMin = hhmmToMinutes(w.end);
  if (endMin <= startMin) {
    throw new Error(`Window ${path}: end must be strictly greater than start (got ${w.start}–${w.end})`);
  }
}

/**
 * Internal: extract the date components for a `Date` as observed in
 * the schedule's IANA timezone. Returns ISO weekday (1=Mon…7=Sun),
 * `YYYY-MM-DD` date string, and minutes-since-midnight. Uses
 * `Intl.DateTimeFormat` so DST and offsets are handled correctly.
 */
function extractInTz(now: Date, tz: string): { weekday: number; isoDate: string; minutesOfDay: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(p => p.type === type)?.value ?? '';
  const yy = Number(get('year'));
  const mm = Number(get('month'));
  const dd = Number(get('day'));
  let hh = Number(get('hour'));
  const min = Number(get('minute'));
  // hour12: false produces "00".."23"; in some browsers midnight shows as "24"
  if (hh === 24) hh = 0;
  // weekday short: "Mon" / "Tue" / ... — map to ISO 1–7
  const wkShort = get('weekday');
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const weekday = map[wkShort] ?? 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    weekday,
    isoDate: `${yy}-${pad(mm)}-${pad(dd)}`,
    minutesOfDay: hh * 60 + min,
  };
}

/**
 * Returns whether `now` falls inside an allowed window of `schedule`.
 * On `{ allowed: false }`, also returns `nextAllowedAt` if there's a
 * window starting within the next `horizonDays` days; otherwise
 * undefined (caller should render "ask your parent" rather than a
 * time).
 *
 * Important: this function does not call `validateSchedule` — callers
 * should validate before passing in (do it once at write time, not
 * once per sign request).
 */
export function isWithinSchedule(
  schedule: GrantSchedule,
  now: Date = new Date(),
  horizonDays: number = 30,
): { allowed: true } | { allowed: false; nextAllowedAt?: Date } {
  if (schedule.paused) {
    return { allowed: false }; // paused — no nextAllowedAt; parent must un-pause
  }
  const { weekday, isoDate, minutesOfDay } = extractInTz(now, schedule.tz);
  const todayWindows = resolveDayWindows(schedule, isoDate, weekday);
  if (todayWindows.some(w => minutesOfDay >= hhmmToMinutes(w.start) && minutesOfDay < hhmmToMinutes(w.end))) {
    return { allowed: true };
  }
  // Find next allowed start within horizon
  const nextAllowedAt = findNextAllowedAt(schedule, now, horizonDays);
  if (nextAllowedAt) return { allowed: false, nextAllowedAt };
  return { allowed: false };
}

/**
 * Resolve the active windows for a given date (in `schedule.tz`).
 * Override > weekly. Returns empty array if blocked.
 */
function resolveDayWindows(schedule: GrantSchedule, isoDate: string, weekday: number): ScheduleWindow[] {
  const ov = schedule.overrides?.[isoDate];
  if (ov !== undefined) return ov; // explicit override (may be empty = blocked)
  const key = isoWeekdayToKey(weekday);
  return schedule.weekly[key] ?? [];
}

/**
 * Walk forward up to `horizonDays`, find the next minute that becomes
 * allowed. Returns the corresponding `Date` (in absolute time) or
 * undefined if no window starts within the horizon.
 *
 * Implementation: for each day from today through today+horizon,
 * compute today's resolved windows. If any window's start is in the
 * future, return that absolute timestamp. (Today's already-started
 * windows are excluded since `isWithinSchedule` already established
 * we're outside them.)
 */
function findNextAllowedAt(schedule: GrantSchedule, now: Date, horizonDays: number): Date | undefined {
  for (let dayOffset = 0; dayOffset <= horizonDays; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const { weekday, isoDate, minutesOfDay } = extractInTz(probe, schedule.tz);
    const windows = resolveDayWindows(schedule, isoDate, weekday);
    // Sort by start so we can pick the earliest future window
    const sorted = [...windows].sort((a, b) => hhmmToMinutes(a.start) - hhmmToMinutes(b.start));
    for (const w of sorted) {
      const startMin = hhmmToMinutes(w.start);
      // Day 0: only future starts (strictly after current minute)
      if (dayOffset === 0 && startMin <= minutesOfDay) continue;
      // Day N>0: any start qualifies (whole day is "future")
      // Compute the absolute Date for this candidate start
      const start = absoluteDateFromTzClock(probe, schedule.tz, startMin);
      if (start && start.getTime() > now.getTime()) return start;
    }
  }
  return undefined;
}

/**
 * Construct a `Date` representing the wall-clock minute (`minutesOfDay`)
 * on the same calendar day that `probe` falls on in `tz`. Returns
 * undefined if the conversion is ambiguous (DST fall-back gives two
 * candidates) or unreachable (DST spring-forward gap).
 *
 * Strategy: form the local date string in `tz`, append the wall-clock
 * time, build a tentative UTC date, then adjust by the tz offset at
 * that wall-clock time. We resolve the offset by inspecting the
 * formatted output of the tentative timestamp.
 */
function absoluteDateFromTzClock(probe: Date, tz: string, minutesOfDay: number): Date | undefined {
  const { isoDate } = extractInTz(probe, tz);
  const [yy, mm, dd] = isoDate.split('-').map(Number);
  const hh = Math.floor(minutesOfDay / 60);
  const min = minutesOfDay % 60;
  // Tentative UTC timestamp for the wall-clock moment
  const utcGuess = Date.UTC(yy, mm - 1, dd, hh, min, 0);
  // Compute the offset at this guess: format `utcGuess` as parts in tz,
  // then derive the difference from the wall-clock target.
  const partsAtGuess = extractInTz(new Date(utcGuess), tz);
  const targetMinutes = hh * 60 + min;
  const observedMinutes = partsAtGuess.minutesOfDay;
  // observed - target = tz offset (in minutes east of UTC) at this moment
  const offsetMin = observedMinutes - targetMinutes;
  // Adjust: real local-clock target = utcGuess - offsetMin
  const candidate = new Date(utcGuess - offsetMin * 60 * 1000);
  // Verify the candidate falls on the same date + correct minute in tz
  const verify = extractInTz(candidate, tz);
  if (verify.isoDate === isoDate && verify.minutesOfDay === targetMinutes) {
    return candidate;
  }
  // DST gap or fall-back ambiguity — caller treats as "unreachable today"
  // and walks to the next day. (Acceptable: parent's window straddling
  // DST will have a one-day gap; documented in the spec edge cases.)
  return undefined;
}

/**
 * AND two schedules. Either may be undefined (treated as
 * unrestricted). Result is undefined if both are undefined.
 *
 * - If either is `paused`, result is paused.
 * - Otherwise, the result is a new schedule whose windows per day are
 *   the pairwise intersection of the inputs' windows for that day,
 *   considering both weekly and overrides. Where one side has no
 *   restriction (no schedule), the other's windows pass through.
 *
 * Per-origin can therefore never extend dep-default: overlapping a
 * per-origin window outside the dep-default's allowed hours produces
 * an empty intersection for those minutes.
 *
 * Output uses the FIRST defined `tz` (per-origin if set, else dep-default).
 * Output `issuedAt` is the max of inputs (so audit shows the latest
 * change). Output `overrides` merges keys from both sides — if either
 * has a date-key set, the result is the intersection of those windows
 * (or whatever the absent side's weekly contributed).
 */
export function intersectSchedules(
  a: GrantSchedule | undefined,
  b: GrantSchedule | undefined,
): GrantSchedule | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;

  if (a.paused || b.paused) {
    // Pause dominates. Carry an issuedAt from whichever side asserted it.
    const tz = a.paused ? a.tz : b.tz;
    const issuedAt = Math.max(a.issuedAt, b.issuedAt);
    return { v: 1, tz, paused: true, weekly: {}, issuedAt };
  }

  const tz = a.tz; // arbitrary but deterministic — per-origin first
  const issuedAt = Math.max(a.issuedAt, b.issuedAt);
  const weekly: WeeklySchedule = {};
  for (const key of WEEKDAY_KEYS) {
    const aw = a.weekly[key];
    const bw = b.weekly[key];
    weekly[key] = intersectWindowLists(aw, bw);
  }
  // Strip empty arrays for cleanliness (but keep them when explicitly
  // empty — see overrides below)
  for (const key of WEEKDAY_KEYS) {
    if (weekly[key] && weekly[key]!.length === 0) delete weekly[key];
  }

  // Merge override date keys
  const overrides: Record<string, ScheduleWindow[]> = {};
  const keys = new Set([
    ...Object.keys(a.overrides ?? {}),
    ...Object.keys(b.overrides ?? {}),
  ]);
  for (const date of keys) {
    const aOv = a.overrides?.[date];
    const bOv = b.overrides?.[date];
    // Within an override key, the absent side falls back to its weekly
    // for that date — but we've already encoded a single tz so that's
    // tricky. Simpler: when one side has an override and the other
    // doesn't, intersect the override against the other side's weekly
    // for that ISO date's weekday.
    const date2 = parseIsoDateInTz(date, tz);
    const weekdayKey = date2 ? isoWeekdayToKey(date2.weekday) : 'mon';
    const aResolved = aOv ?? a.weekly[weekdayKey];
    const bResolved = bOv ?? b.weekly[weekdayKey];
    overrides[date] = intersectWindowLists(aResolved, bResolved);
  }

  const result: GrantSchedule = { v: 1, tz, weekly, issuedAt };
  if (Object.keys(overrides).length > 0) result.overrides = overrides;
  return result;
}

/** Pure helper: intersect two window lists. Either may be undefined (= unrestricted = pass-through other). */
function intersectWindowLists(
  a: ScheduleWindow[] | undefined,
  b: ScheduleWindow[] | undefined,
): ScheduleWindow[] {
  if (a === undefined && b === undefined) return [];
  if (a === undefined) return b!.slice();
  if (b === undefined) return a.slice();
  // Both defined: pairwise intersect
  const out: ScheduleWindow[] = [];
  for (const aw of a) {
    const aStart = hhmmToMinutes(aw.start);
    const aEnd = hhmmToMinutes(aw.end);
    for (const bw of b) {
      const bStart = hhmmToMinutes(bw.start);
      const bEnd = hhmmToMinutes(bw.end);
      const start = Math.max(aStart, bStart);
      const end = Math.min(aEnd, bEnd);
      if (end > start) {
        out.push({ start: minutesToHHMM(start), end: minutesToHHMM(end) });
      }
    }
  }
  // Sort + merge contiguous/overlapping
  out.sort((x, y) => hhmmToMinutes(x.start) - hhmmToMinutes(y.start));
  const merged: ScheduleWindow[] = [];
  for (const w of out) {
    const last = merged[merged.length - 1];
    if (last && hhmmToMinutes(w.start) <= hhmmToMinutes(last.end)) {
      const newEnd = Math.max(hhmmToMinutes(last.end), hhmmToMinutes(w.end));
      last.end = minutesToHHMM(newEnd);
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

function minutesToHHMM(m: number): string {
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function parseIsoDateInTz(iso: string, _tz: string): { weekday: number } | undefined {
  if (!ISO_DATE_RE.test(iso)) return undefined;
  const [yy, mm, dd] = iso.split('-').map(Number);
  // Use UTC date for weekday calculation — for the purpose of weekday
  // it's stable regardless of tz (a calendar day's weekday doesn't
  // depend on tz interpretation; only its boundary moments do).
  const d = new Date(Date.UTC(yy, mm - 1, dd));
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return { weekday: isoDay };
}
