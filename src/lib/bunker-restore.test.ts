import { describe, it, expect } from 'vitest';
import { resolveStayAwakeOnUnlock, mergeRestoredStayAwake, shouldRearmAlwaysOn, type RearmAlwaysOnInput } from './bunker-restore';

describe('resolveStayAwakeOnUnlock', () => {
  const now = 1_790_000_000_000;
  it('resumes a window still running, with the same end (never extended)', () => {
    expect(resolveStayAwakeOnUnlock(now + 90_000, now)).toBe(now + 90_000);
  });
  it('drops a window that has ended', () => {
    expect(resolveStayAwakeOnUnlock(now - 1, now)).toBeNull();
    expect(resolveStayAwakeOnUnlock(now, now)).toBeNull();
  });
  it('drops nothing / junk', () => {
    expect(resolveStayAwakeOnUnlock(undefined, now)).toBeNull();
    expect(resolveStayAwakeOnUnlock(null, now)).toBeNull();
    expect(resolveStayAwakeOnUnlock(Number.NaN, now)).toBeNull();
    expect(resolveStayAwakeOnUnlock(Number.POSITIVE_INFINITY, now)).toBeNull();
    expect(resolveStayAwakeOnUnlock('123' as unknown as number, now)).toBeNull();
  });
});

describe('mergeRestoredStayAwake', () => {
  it('keeps the later of an open window and the restored one', () => {
    expect(mergeRestoredStayAwake(null, 500)).toBe(500);
    expect(mergeRestoredStayAwake(400, 500)).toBe(500);
    expect(mergeRestoredStayAwake(600, 500)).toBe(600);
  });
});

describe('shouldRearmAlwaysOn', () => {
  const ready: RearmAlwaysOnInput = {
    native: true, unlocked: true, prefsLoading: false, enabledPref: true,
    serving: false, inFlight: false, servePubkeyCount: 1,
  };
  it('re-arms once unlocked, prefs loaded and routes present', () => {
    expect(shouldRearmAlwaysOn(ready)).toBe(true);
  });
  it('waits for the serve routes (empty right after unlock)', () => {
    expect(shouldRearmAlwaysOn({ ...ready, servePubkeyCount: 0 })).toBe(false);
  });
  it('waits for preferences to load', () => {
    expect(shouldRearmAlwaysOn({ ...ready, prefsLoading: true })).toBe(false);
  });
  it('never serves before unlock', () => {
    expect(shouldRearmAlwaysOn({ ...ready, unlocked: false })).toBe(false);
  });
  it('only when the user left always-on set', () => {
    expect(shouldRearmAlwaysOn({ ...ready, enabledPref: undefined })).toBe(false);
    expect(shouldRearmAlwaysOn({ ...ready, enabledPref: false })).toBe(false);
  });
  it('not twice: already serving or an arm in flight', () => {
    expect(shouldRearmAlwaysOn({ ...ready, serving: true })).toBe(false);
    expect(shouldRearmAlwaysOn({ ...ready, inFlight: true })).toBe(false);
  });
  it('never on the web', () => {
    expect(shouldRearmAlwaysOn({ ...ready, native: false })).toBe(false);
  });
});
