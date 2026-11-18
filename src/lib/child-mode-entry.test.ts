import { describe, expect, it } from 'vitest';
import { CHILD_MODE_GENERIC_NOTIFICATION, childModeHoldsRoute, notificationForChildMode } from './child-mode-entry';

const named = { title: 'Mia is waiting for a sign-in approval', body: 'Open Signet to review it.' };

describe('notificationForChildMode', () => {
  it('keeps the named text outside child mode', () => {
    expect(notificationForChildMode('off', named)).toBe(named);
  });
  it.each(['on', 'unknown'] as const)('is the generic line, with no names, while %s', mode => {
    const out = notificationForChildMode(mode, named);
    expect(out).toBe(CHILD_MODE_GENERIC_NOTIFICATION);
    expect(JSON.stringify(out)).not.toContain('Mia');
  });
});

describe('childModeHoldsRoute', () => {
  it('holds the guardian\'s own routes while on or unknown, not when off', () => {
    expect(childModeHoldsRoute({}, 'on')).toBe(true);
    expect(childModeHoldsRoute({}, 'unknown')).toBe(true);
    expect(childModeHoldsRoute({}, 'off')).toBe(false);
  });
  it('never holds a dependant route or a child\'s own route', () => {
    expect(childModeHoldsRoute({ dependantId: 'd1' }, 'on')).toBe(false);
    expect(childModeHoldsRoute({ childGate: {} }, 'unknown')).toBe(false);
  });
});
