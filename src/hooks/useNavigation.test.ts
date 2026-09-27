// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNavigation } from './useNavigation';

describe('useNavigation back at the bottom of history', () => {
  beforeEach(() => {
    window.history.replaceState(null, '');
  });

  it('goes home instead of a dead history.back() when the page was only ever replaced', () => {
    const setPage = vi.fn();
    const back = vi.spyOn(window.history, 'back');
    const { result } = renderHook(() => useNavigation(setPage));
    act(() => result.current.navigateReplace('contacts-grant-approve'));
    act(() => result.current.navigateReplace('companion-apps'));
    setPage.mockClear();
    act(() => result.current.navigateBack());
    expect(back).not.toHaveBeenCalled();
    expect(setPage).toHaveBeenCalledWith('home');
    expect(window.history.state).toEqual({ page: 'home', depth: 0 });
    back.mockRestore();
  });

  it('still uses history.back() when there is an in-app entry below', () => {
    const setPage = vi.fn();
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const { result } = renderHook(() => useNavigation(setPage));
    act(() => result.current.navigateTo('settings'));
    act(() => result.current.navigateReplace('companion-apps'));
    expect(window.history.state).toEqual({ page: 'companion-apps', depth: 1 });
    act(() => result.current.navigateBack());
    expect(back).toHaveBeenCalledOnce();
    back.mockRestore();
  });
});
