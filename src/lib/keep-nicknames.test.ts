// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { clearKeepNicknames, loadNicknames, setNickname } from './keep-nicknames';
import { purgeAllUserData } from './db';

const N1 = 'a1'.repeat(32), N2 = 'b2'.repeat(32);
beforeEach(() => { localStorage.clear(); });

describe('keep nicknames', () => {
  it('saves per identity and node, trims, caps and clears on empty', () => {
    setNickname('idA', N1, '  Study  ');
    setNickname('idB', N1, 'Garage');
    expect(loadNicknames('idA')).toEqual({ [N1]: 'Study' });
    expect(loadNicknames('idB')).toEqual({ [N1]: 'Garage' });
    expect(setNickname('idA', N2, 'x'.repeat(50))[N2]).toHaveLength(32);
    expect(setNickname('idA', N1, '   ')).not.toHaveProperty(N1);
    expect(loadNicknames('idA')).not.toHaveProperty(N1);
  });

  it('does not match a longer identity id that merely starts the same', () => {
    setNickname('id', N1, 'Short');
    setNickname('id:2', N1, 'Other');
    expect(loadNicknames('id')).toEqual({ [N1]: 'Short' });
  });

  it('clearKeepNicknames removes them for every identity and leaves other keys', () => {
    setNickname('idA', N1, 'Study'); setNickname('idB', N2, 'Garage');
    localStorage.setItem('unrelated', 'keep me');
    clearKeepNicknames();
    expect(loadNicknames('idA')).toEqual({});
    expect(loadNicknames('idB')).toEqual({});
    expect(localStorage.getItem('unrelated')).toBe('keep me');
  });

  it('is cleared when the account data is purged', async () => {
    setNickname('idA', N1, 'Study');
    await purgeAllUserData();
    expect(loadNicknames('idA')).toEqual({});
  });
});
