import { describe, expect, it } from 'vitest';
import { CHILD_MODE_GENERIC_NOTIFICATION, childModeHoldsRoute, notificationForChildMode, takeDeliveredRequestNotificationIds } from './child-mode-entry';

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

describe('takeDeliveredRequestNotificationIds', () => {
  it('returns every delivered approval and child-ask notification id, and forgets them', () => {
    const handles = new Set([7, 9]);
    const asks = new Map([['ask-a', 0x40000001], ['ask-b', 0x40000002]]);
    expect(takeDeliveredRequestNotificationIds(handles, asks).sort((a, b) => a - b)).toEqual([7, 9, 0x40000001, 0x40000002]);
    expect(handles.size).toBe(0);
    expect(asks.size).toBe(0);
    expect(takeDeliveredRequestNotificationIds(handles, asks)).toEqual([]);
  });
});
