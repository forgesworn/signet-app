import { describe, it, expect } from 'vitest';
import {
  dependantScopeReducer as reduce,
  INITIAL_DEPENDANT_SCOPE,
  liveScopeId,
  pageNeedsDependant,
  resolvePoppedEntry,
  type DependantScope,
  type DependantScopeAction,
} from './dependant-scope';
import type { Page } from '../types';

function run(...actions: DependantScopeAction[]): DependantScope {
  return actions.reduce(reduce, INITIAL_DEPENDANT_SCOPE);
}

describe('dependantScopeReducer', () => {
  it('puts the owner scope back on reaching home after a management deep-link', () => {
    // Carousel → Phone & Pairing for a dependant → back to home.
    const borrowed = run({ type: 'borrow', id: 'dep-a' });
    expect(borrowed.id).toBe('dep-a');
    expect(reduce(borrowed, { type: 'arrived-home' })).toEqual({ id: null, restore: null });
  });

  it('keeps the scope from before the FIRST borrow across nested management pages', () => {
    // Family list → dependant A's settings → back → dependant B's settings → home.
    const s = run(
      { type: 'borrow', id: 'dep-a' },
      { type: 'borrow', id: 'dep-b' },
      { type: 'arrived-home' },
    );
    expect(s).toEqual({ id: null, restore: null });
  });

  it('leaves deliberately entered child mode alone when a deep-link names the same child', () => {
    const s = run(
      { type: 'set', id: 'dep-a' },      // child mode entered
      { type: 'borrow', id: 'dep-a' },   // Advanced cog on the child's card
      { type: 'arrived-home' },
    );
    expect(s).toEqual({ id: 'dep-a', restore: null });
  });

  it('puts a deliberate scope back even when the management page borrowed someone else', () => {
    const s = run(
      { type: 'set', id: 'dep-a' },
      { type: 'borrow', id: null },
      { type: 'arrived-home' },
    );
    expect(s.id).toBe('dep-a');
  });

  it('"Back to me" on a management page stays the owner on reaching home', () => {
    // guardianLayoutProps onExitGuardianMode: set(null), then navigateTo('home').
    const s = run(
      { type: 'set', id: 'dep-a' },
      { type: 'borrow', id: 'dep-a' },
      { type: 'set', id: null },
      { type: 'arrived-home' },
    );
    expect(s).toEqual({ id: null, restore: null });
  });

  it('"Hand this phone to …" from a management page keeps the dependant on reaching home', () => {
    const s = run(
      { type: 'borrow', id: 'dep-b' },
      { type: 'set', id: 'dep-a' },
      { type: 'arrived-home' },
    );
    expect(s).toEqual({ id: 'dep-a', restore: null });
  });

  it('commit keeps a borrowed scope past home ("Switch to …" after an import)', () => {
    const s = run(
      { type: 'borrow', id: 'dep-new' },
      { type: 'commit' },
      { type: 'arrived-home' },
    );
    expect(s).toEqual({ id: 'dep-new', restore: null });
  });

  it('without commit an import backed out of ("Stay as me") returns to the owner', () => {
    const s = run({ type: 'borrow', id: 'dep-new' }, { type: 'arrived-home' });
    expect(s.id).toBeNull();
  });

  it('returns the same state object when nothing changes, so React can bail out', () => {
    const s = run({ type: 'set', id: 'dep-a' });
    expect(reduce(s, { type: 'arrived-home' })).toBe(s);
    expect(reduce(s, { type: 'commit' })).toBe(s);
    expect(reduce(s, { type: 'set', id: 'dep-a' })).toBe(s);
  });
});

