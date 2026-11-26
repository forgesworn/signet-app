import { describe, it, expect } from 'vitest';
import { HeartwoodDeviceError } from './heartwood-mgmt';
import { HandoffNoAnswerError } from './heartwood-handoff';
import {
  DEVICE_TEXT_MAX,
  MGMT_CHANGED_COPY,
  MGMT_GENERIC_COPY,
  MGMT_LINK_CLOSED_COPY,
  MGMT_LOW_MEMORY_COPY,
  MGMT_NO_ANSWER_COPY,
  MGMT_UNREACHABLE_COPY,
  HeartwoodCopyError,
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
    expect(heartwoodMgmtErrorCopy(e)).toBe(`${MGMT_LOW_MEMORY_COPY} Your Heartwood said: "device low on memory; state unchanged, retry shortly".`);
    // A plain Error carrying the same words has no device text to add.
    expect(heartwoodMgmtErrorCopy(new Error('out of memory'))).toBe(MGMT_LOW_MEMORY_COPY);
  });

  it('a stale challenge or slot reads as the device having changed', () => {
    expect(heartwoodMgmtErrorCopy(new HeartwoodDeviceError('stale_management_challenge', 'revoke_client'))).toBe(MGMT_CHANGED_COPY);
    expect(heartwoodMgmtErrorCopy(new HeartwoodDeviceError('stale_client_slot', 'revoke_client'))).toBe(MGMT_CHANGED_COPY);
  });

  it('a closed link says so', () => {
    expect(heartwoodMgmtErrorCopy(new Error('transport closed'))).toBe(MGMT_LINK_CLOSED_COPY);
    expect(heartwoodMgmtErrorCopy(new Error('transport closed (nostrconnect_v2)'))).toBe(MGMT_LINK_CLOSED_COPY);
    expect(heartwoodMgmtErrorCopy(new Error('transport closed (get_management_challenge)'))).toBe(MGMT_LINK_CLOSED_COPY);
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

describe("the device's own text is shown in full (up to the cap)", () => {
  const LONG = 'pairing was refused: the slot table holds the maximum number of clients, remove one with revoke_client and retry the connect request from the app that is asking to be handed off to this device';

  it('a reply past the old 120-character cut reads to its end', () => {
    expect(LONG.length).toBeGreaterThan(120);
    expect(heartwoodMgmtErrorCopy(new HeartwoodDeviceError(LONG, 'nostrconnect_v2'))).toBe(`Your Heartwood replied: "${LONG}".`);
  });

  it('the cap is about 300 characters, cut with an ellipsis', () => {
    expect(DEVICE_TEXT_MAX).toBe(300);
    const out = heartwoodMgmtErrorCopy(new HeartwoodDeviceError('w'.repeat(500), 'm'));
    expect(out).toBe(`Your Heartwood replied: "${'w'.repeat(299)}…".`);
  });

  it('control and bidi characters are still stripped from the long text', () => {
    const out = heartwoodMgmtErrorCopy(new HeartwoodDeviceError(`${LONG}\u202e\u0007\n${LONG}`, 'm'));
    expect(out).not.toMatch(/[\u202e\u0007\n]/);
  });

  it('a known code keeps its friendly copy and gains the device text after it', () => {
    const out = heartwoodMgmtErrorCopy(new HeartwoodDeviceError('device low on memory; state unchanged, retry shortly', 'list_identities'));
    expect(out).toBe(`${MGMT_LOW_MEMORY_COPY} Your Heartwood said: "device low on memory; state unchanged, retry shortly".`);
  });

  it('a known code whose text is only the code adds nothing', () => {
    expect(heartwoodMgmtErrorCopy(new HeartwoodDeviceError('stale_management_challenge', 'm'))).toBe(MGMT_CHANGED_COPY);
  });

  it('through the hand-off, the banner text carries the whole reply', () => {
    const e = new HandoffNoAnswerError(new HeartwoodDeviceError(LONG, 'list_identities'));
    expect(e.message).toBe(`Your Heartwood replied: "${LONG}". Or choose Through My Signet.`);
  });
});

describe('isDeviceAnswerOrUnreachable', () => {
  it('is true for a device reply or a relay failure, false for a timeout', () => {
    expect(isDeviceAnswerOrUnreachable(new HeartwoodDeviceError('x', 'm'))).toBe(true);
    expect(isDeviceAnswerOrUnreachable(new Error('failed to publish to any relay'))).toBe(true);
    expect(isDeviceAnswerOrUnreachable(new Error('timeout waiting for device (list_identities)'))).toBe(false);
  });
});

describe('copy is mapped once', () => {
  it('a message already in plain words passes through, brackets, quotes and all', () => {
    const once = heartwoodMgmtErrorCopy(new HeartwoodDeviceError('failed to publish (slot_table) {x}', 'revoke_client'));
    expect(once).toBe('Your Heartwood replied: "failed to publish (slot_table) {x}".');
    expect(heartwoodMgmtErrorCopy(new HeartwoodCopyError(once))).toBe(once);
  });

  it("a device's double quotes are dropped, so the quoted text can't be closed early", () => {
    expect(heartwoodMgmtErrorCopy(new HeartwoodDeviceError('said "no" twice', 'm'))).toBe('Your Heartwood replied: "said no twice".');
  });

  it('a long device text is cut by character, never through a surrogate pair', () => {
    const text = `${'a'.repeat(DEVICE_TEXT_MAX - 2)}😀😀😀`;
    const out = heartwoodMgmtErrorCopy(new HeartwoodDeviceError(text, 'm'));
    const quoted = out.slice('Your Heartwood replied: "'.length, -'".'.length);
    expect(Array.from(quoted)).toHaveLength(DEVICE_TEXT_MAX);
    expect(quoted.endsWith('😀…')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(quoted)).toBe(false);
  });
});
