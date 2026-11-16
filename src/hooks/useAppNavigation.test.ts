// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Page } from '../types';
import { useAppNavigation } from './useAppNavigation';
import { barTabsFor } from '../lib/app-nav';
import { pageNeedsDependant } from '../lib/dependant-scope';

interface Props { dependants: string[]; childMode: boolean }

/** Wired as App.tsx wires it, with the bottom bar App derives from the scope. */
function setup(initial: Partial<Props> = {}) {
  const props: Props = { dependants: ['dep-x', 'dep-b'], childMode: false, ...initial };
  const hook = renderHook((p: Props) => {
    const nav = useAppNavigation({
      isLive: id => p.dependants.includes(id),
      isScopeLocked: () => p.childMode,
      needsDependant: page => pageNeedsDependant(page),
    });
    return { ...nav, tabs: barTabsFor({ isDependantContext: !!nav.activeDependantId }).map(t => t.id) };
  }, { initialProps: props });
  return { ...hook, props };
}

async function back(result: { current: { navigateBack: () => void; page: Page } }, expected: Page) {
  act(() => result.current.navigateBack());
  await waitFor(() => expect(result.current.page).toBe(expected));
}

describe('useAppNavigation: a borrowed dependant scope', () => {
  beforeEach(() => {
    window.history.replaceState(null, '');
  });

  it('brings the Bunker tab back after Phone & Pairing for a dependant and the back button', async () => {
    const { result } = setup();
    expect(result.current.tabs).toContain('bunker');
    act(() => result.current.openDependantPage('pair-dependant-device', 'dep-b'));
    expect(result.current.activeDependantId).toBe('dep-b');
    expect(result.current.tabs).not.toContain('bunker');
    expect(window.history.state).toMatchObject({ page: 'pair-dependant-device', dependantId: 'dep-b' });

    await back(result, 'home');
    expect(result.current.activeDependantId).toBeNull();
    expect(result.current.tabs).toContain('bunker');
  });

  it('brings the Bunker tab back when the Home tab is tapped from deeper management pages', () => {
    const { result } = setup();
    act(() => result.current.openDependantPage('settings', 'dep-b'));
    act(() => result.current.navigateTo('pair-dependant-device'));
    expect(result.current.activeDependantId).toBe('dep-b');
    act(() => result.current.navigateTo('home'));
    expect(result.current.activeDependantId).toBeNull();
    expect(result.current.tabs).toContain('bunker');
  });

  it.each(['pair-dependant-device', 'settings'] as const)(
    'back after Home re-opens %s for the dependant it was opened for, never the managed one',
    async (page) => {
      const { result } = setup();
      act(() => result.current.setActiveDependantId('dep-x'));            // "Managing X"
      act(() => result.current.openDependantPage(page, 'dep-b'));         // B's card → page
      act(() => result.current.navigateTo('home'));                       // Home tab
      expect(result.current.activeDependantId).toBe('dep-x');

      await back(result, page);
      expect(result.current.activeDependantId).toBe('dep-b');

      await back(result, 'home');
      expect(result.current.activeDependantId).toBe('dep-x');
    },
  );

  it('back after Home re-opens the page for its dependant when nothing was managed before', async () => {
    const { result } = setup();
    act(() => result.current.openDependantPage('pair-dependant-device', 'dep-b'));
    act(() => result.current.navigateTo('home'));
    expect(result.current.tabs).toContain('bunker');
    await back(result, 'pair-dependant-device');
    expect(result.current.activeDependantId).toBe('dep-b');
  });

  it('back to a page whose dependant was removed lands on home, with the bar', async () => {
    const { result, rerender, props } = setup();
    act(() => result.current.openDependantPage('pair-dependant-device', 'dep-b'));
    act(() => result.current.navigateTo('home'));
    rerender({ ...props, dependants: ['dep-x'] });                       // B removed (ceremony, sync, …)
    act(() => result.current.navigateBack());
    await waitFor(() => expect(window.history.state).toMatchObject({ page: 'home' }));
    expect(result.current.page).toBe('home');
    expect(result.current.activeDependantId).toBeNull();
    expect(result.current.tabs).toContain('bunker');
  });

  it('a removed dependant reads as the owner, as the current scope and as the restore target', () => {
    const { result, rerender, props } = setup();
    act(() => result.current.setActiveDependantId('dep-x'));
    act(() => result.current.openDependantPage('settings', 'dep-b'));
    rerender({ ...props, dependants: [] });
    expect(result.current.activeDependantId).toBeNull();
    act(() => result.current.navigateTo('home'));
    expect(result.current.activeDependantId).toBeNull();
    expect(result.current.tabs).toContain('bunker');
  });

  it('back from a dependant page re-shows owner pages under the owner', async () => {
    const { result } = setup();
    act(() => result.current.navigateTo('settings'));
    act(() => result.current.navigateTo('family-list'));
    act(() => result.current.openDependantPage('settings', 'dep-b'));
    await back(result, 'family-list');
    expect(result.current.activeDependantId).toBeNull();
    await back(result, 'settings');
    expect(result.current.activeDependantId).toBeNull();
  });

  it('keeps deliberate child mode through a deep-link to the same child and back', async () => {
    const { result } = setup({ childMode: true });
    act(() => result.current.setActiveDependantId('dep-x'));
    act(() => result.current.openDependantPage('persona-advanced', 'dep-x'));
    await back(result, 'home');
    expect(result.current.activeDependantId).toBe('dep-x');
  });

  it('never takes child mode back to owner pages from before it was entered', async () => {
    const { result, rerender, props } = setup();
    act(() => result.current.navigateTo('settings'));
    act(() => result.current.navigateTo('family-list'));
    act(() => result.current.setActiveDependantId('dep-x'));             // hand-off picker → child mode
    rerender({ ...props, childMode: true });
    act(() => result.current.navigateBack());
    await waitFor(() => expect(window.history.state).toMatchObject({ page: 'home' }));
    expect(result.current.page).toBe('home');
    expect(result.current.activeDependantId).toBe('dep-x');
  });

  it('"Hand this phone to …" (set, then replace to home) is not undone', () => {
    const { result } = setup();
    act(() => result.current.openDependantPage('settings', 'dep-b'));
    act(() => result.current.navigateTo('add-dependant'));
    act(() => {
      result.current.setActiveDependantId('dep-x');
      result.current.navigateReplace('home');
    });
    expect(result.current.page).toBe('home');
    expect(result.current.activeDependantId).toBe('dep-x');
  });

  it('"Back to me" on a management page (set null, then home) lands on the owner', () => {
    const { result } = setup();
    act(() => result.current.setActiveDependantId('dep-x'));
    act(() => result.current.openDependantPage('settings', 'dep-x'));
    act(() => {
      result.current.setActiveDependantId(null);
      result.current.navigateTo('home');
    });
    expect(result.current.activeDependantId).toBeNull();
    expect(result.current.tabs).toContain('bunker');
  });

  it('an import backed out of returns to the owner; "Switch to" keeps the new dependant', async () => {
    const { result } = setup();
    act(() => result.current.navigateTo('import-dependant'));
    act(() => result.current.borrowActiveDependantId('dep-b'));          // import finished
    await back(result, 'home');                                           // "Stay as me"
    expect(result.current.activeDependantId).toBeNull();

    act(() => result.current.navigateTo('import-dependant'));
    act(() => result.current.borrowActiveDependantId('dep-b'));
    act(() => {
      result.current.keepActiveDependantId();                             // "Switch to"
      result.current.navigateReplace('home');
    });
    expect(result.current.activeDependantId).toBe('dep-b');
  });
});
