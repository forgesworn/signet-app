import { describe, expect, it } from 'vitest';
import {
  CHILD_MODE_GENERIC_NOTIFICATION, ESCALATION_NOTIFICATION_ID_BASE, ESCALATION_NOTIFICATION_ID_RANGE,
  childModeHoldsRoute, deliveredEscalationNotificationIds, notificationForChildMode, takeDeliveredRequestNotificationIds,
} from './child-mode-entry';

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

describe('deliveredEscalationNotificationIds', () => {
  const at = (offset: number) => ({ id: ESCALATION_NOTIFICATION_ID_BASE + offset });
  it('picks the delivered notifications in the escalation id range, however the process that posted them went', () => {
    const delivered = [at(0), at(123_456), at(ESCALATION_NOTIFICATION_ID_RANGE - 1)];
    expect(deliveredEscalationNotificationIds(delivered)).toEqual(delivered.map(n => n.id));
  });
  it('leaves every id outside the range (approval handles, child asks, anything else) alone', () => {
    expect(deliveredEscalationNotificationIds([{ id: 7 }, { id: ESCALATION_NOTIFICATION_ID_BASE - 1 }, at(ESCALATION_NOTIFICATION_ID_RANGE), { id: 0x40000001 }])).toEqual([]);
  });
});
