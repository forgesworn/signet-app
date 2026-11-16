// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { useState } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Page } from '../types';
import { useDependantScope } from './useDependantScope';
import { useNavigation } from './useNavigation';
import { barTabsFor } from '../lib/app-nav';

/** The same wiring App.tsx uses: page state → scope wrapper → navigation. */
function useAppLikeNavigation() {
  const [page, setPageState] = useState<Page>('home');
  const scope = useDependantScope(setPageState);
  const nav = useNavigation(scope.setPage);
  const tabs = barTabsFor({ isDependantContext: !!scope.activeDependantId }).map(t => t.id);
  return { page, ...scope, ...nav, tabs };
}

describe('useDependantScope with useNavigation', () => {
  beforeEach(() => {
    window.history.replaceState(null, '');
  });

  it('brings the Bunker tab back after Phone & Pairing for a dependant and the back button', async () => {
    const { result } = renderHook(() => useAppLikeNavigation());
    expect(result.current.tabs).toContain('bunker');

    // Carousel settings card → Phone & Pairing (App's onNavigateDeepPage).
    act(() => {
      result.current.borrowActiveDependantId('dep-a');
      result.current.navigateTo('pair-dependant-device');
    });
    expect(result.current.page).toBe('pair-dependant-device');
    expect(result.current.activeDependantId).toBe('dep-a');
    expect(result.current.tabs).not.toContain('bunker');

    act(() => result.current.navigateBack());
    await waitFor(() => expect(result.current.page).toBe('home'));
    expect(result.current.activeDependantId).toBeNull();
    expect(result.current.tabs).toContain('bunker');
  });

  it('brings the Bunker tab back when the Home tab is tapped from deeper management pages', () => {
    const { result } = renderHook(() => useAppLikeNavigation());
    act(() => {
      result.current.borrowActiveDependantId('dep-a');
      result.current.navigateTo('settings');
    });
    act(() => result.current.navigateTo('pair-dependant-device'));
    expect(result.current.activeDependantId).toBe('dep-a');

    act(() => result.current.navigateTo('home'));
    expect(result.current.activeDependantId).toBeNull();
    expect(result.current.tabs).toContain('bunker');
  });

  it('keeps deliberate child mode through a deep-link to the same child and back', async () => {
    const { result } = renderHook(() => useAppLikeNavigation());
    act(() => result.current.setActiveDependantId('dep-a'));
    act(() => {
      result.current.borrowActiveDependantId('dep-a');
      result.current.navigateTo('persona-advanced');
    });
    act(() => result.current.navigateBack());
    await waitFor(() => expect(result.current.page).toBe('home'));
    expect(result.current.activeDependantId).toBe('dep-a');
    expect(result.current.tabs).not.toContain('bunker');
  });

  it('"Hand this phone to …" (set, then replace to home) is not undone', () => {
    const { result } = renderHook(() => useAppLikeNavigation());
    act(() => result.current.navigateTo('add-dependant'));
    act(() => {
      result.current.setActiveDependantId('dep-new');
      result.current.navigateReplace('home');
    });
    expect(result.current.page).toBe('home');
    expect(result.current.activeDependantId).toBe('dep-new');
  });

  it('"Back to me" on a management page (set null, then home) lands on the owner', () => {
    const { result } = renderHook(() => useAppLikeNavigation());
    act(() => result.current.setActiveDependantId('dep-a'));
    act(() => {
      result.current.borrowActiveDependantId('dep-a');
      result.current.navigateTo('settings');
    });
    act(() => {
      result.current.setActiveDependantId(null);
      result.current.navigateTo('home');
    });
    expect(result.current.activeDependantId).toBeNull();
    expect(result.current.tabs).toContain('bunker');
  });
});
