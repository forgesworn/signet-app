import { describe, it, expect } from 'vitest';
import { CHILD_READY_COPY as COPY } from './child-ready-copy';

describe('CHILD_READY_COPY', () => {
  it('says the agreed words', () => {
    expect(COPY.notReadyHeading).toBe('Not ready away from home');
    expect(COPY.doAtHome).toBe('Do this at home, with the Heartwood in reach.');
    expect(COPY.finishNow).toBe('Finish now');
    expect(COPY.ready).toBe('Ready to use away from home.');
    expect(COPY.pressAndHold).toBe('Press and hold the button on your Heartwood to finish.');
    expect([COPY.state.waiting, COPY.state.ready, COPY.state.skipped]).toEqual(['Waiting for a press', 'Ready', 'Skipped']);
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
