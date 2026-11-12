import { describe, it, expect } from 'vitest';
import { HeartwoodDeviceError } from './heartwood-mgmt';
import {
  DEVICE_TEXT_MAX,
  MGMT_CHANGED_COPY,
  MGMT_GENERIC_COPY,
  MGMT_LINK_CLOSED_COPY,
  MGMT_LOW_MEMORY_COPY,
  MGMT_NO_ANSWER_COPY,
  MGMT_UNREACHABLE_COPY,
  heartwoodMgmtErrorCopy,
  isDeviceAnswerOrUnreachable,
} from './heartwood-mgmt-error-copy';

describe('heartwoodMgmtErrorCopy', () => {
  it('a silent device reads as not answering', () => {
    expect(heartwoodMgmtErrorCopy(new Error('timeout waiting for device (revoke_client)'))).toBe(MGMT_NO_ANSWER_COPY);
  });

  it('relays that took nothing read as unreachable', () => {
    expect(heartwoodMgmtErrorCopy(new Error('failed to publish to any relay'))).toBe(MGMT_UNREACHABLE_COPY);
  });

  it("the device's low-memory reply says so", () => {
    const e = new HeartwoodDeviceError('device low on memory; state unchanged, retry shortly', 'list_identities');
    expect(heartwoodMgmtErrorCopy(e)).toBe(MGMT_LOW_MEMORY_COPY);
  });

  it('a stale challenge or slot reads as the device having changed', () => {
    expect(heartwoodMgmtErrorCopy(new HeartwoodDeviceError('stale_management_challenge', 'revoke_client'))).toBe(MGMT_CHANGED_COPY);
    expect(heartwoodMgmtErrorCopy(new HeartwoodDeviceError('stale_client_slot: changed', 'revoke_client'))).toBe(MGMT_CHANGED_COPY);
  });

  it('a closed link says so', () => {
    expect(heartwoodMgmtErrorCopy(new Error('transport closed'))).toBe(MGMT_LINK_CLOSED_COPY);
    expect(heartwoodMgmtErrorCopy(new Error('not started'))).toBe(MGMT_LINK_CLOSED_COPY);
  });

  it("any other device reply is quoted, cleaned and capped", () => {
    expect(heartwoodMgmtErrorCopy(new HeartwoodDeviceError('create_slot failed (slot table full)', 'nostrconnect_v2')))
      .toBe('Your Heartwood replied: "create_slot failed (slot table full)".');
    const messy = new HeartwoodDeviceError(`bad‮\nthing ${'x'.repeat(300)}`, 'list_clients');
    const out = heartwoodMgmtErrorCopy(messy);
    expect(out).not.toMatch(/[‮\n]/);
    expect(out.length).toBeLessThanOrEqual(DEVICE_TEXT_MAX + 'Your Heartwood replied: "".'.length);
  });

  it('a sentence already written for people passes through', () => {
    const copy = "This Heartwood's operator key isn't on this phone. Add it in Advanced settings, then try again.";
    expect(heartwoodMgmtErrorCopy(new Error(copy))).toBe(copy);
  });

  it('raw text nobody wrote for people gets the generic line', () => {
    expect(heartwoodMgmtErrorCopy(new Error('update_client did not confirm the update'))).toBe(MGMT_GENERIC_COPY);
    expect(heartwoodMgmtErrorCopy(new Error('slotIndex must be a non-negative integer'))).toBe(MGMT_GENERIC_COPY);
    expect(heartwoodMgmtErrorCopy(undefined)).toBe(MGMT_GENERIC_COPY);
  });
});

describe('isDeviceAnswerOrUnreachable', () => {
  it('is true for a device reply or a relay failure, false for a timeout', () => {
    expect(isDeviceAnswerOrUnreachable(new HeartwoodDeviceError('x', 'm'))).toBe(true);
    expect(isDeviceAnswerOrUnreachable(new Error('failed to publish to any relay'))).toBe(true);
    expect(isDeviceAnswerOrUnreachable(new Error('timeout waiting for device (list_identities)'))).toBe(false);
  });
});