describe('dependantScopeReducer: a removed dependant is ended', () => {
  it('stops being the scope and the restore target', () => {
    expect(run({ type: 'set', id: 'dep-a' }, { type: 'ended', id: 'dep-a' })).toMatchObject({ id: null, restore: null });
    const s = run({ type: 'set', id: 'dep-a' }, { type: 'borrow', id: 'dep-b' }, { type: 'ended', id: 'dep-a' });
    expect(s).toMatchObject({ id: 'dep-b', restore: { id: null } });
    expect(reduce(s, { type: 'arrived-home' }).id).toBeNull();
    expect(s.ended?.has('dep-a')).toBe(true);
  });

  it('stays ended until the user chooses that dependant again', () => {
    const ended = run({ type: 'set', id: 'dep-a' }, { type: 'ended', id: 'dep-a' });
    expect(reduce(ended, { type: 'arrived-home' }).ended?.has('dep-a')).toBe(true);
    expect(reduce(ended, { type: 'set', id: 'dep-a' })).toEqual({ id: 'dep-a', restore: null });
    expect(reduce(ended, { type: 'borrow', id: 'dep-a' }).ended).toBeUndefined();
    expect(reduce(ended, { type: 'set', id: 'dep-b' }).ended?.has('dep-a')).toBe(true);
  });
});

describe('liveScopeId', () => {
  const live = (id: string) => id === 'dep-a';
  it('reads a removed dependant as the owner', () => {
    expect(liveScopeId('dep-a', live)).toBe('dep-a');
    expect(liveScopeId('dep-gone', live)).toBeNull();
    expect(liveScopeId(null, live)).toBeNull();
  });

  it('reads a dependant ended this session as the owner even when the record is back', () => {
    expect(liveScopeId('dep-a', live, new Set(['dep-a']))).toBeNull();
    expect(liveScopeId('dep-a', live, new Set(['dep-b']))).toBe('dep-a');
  });
});

describe('resolvePoppedEntry', () => {
  const live = (id: string) => id === 'dep-x' || id === 'dep-b';
  const base = { isLive: live, locked: false, needsDependant: false };
  const pop = (page: Page, entryDependantId: string | null, currentId: string | null, extra: Partial<typeof base> = {}) =>
    resolvePoppedEntry({ ...base, needsDependant: pageNeedsDependant(page), ...extra, page, entryDependantId, currentId });

  it('re-borrows the dependant a page was opened for after Home restored another scope', () => {
    // Managing X → B's Phone & Pairing → Home (back to X) → back.
    expect(pop('pair-dependant-device', 'dep-b', 'dep-x')).toEqual({ show: 'page', borrow: 'dep-b' });
    expect(pop('settings', 'dep-b', 'dep-x')).toEqual({ show: 'page', borrow: 'dep-b' });
    expect(pop('pair-dependant-device', 'dep-b', null)).toEqual({ show: 'page', borrow: 'dep-b' });
  });

  it('goes home when the dependant the page was for no longer exists', () => {
    expect(pop('pair-dependant-device', 'dep-gone', null)).toEqual({ show: 'home' });
    expect(pop('settings', 'dep-gone', 'dep-x')).toEqual({ show: 'home' });
  });

  it('never shows a dependant-only page from an owner entry', () => {
    expect(pop('pair-dependant-device', null, 'dep-x')).toEqual({ show: 'home' });
    expect(pop('pair-dependant-device', null, null)).toEqual({ show: 'home' });
    expect(pop('activity', null, null)).toEqual({ show: 'home' });
  });

  it("shows a child install's own activity page (no dependant needed there)", () => {
    expect(pop('activity', null, null, { needsDependant: false })).toEqual({ show: 'page' });
  });

  it('shows an owner page under the owner scope again', () => {
    // Settings → Family → X's settings → back → back lands on the OWNER's settings.
    expect(pop('family-list', null, 'dep-x')).toEqual({ show: 'page', borrow: null });
    expect(pop('settings', null, 'dep-x')).toEqual({ show: 'page', borrow: null });
  });

  it('changes nothing when the entry was shown under the current scope', () => {
    expect(pop('settings', 'dep-x', 'dep-x')).toEqual({ show: 'page' });
    expect(pop('settings', null, null)).toEqual({ show: 'page' });
  });

  it('never re-scopes child mode: any other scope goes home', () => {
    expect(pop('settings', 'dep-x', 'dep-x', { locked: true })).toEqual({ show: 'page' });
    expect(pop('settings', 'dep-b', 'dep-x', { locked: true })).toEqual({ show: 'home' });
    expect(pop('family-list', null, 'dep-x', { locked: true })).toEqual({ show: 'home' });
  });

  it('home is always home', () => {
    expect(pop('home', 'dep-b', 'dep-x')).toEqual({ show: 'home' });
  });
});
