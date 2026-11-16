import { describe, it, expect } from 'vitest';
import {
  dependantScopeReducer as reduce,
  INITIAL_DEPENDANT_SCOPE,
  type DependantScope,
  type DependantScopeAction,
} from './dependant-scope';

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

  it('forget drops a removed dependant from the scope and from the pending restore', () => {
    const viewing = run({ type: 'borrow', id: 'dep-a' }, { type: 'forget', id: 'dep-a' });
    expect(viewing).toEqual({ id: null, restore: { id: null } });

    const priorWasRemoved = run(
      { type: 'set', id: 'dep-a' },
      { type: 'borrow', id: 'dep-b' },
      { type: 'forget', id: 'dep-a' },
      { type: 'arrived-home' },
    );
    expect(priorWasRemoved).toEqual({ id: null, restore: null });

    const other = run(
      { type: 'set', id: 'dep-a' },
      { type: 'borrow', id: 'dep-b' },
      { type: 'forget', id: 'dep-b' },
      { type: 'arrived-home' },
    );
    expect(other).toEqual({ id: 'dep-a', restore: null });
  });

  it('returns the same state object when nothing changes, so React can bail out', () => {
    const s = run({ type: 'set', id: 'dep-a' });
    expect(reduce(s, { type: 'arrived-home' })).toBe(s);
    expect(reduce(s, { type: 'commit' })).toBe(s);
    expect(reduce(s, { type: 'set', id: 'dep-a' })).toBe(s);
    expect(reduce(s, { type: 'forget', id: 'dep-z' })).toBe(s);
  });
});
