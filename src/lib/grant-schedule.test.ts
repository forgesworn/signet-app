import { describe, it, expect } from 'vitest';
import {
  validateSchedule,
  isWithinSchedule,
  intersectSchedules,
  type GrantSchedule,
} from './grant-schedule';

const TZ = 'Europe/London';

function baseSchedule(overrides?: Partial<GrantSchedule>): GrantSchedule {
  return {
    v: 1,
    tz: TZ,
    issuedAt: 1714000000,
    weekly: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateSchedule
// ---------------------------------------------------------------------------

describe('validateSchedule', () => {
  it('accepts a minimal valid schedule', () => {
    expect(() => validateSchedule(baseSchedule())).not.toThrow();
  });

  it('accepts a paused schedule', () => {
    expect(() => validateSchedule(baseSchedule({ paused: true }))).not.toThrow();
  });

  it('accepts weekly windows', () => {
    expect(() => validateSchedule(baseSchedule({
      weekly: { mon: [{ start: '16:00', end: '20:00' }] },
    }))).not.toThrow();
  });

  it('accepts overrides with valid date keys', () => {
    expect(() => validateSchedule(baseSchedule({
      overrides: { '2026-12-25': [{ start: '10:00', end: '20:00' }] },
    }))).not.toThrow();
  });

  it('rejects unknown schema version', () => {
    expect(() => validateSchedule({ ...baseSchedule(), v: 2 as never })).toThrow(/version/);
  });

  it('rejects missing tz', () => {
    expect(() => validateSchedule({ ...baseSchedule(), tz: '' })).toThrow(/tz/);
  });

  it('rejects invalid IANA timezone', () => {
    expect(() => validateSchedule({ ...baseSchedule(), tz: 'Atlantis/Lost' })).toThrow(/IANA/);
  });

  it('rejects non-positive issuedAt', () => {
    expect(() => validateSchedule({ ...baseSchedule(), issuedAt: 0 })).toThrow(/issuedAt/);
  });

  it('rejects window with HH > 23', () => {
    expect(() => validateSchedule(baseSchedule({
      weekly: { mon: [{ start: '24:00', end: '25:00' }] },
    }))).toThrow(/HH:MM/);
  });

  it('rejects window with MM > 59', () => {
    expect(() => validateSchedule(baseSchedule({
      weekly: { mon: [{ start: '10:60', end: '11:00' }] },
    }))).toThrow(/HH:MM/);
  });

  it('rejects window with start === end (zero duration)', () => {
    expect(() => validateSchedule(baseSchedule({
      weekly: { mon: [{ start: '10:00', end: '10:00' }] },
    }))).toThrow(/strictly greater/);
  });

  it('rejects inverted window (end < start, i.e. midnight crossing)', () => {
    expect(() => validateSchedule(baseSchedule({
      weekly: { mon: [{ start: '22:00', end: '01:00' }] },
    }))).toThrow(/strictly greater/);
  });

  it('rejects override date key in wrong format', () => {
    expect(() => validateSchedule(baseSchedule({
      overrides: { '12/25/2026': [] },
    }))).toThrow(/YYYY-MM-DD/);
  });

  it('rejects override date that is not a real calendar date', () => {
    expect(() => validateSchedule(baseSchedule({
      overrides: { '2026-02-30': [] },
    }))).toThrow(/calendar date/);
  });

  it('rejects non-array weekly value', () => {
    expect(() => validateSchedule({ ...baseSchedule(), weekly: { mon: 'oops' as never } })).toThrow(/array/);
  });

  it('rejects non-boolean paused', () => {
    expect(() => validateSchedule({ ...baseSchedule(), paused: 'yes' as never })).toThrow(/boolean/);
  });
});

// ---------------------------------------------------------------------------
// isWithinSchedule
// ---------------------------------------------------------------------------

describe('isWithinSchedule', () => {
  it('paused = blocked, no nextAllowedAt', () => {
    const s = baseSchedule({ paused: true });
    const r = isWithinSchedule(s, new Date('2026-05-08T12:00:00Z'));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.nextAllowedAt).toBeUndefined();
  });

  it('empty weekly and no overrides = no-op = blocked, but nextAllowedAt undefined', () => {
    // Spec: weekly = {} and no overrides means no allowed windows ever.
    // (The data shape "empty weekly" is also documented as no-op /
    //  always allowed when interpreted alongside schedule-absent. But
    //  isWithinSchedule operates only on what's in the schedule; an
    //  empty schedule has no allowed windows. The bunker treats
    //  "no schedule field at all" as unrestricted, which is the actual
    //  no-op semantics — that's a distinct path, not this function.)
    const s = baseSchedule();
    const r = isWithinSchedule(s, new Date('2026-05-08T12:00:00Z'));
    expect(r.allowed).toBe(false);
  });

  it('inside a weekly window = allowed', () => {
    // 2026-05-08 is a Friday. London time at 18:00 BST = 17:00 UTC.
    const s = baseSchedule({
      weekly: { fri: [{ start: '16:00', end: '20:00' }] },
    });
    const now = new Date('2026-05-08T17:00:00Z'); // 18:00 BST = inside 16-20
    expect(isWithinSchedule(s, now).allowed).toBe(true);
  });

  it('before today\'s window = blocked, nextAllowedAt = today\'s start', () => {
    // 2026-05-08 Fri 09:00 BST = 08:00 UTC
    const s = baseSchedule({
      weekly: { fri: [{ start: '16:00', end: '20:00' }] },
    });
    const now = new Date('2026-05-08T08:00:00Z');
    const r = isWithinSchedule(s, now);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.nextAllowedAt).toBeDefined();
      // Should be today at 16:00 London = 15:00 UTC
      expect(r.nextAllowedAt!.toISOString()).toBe('2026-05-08T15:00:00.000Z');
    }
  });

  it('after today\'s window = blocked, nextAllowedAt = next applicable day', () => {
    // 2026-05-08 Fri 21:00 BST. Next allowed: Mon 2026-05-11 16:00 (mon window).
    const s = baseSchedule({
      weekly: { mon: [{ start: '16:00', end: '20:00' }] },
    });
    const now = new Date('2026-05-08T20:00:00Z'); // 21:00 BST Fri
    const r = isWithinSchedule(s, now);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.nextAllowedAt).toBeDefined();
      expect(r.nextAllowedAt!.toISOString()).toBe('2026-05-11T15:00:00.000Z');
    }
  });

  it('override array empty = day blocked even if weekly has windows', () => {
    // Friday's weekly says 16:00-20:00 BUT that specific Friday is overridden empty.
    const s = baseSchedule({
      weekly: { fri: [{ start: '16:00', end: '20:00' }] },
      overrides: { '2026-05-08': [] },
    });
    const now = new Date('2026-05-08T17:00:00Z'); // Fri 18:00 BST — would be allowed by weekly
    expect(isWithinSchedule(s, now).allowed).toBe(false);
  });

  it('override allows a normally-blocked date', () => {
    // Saturday weekly empty, but specific Sat 25 Dec is allowed 10:00-20:00.
    const s = baseSchedule({
      weekly: {}, // no Saturday window
      overrides: { '2026-12-26': [{ start: '10:00', end: '20:00' }] },
    });
    const now = new Date('2026-12-26T12:00:00Z'); // Sat 12:00 GMT
    expect(isWithinSchedule(s, now).allowed).toBe(true);
  });

  it('multiple windows in a day: any-match', () => {
    const s = baseSchedule({
      weekly: { fri: [
        { start: '08:00', end: '09:00' },
        { start: '16:00', end: '20:00' },
      ] },
    });
    const inFirst = new Date('2026-05-08T07:30:00Z'); // Fri 08:30 BST
    const inSecond = new Date('2026-05-08T18:00:00Z'); // Fri 19:00 BST
    const between = new Date('2026-05-08T11:00:00Z'); // Fri 12:00 BST
    expect(isWithinSchedule(s, inFirst).allowed).toBe(true);
    expect(isWithinSchedule(s, inSecond).allowed).toBe(true);
    expect(isWithinSchedule(s, between).allowed).toBe(false);
  });

  it('respects schedule.tz, not device tz, for window evaluation', () => {
    // Schedule in NY tz, allowed 16:00-20:00 Fri NY time.
    // 16:00 EDT = 20:00 UTC.
    const s = baseSchedule({
      tz: 'America/New_York',
      weekly: { fri: [{ start: '16:00', end: '20:00' }] },
    });
    const inNyAfternoon = new Date('2026-05-08T20:30:00Z'); // 16:30 EDT
    const inLondonAfternoon = new Date('2026-05-08T15:00:00Z'); // 16:00 BST = 11:00 EDT — outside
    expect(isWithinSchedule(s, inNyAfternoon).allowed).toBe(true);
    expect(isWithinSchedule(s, inLondonAfternoon).allowed).toBe(false);
  });

  it('horizon: nextAllowedAt undefined when no window in next 30 days', () => {
    // No weekly, no overrides — never allowed.
    const s = baseSchedule({ weekly: {} });
    const r = isWithinSchedule(s, new Date('2026-05-08T12:00:00Z'));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.nextAllowedAt).toBeUndefined();
  });

  it('horizon: nextAllowedAt found when override is within horizon', () => {
    const s = baseSchedule({
      weekly: {},
      overrides: { '2026-05-15': [{ start: '10:00', end: '12:00' }] },
    });
    const r = isWithinSchedule(s, new Date('2026-05-08T12:00:00Z'));
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.nextAllowedAt).toBeDefined();
      // 2026-05-15 Fri 10:00 BST = 09:00 UTC
      expect(r.nextAllowedAt!.toISOString()).toBe('2026-05-15T09:00:00.000Z');
    }
  });

  it('horizon: scan can be customised', () => {
    // Override 60 days out — default horizon (30) misses, 90 finds.
    const s = baseSchedule({
      weekly: {},
      overrides: { '2026-07-08': [{ start: '10:00', end: '12:00' }] },
    });
    const now = new Date('2026-05-08T12:00:00Z');
    const r30 = isWithinSchedule(s, now, 30);
    const r90 = isWithinSchedule(s, now, 90);
    if (!r30.allowed) expect(r30.nextAllowedAt).toBeUndefined();
    if (!r90.allowed) expect(r90.nextAllowedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// intersectSchedules
// ---------------------------------------------------------------------------

describe('intersectSchedules', () => {
  it('both undefined = undefined', () => {
    expect(intersectSchedules(undefined, undefined)).toBeUndefined();
  });

  it('one undefined = other passes through', () => {
    const s = baseSchedule({ weekly: { mon: [{ start: '16:00', end: '20:00' }] } });
    expect(intersectSchedules(s, undefined)).toBe(s);
    expect(intersectSchedules(undefined, s)).toBe(s);
  });

  it('paused on either side dominates', () => {
    const a = baseSchedule({ paused: true });
    const b = baseSchedule({ weekly: { mon: [{ start: '16:00', end: '20:00' }] } });
    const r1 = intersectSchedules(a, b);
    const r2 = intersectSchedules(b, a);
    expect(r1?.paused).toBe(true);
    expect(r2?.paused).toBe(true);
  });

  it('intersects overlapping weekly windows to the narrower span', () => {
    const a = baseSchedule({ weekly: { mon: [{ start: '08:00', end: '20:00' }] } });
    const b = baseSchedule({ weekly: { mon: [{ start: '16:00', end: '22:00' }] } });
    const r = intersectSchedules(a, b);
    expect(r?.weekly.mon).toEqual([{ start: '16:00', end: '20:00' }]);
  });

  it('non-overlapping weekly windows yield no day-window (entire day blocked)', () => {
    const a = baseSchedule({ weekly: { mon: [{ start: '08:00', end: '12:00' }] } });
    const b = baseSchedule({ weekly: { mon: [{ start: '16:00', end: '20:00' }] } });
    const r = intersectSchedules(a, b);
    expect(r?.weekly.mon).toBeUndefined();
  });

  it('one side missing day = other side passes through for that day', () => {
    const a = baseSchedule({ weekly: { mon: [{ start: '08:00', end: '20:00' }] } });
    const b = baseSchedule({ weekly: {} }); // no mon = unrestricted on mon
    const r = intersectSchedules(a, b);
    expect(r?.weekly.mon).toEqual([{ start: '08:00', end: '20:00' }]);
  });

  it('uses max(issuedAt) for the merged schedule', () => {
    const a = baseSchedule({ issuedAt: 100 });
    const b = baseSchedule({ issuedAt: 200 });
    expect(intersectSchedules(a, b)?.issuedAt).toBe(200);
  });

  it('intersection enforces "per-origin can never extend dep-default"', () => {
    // dep-default: 16-20 weekdays
    const depDefault = baseSchedule({
      weekly: {
        mon: [{ start: '16:00', end: '20:00' }],
        tue: [{ start: '16:00', end: '20:00' }],
      },
    });
    // per-origin: 14-22 (tries to extend on both ends)
    const perOrigin = baseSchedule({
      weekly: {
        mon: [{ start: '14:00', end: '22:00' }],
        tue: [{ start: '14:00', end: '22:00' }],
      },
    });
    const r = intersectSchedules(perOrigin, depDefault);
    // Result: capped to the dep-default 16-20
    expect(r?.weekly.mon).toEqual([{ start: '16:00', end: '20:00' }]);
    expect(r?.weekly.tue).toEqual([{ start: '16:00', end: '20:00' }]);
  });

  it('within-allowed sign request passes both schedules in intersection check', () => {
    const depDefault = baseSchedule({ weekly: { fri: [{ start: '16:00', end: '20:00' }] } });
    const perOrigin = baseSchedule({ weekly: { fri: [{ start: '16:00', end: '18:00' }] } });
    const r = intersectSchedules(perOrigin, depDefault);
    expect(r).toBeDefined();
    const inside = new Date('2026-05-08T16:00:00Z'); // Fri 17:00 BST = inside 16-18
    const outside = new Date('2026-05-08T18:30:00Z'); // Fri 19:30 BST = inside dep-default but outside per-origin
    expect(isWithinSchedule(r!, inside).allowed).toBe(true);
    expect(isWithinSchedule(r!, outside).allowed).toBe(false);
  });
});
