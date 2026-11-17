import { describe, it, expect } from 'vitest';
import { CHILD_READY_COPY as COPY } from './child-ready-copy';
import { HEARTWOOD_HOLD_TO_FINISH } from './local-key-only-copy';

describe('CHILD_READY_COPY', () => {
  it('says the agreed words', () => {
    expect(COPY.notReadyHeading).toBe('Not ready away from home');
    expect(COPY.doAtHome).toBe('Do this at home, with the Heartwood in reach.');
    expect(COPY.finishNow).toBe('Finish now');
    expect(COPY.ready).toBe('Ready to use away from home.');
    expect(COPY.pressAndHold).toBe('Press and hold the button on your Heartwood to finish.');
    expect(COPY.pressAndHold).toBe(HEARTWOOD_HOLD_TO_FINISH);
    expect([COPY.state.waiting, COPY.state.ready, COPY.state.skipped]).toEqual(['Waiting for a press', 'Ready', 'Skipped']);
  });

  it('says plainly when this phone cannot confirm, when the slot is full, when paused and when unreachable', () => {
    expect(COPY.unknownHeading).toBe('Can\'t confirm from this phone');
    expect(COPY.unknownBody('Sky')).toBe('Your Heartwood didn\'t report what it has remembered. Check Sky\'s phone shows Ready, or update the Heartwood.');
    expect(COPY.fullHeading).toBe('Your Heartwood can\'t remember any more identities for this phone');
    expect(COPY.fullBody('Sky')).toBe('It will ask for a press each time Sky uses this one.');
    expect(COPY.paused('Sky')).toBe('Paused. Readiness will be checked when Sky is unpaused.');
    expect(COPY.unreachableHeading).toBe('Can\'t reach your family Heartwood');
    expect(COPY.unreachableBody('Alex')).toBe('If this keeps happening, ask Alex to check this phone\'s pairing.');
  });

  it('never says Ready, a press count or Finish now in the unknown, full or paused lines', () => {
    for (const line of [COPY.unknownHeading, COPY.fullHeading, COPY.fullBody('Sky'), COPY.paused('Sky')]) {
      expect(line).not.toMatch(/presses? still needed|Finish now/);
    }
    expect(COPY.unknownHeading + COPY.fullHeading + COPY.paused('Sky')).not.toMatch(/Ready/);
  });

  it('speaks to the child on the child\'s own phone: "you", never their name in the third person', () => {
    expect(COPY.child.fullBody).toBe('It will ask for a press each time you use this one.');
    expect(COPY.child.paused).toBe('Paused. Readiness will be checked when you are unpaused.');
    expect(COPY.child.unknownBody).toBe('Your Heartwood didn\'t report what it has remembered.');
    for (const line of Object.values(COPY.child)) {
      expect(line).not.toMatch(/presses? still needed|Finish now|Ready|'s phone/);
      expect(line).toMatch(/\byou(r)?\b/i);
    }
    // The guardian's lines keep the child's name.
    expect(COPY.fullBody('Sky')).toContain('Sky');
    expect(COPY.paused('Sky')).toContain('Sky');
  });

  it('on the child\'s phone, when the guardian\'s phone could not read the Heartwood: never the unqualified Ready line', () => {
    expect(COPY.childLooksReady('Alex')).toBe('Looks ready. Alex\'s phone couldn\'t confirm it with the Heartwood.');
    expect(COPY.childLooksReady(' ')).toBe('Looks ready. Your guardian\'s phone couldn\'t confirm it with the Heartwood.');
    expect(COPY.childLooksReady(null)).toBe('Looks ready. Your guardian\'s phone couldn\'t confirm it with the Heartwood.');
    expect(COPY.childLooksReady('Alex')).not.toContain(COPY.ready);
  });

  it('counts presses in the singular and the plural', () => {
    expect(COPY.pressesOwed(1)).toBe('1 press still needed on your Heartwood.');
    expect(COPY.pressesOwed(2)).toBe('2 presses still needed on your Heartwood.');
    expect(COPY.pressesOwed(5)).toBe('5 presses still needed on your Heartwood.');
  });

  it('never names the old ALLOW AS card and never names the guardian\'s real identity', () => {
    const all = JSON.stringify(COPY) + COPY.childPressHint('Sky') + COPY.onHeartwood('npub1abcdefgh..');
    expect(all).not.toMatch(/ALLOW AS/);
    expect(COPY.guardianRow).not.toMatch(/real|natural/i);
  });
});
