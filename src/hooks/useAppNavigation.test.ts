// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Page, PersonaAdvancedRoute } from '../types';
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
      act(() => result.current.chooseDependantScope('dep-x'));            // "Managing X"
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
    act(() => result.current.chooseDependantScope('dep-x'));
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
    act(() => result.current.chooseDependantScope('dep-x'));
    act(() => result.current.openDependantPage('persona-advanced', 'dep-x'));
    await back(result, 'home');
    expect(result.current.activeDependantId).toBe('dep-x');
  });

  it('never takes child mode back to owner pages from before it was entered', async () => {
    const { result, rerender, props } = setup();
    act(() => result.current.navigateTo('settings'));
    act(() => result.current.navigateTo('family-list'));
    act(() => result.current.chooseDependantScope('dep-x'));             // hand-off picker → child mode
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
      result.current.chooseDependantScope('dep-x');
      result.current.navigateReplace('home');
    });
    expect(result.current.page).toBe('home');
    expect(result.current.activeDependantId).toBe('dep-x');
  });

  it('"Back to me" on a management page (set null, then home) lands on the owner', () => {
    const { result } = setup();
    act(() => result.current.chooseDependantScope('dep-x'));
    act(() => result.current.openDependantPage('settings', 'dep-x'));
    act(() => {
      result.current.chooseDependantScope(null);
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

/**
 * App opens a slot's Advanced page with openPersonaAdvanced: the slot rides on
 * the entry as its parameter, under the slot's own scope. The page renders its
 * slot from `pageParam` and its "Managing …" banner from `activeDependantId`.
 */
function openAdvanced(nav: { openDependantPage: (p: Page, id: string | null, param?: unknown) => void }, route: PersonaAdvancedRoute) {
  nav.openDependantPage('persona-advanced', route.depPubkey ?? null, route);
}
const shown = (r: { current: { page: Page; pageParam: unknown; activeDependantId: string | null } }) => ({
  page: r.current.page, slot: r.current.pageParam, banner: r.current.activeDependantId,
});

describe('useAppNavigation: a page parameter rides on its history entry', () => {
  beforeEach(() => {
    window.history.replaceState(null, '');
  });

  const aSlot: PersonaAdvancedRoute = { slotTarget: 'persona', depPubkey: 'dep-x' };
  const bSlot: PersonaAdvancedRoute = { slotTarget: 'persona', depPubkey: 'dep-b' };
  const ownerSlot: PersonaAdvancedRoute = { slotTarget: 'persona' };

  it("back ×3 to A's Advanced page shows A's slot under A's banner, not B's", async () => {
    const { result } = setup();
    act(() => openAdvanced(result.current, aSlot));                      // A's card → Advanced
    act(() => result.current.navigateTo('home'));                        // Home
    act(() => openAdvanced(result.current, bSlot));                      // B's card → Advanced
    act(() => result.current.navigateTo('home'));                        // Home
    await back(result, 'persona-advanced');
    expect(shown(result)).toEqual({ page: 'persona-advanced', slot: bSlot, banner: 'dep-b' });
    await back(result, 'home');
    await back(result, 'persona-advanced');
    expect(shown(result)).toEqual({ page: 'persona-advanced', slot: aSlot, banner: 'dep-x' });
  });

  it("back ×3 to A's Advanced page after the owner's shows A's slot, not the owner's persona", async () => {
    const { result } = setup();
    act(() => openAdvanced(result.current, aSlot));
    act(() => result.current.navigateTo('home'));
    act(() => openAdvanced(result.current, ownerSlot));                  // owner's persona card → Advanced
    expect(shown(result)).toEqual({ page: 'persona-advanced', slot: ownerSlot, banner: null });
    act(() => result.current.navigateTo('home'));
    await back(result, 'persona-advanced');
    expect(shown(result)).toEqual({ page: 'persona-advanced', slot: ownerSlot, banner: null });
    await back(result, 'home');
    await back(result, 'persona-advanced');
    expect(shown(result)).toEqual({ page: 'persona-advanced', slot: aSlot, banner: 'dep-x' });
  });

  it("back ×3 to the owner's Advanced page after A's shows the owner's slot with no banner", async () => {
    const { result } = setup();
    act(() => openAdvanced(result.current, ownerSlot));
    act(() => result.current.navigateTo('home'));
    act(() => openAdvanced(result.current, aSlot));
    act(() => result.current.navigateTo('home'));
    await back(result, 'persona-advanced');
    await back(result, 'home');
    await back(result, 'persona-advanced');
    expect(shown(result)).toEqual({ page: 'persona-advanced', slot: ownerSlot, banner: null });
    expect(result.current.tabs).toContain('bunker');
  });

  it('a page reached without a parameter has none, and home never keeps one', async () => {
    const { result } = setup();
    act(() => openAdvanced(result.current, aSlot));
    act(() => result.current.navigateTo('settings'));
    expect(result.current.pageParam).toBeUndefined();
    await back(result, 'persona-advanced');
    expect(result.current.pageParam).toEqual(aSlot);
    act(() => result.current.navigateReplace('home'));
    expect(result.current.pageParam).toBeUndefined();
  });

  it('an entry whose target is gone goes home', async () => {
    let live = true;
    const hook = renderHook(() => useAppNavigation({
      isLive: () => true,
      isScopeLocked: () => false,
      needsDependant: () => false,
      isPageParamLive: (page, param) => page !== 'persona-advanced' || (live && param !== undefined),
    }));
    act(() => hook.result.current.openDependantPage('persona-advanced', null, ownerSlot));
    act(() => hook.result.current.navigateTo('home'));
    live = false;                                                         // the extra persona was deleted
    act(() => hook.result.current.navigateBack());
    await waitFor(() => expect(window.history.state).toMatchObject({ page: 'home' }));
    expect(hook.result.current.page).toBe('home');
    expect(hook.result.current.pageParam).toBeUndefined();
  });
});

describe('useAppNavigation: a removed dependant stays ended for the session', () => {
  beforeEach(() => {
    window.history.replaceState(null, '');
  });

  it('removing the managed dependant from their Advanced page does not come back when a sync re-merges them', async () => {
    const { result, rerender, props } = setup();
    act(() => result.current.chooseDependantScope('dep-x'));             // "Managing X"
    act(() => openAdvanced(result.current, { slotTarget: 'persona', depPubkey: 'dep-x' }));
    act(() => result.current.endDependantScope('dep-x'));                // Remove dependant
    rerender({ ...props, dependants: ['dep-b'] });
    await back(result, 'home');
    expect(result.current.activeDependantId).toBeNull();
    rerender({ ...props, dependants: ['dep-x', 'dep-b'] });              // the dependants rail merges X back
    expect(result.current.activeDependantId).toBeNull();
    expect(result.current.tabs).toContain('bunker');
  });

  it('a history entry for a removed-then-re-merged dependant goes home under the owner', async () => {
    const { result, rerender, props } = setup();
    act(() => result.current.openDependantPage('settings', 'dep-x'));
    act(() => result.current.navigateTo('home'));
    act(() => result.current.endDependantScope('dep-x'));                // removed (ceremony, Advanced…)
    rerender({ ...props, dependants: ['dep-b'] });
    rerender({ ...props, dependants: ['dep-x', 'dep-b'] });              // merged back
    act(() => result.current.navigateBack());
    await waitFor(() => expect(window.history.state).toMatchObject({ page: 'home' }));
    expect(result.current.page).toBe('home');
    expect(result.current.activeDependantId).toBeNull();
  });

  it('a removed dependant is not the scope put back on reaching home', () => {
    const { result, rerender, props } = setup();
    act(() => result.current.chooseDependantScope('dep-x'));
    act(() => result.current.openDependantPage('settings', 'dep-b'));    // restore target: X
    act(() => result.current.endDependantScope('dep-x'));
    rerender({ ...props, dependants: ['dep-b'] });
    rerender({ ...props, dependants: ['dep-x', 'dep-b'] });
    act(() => result.current.openDependantPage('pair-dependant-device', 'dep-x')); // X chosen again later
    act(() => result.current.navigateTo('home'));
    expect(result.current.activeDependantId).toBeNull();
  });

  it('choosing the dependant again on purpose brings them back', () => {
    const { result, rerender, props } = setup();
    act(() => result.current.chooseDependantScope('dep-x'));
    act(() => result.current.endDependantScope('dep-x'));
    rerender({ ...props, dependants: ['dep-x', 'dep-b'] });
    expect(result.current.activeDependantId).toBeNull();
    act(() => result.current.chooseDependantScope('dep-x'));             // "Switch to X"
    expect(result.current.activeDependantId).toBe('dep-x');
  });

  it("opening the dependant's page on purpose brings them back for that page", () => {
    const { result } = setup();
    act(() => result.current.endDependantScope('dep-x'));
    act(() => result.current.openDependantPage('settings', 'dep-x'));    // X's card → Settings
    expect(result.current.activeDependantId).toBe('dep-x');
    expect(window.history.state).toMatchObject({ page: 'settings', dependantId: 'dep-x' });
  });
});

describe('useAppNavigation: the only way to change the page or the scope', () => {
  it('exposes no raw page or scope setter', () => {
    const { result } = renderHook(() => useAppNavigation({
      isLive: () => true, isScopeLocked: () => false, needsDependant: () => false,
    }));
    expect(Object.keys(result.current).sort()).toEqual([
      'activeDependantId', 'borrowActiveDependantId', 'chooseDependantScope', 'endDependantScope',
      'keepActiveDependantId', 'navigateBack', 'navigateReplace', 'navigateTo', 'openDependantPage',
      'page', 'pageParam',
    ]);
  });
});

describe('useAppNavigation: pairing a phone from Add Dependant', () => {
  beforeEach(() => {
    window.history.replaceState(null, '');
  });

  // Add Dependant's "Pair their phone now": the pair page takes the form's entry.
  const pairFromAddDependant = (result: ReturnType<typeof setup>['result'], origin: Page = 'home') => {
    if (origin !== 'home') act(() => result.current.navigateTo(origin));
    act(() => result.current.navigateTo('add-dependant'));
    act(() => {
      result.current.borrowActiveDependantId('dep-b');
      result.current.navigateReplace('pair-dependant-device');
    });
  };

  it('opens the pair page for the new dependant', () => {
    const { result } = setup();
    pairFromAddDependant(result);
    expect(result.current.page).toBe('pair-dependant-device');
    expect(result.current.activeDependantId).toBe('dep-b');
    expect(window.history.state).toMatchObject({ page: 'pair-dependant-device', dependantId: 'dep-b' });
  });

  it('back from the pair page lands on home under the owner, never the Add Dependant form', async () => {
    const { result } = setup();
    pairFromAddDependant(result);
    await back(result, 'home');
    expect(result.current.activeDependantId).toBeNull();
    expect(result.current.tabs).toContain('bunker');
    // Home is not doubled: the entry under the pair page was home already.
    expect(window.history.state).toMatchObject({ page: 'home' });
    expect(window.history.state?.depth ?? 0).toBe(0);
  });

  it('opened from the family list, back returns to the family list', async () => {
    const { result } = setup();
    pairFromAddDependant(result, 'family-list');
    await back(result, 'family-list');
    expect(result.current.activeDependantId).toBeNull();
  });

  it("the pair page opened from the dependant's settings still goes back to those settings", async () => {
    const { result } = setup();
    act(() => result.current.openDependantPage('settings', 'dep-b'));
    act(() => result.current.navigateTo('pair-dependant-device'));
    await back(result, 'settings');
    expect(result.current.activeDependantId).toBe('dep-b');
  });
});

describe('useAppNavigation: live child mode keeps the child scope', () => {
  beforeEach(() => {
    window.history.replaceState(null, '');
  });

  /** A guardian hands the phone to `kid`: the scope is chosen, then child mode is live. */
  const inChildMode = () => {
    const hook = setup({ dependants: ['kid', 'dep-b'] });
    act(() => hook.result.current.chooseDependantScope('kid'));
    hook.rerender({ ...hook.props, childMode: true });
    return hook;
  };

  it("a page opened for the owner (null) leaves the child's scope, and the pages after it, in place", () => {
    const { result } = inChildMode();
    act(() => result.current.openDependantPage('contacts', null));
    expect(result.current.page).toBe('contacts');
    expect(result.current.activeDependantId).toBe('kid');
    expect(result.current.tabs).not.toContain('bunker');
    expect(window.history.state).toMatchObject({ page: 'contacts', dependantId: 'kid' });
    act(() => result.current.navigateTo('settings'));
    expect(result.current.activeDependantId).toBe('kid');
    act(() => result.current.navigateTo('home'));
    expect(result.current.activeDependantId).toBe('kid');
    expect(result.current.tabs).not.toContain('bunker');
  });

  it("a page opened for a sibling, or a borrowed id, does not take the child's scope either", () => {
    const { result } = inChildMode();
    act(() => result.current.openDependantPage('settings', 'dep-b'));
    expect(result.current.activeDependantId).toBe('kid');
    act(() => result.current.borrowActiveDependantId(null));
    expect(result.current.activeDependantId).toBe('kid');
    act(() => result.current.borrowActiveDependantId('dep-b'));
    expect(result.current.activeDependantId).toBe('kid');
    act(() => result.current.navigateTo('home'));
    expect(result.current.activeDependantId).toBe('kid');
  });

  it("exit still clears the scope: handleExitChildMode's choice lands while the lock is still on", () => {
    const { result } = inChildMode();
    act(() => result.current.openDependantPage('contacts', null));
    act(() => result.current.chooseDependantScope(null));
    expect(result.current.activeDependantId).toBeNull();
    expect(result.current.tabs).toContain('bunker');
  });

  it('switching child mode to a sibling still sets the sibling', () => {
    const { result } = inChildMode();
    act(() => result.current.chooseDependantScope('dep-b'));
    expect(result.current.activeDependantId).toBe('dep-b');
  });

  it('entering child mode still sets the scope (the lock is not on yet)', () => {
    const { result } = setup({ dependants: ['kid'] });
    act(() => result.current.chooseDependantScope('kid'));
    expect(result.current.activeDependantId).toBe('kid');
  });
});
