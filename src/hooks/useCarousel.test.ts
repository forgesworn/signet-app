// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { SignetIdentity } from '../types';
import { useCarousel } from './useCarousel';

const P = 'a1'.repeat(32), E1 = 'b2'.repeat(32), E2 = 'c3'.repeat(32);
const identity = {
  id: 'd4'.repeat(32), mnemonic: '',
  naturalPerson: { publicKey: '', privateKey: '', displayName: '' },
  persona: { publicKey: P, privateKey: '', displayName: 'Ally' },
  extraPersonas: [{ publicKey: E1, privateKey: '', displayName: 'Gamer' }, { publicKey: E2, privateKey: '', displayName: 'Artist' }],
  primaryKeypair: 'persona', naturalPersonActive: false, isChild: true, createdAt: 1, encrypted: true, backedUp: true,
} as unknown as SignetIdentity;

function mount(allowed: string[], bound: string | null = P) {
  return renderHook(({ allow, b }) => useCarousel(identity, [], [], new Set(allow), b), { initialProps: { allow: allowed, b: bound } });
}

describe('useCarousel — a direct child\'s allow-list changing under the card on screen', () => {
  it('a shrinking list keeps the same card, not the same row number', async () => {
    const h = mount([P, E1, E2]);
    await act(async () => { h.result.current.commitPosition(2, 0); });
    expect(h.result.current.activeIdentity.publicKey).toBe(E2);
    h.rerender({ allow: [P, E2], b: P });
    expect(h.result.current.activeIdentity.publicKey).toBe(E2);
    expect(h.result.current.row).toBe(1);
  });

  it('a card no longer allowed gives way to the bound persona\'s card', async () => {
    const h = mount([P, E1, E2], E1);
    await act(async () => { h.result.current.commitPosition(2, 0); });
    h.rerender({ allow: [P, E1], b: E1 });
    expect(h.result.current.activeIdentity.publicKey).toBe(E1);
  });

  it('without a bound persona, a removed card falls back to the landing card', async () => {
    const h = mount([P, E1, E2], null);
    await act(async () => { h.result.current.commitPosition(1, 0); });
    h.rerender({ allow: [P, E2], b: null });
    expect(h.result.current.activeIdentity.publicKey).toBe(P);
  });

  it('a list that arrives (bound persona only, then the rest) leaves the card on screen alone', async () => {
    const h = mount([P]);
    expect(h.result.current.rows.map(r => r.type)).toEqual(['persona', 'add']);
    h.rerender({ allow: [E1, P, E2], b: P });
    expect(h.result.current.activeIdentity.publicKey).toBe(P);
  });

  it('a list that GAINS a card before the one on screen still keeps it', async () => {
    const h = mount([P, E2]);
    await act(async () => { h.result.current.commitPosition(1, 0); });
    expect(h.result.current.activeIdentity.publicKey).toBe(E2);
    h.rerender({ allow: [E1, P, E2], b: P });
    expect(h.result.current.activeIdentity.publicKey).toBe(E2);
    expect(h.result.current.row).toBe(2);
  });

  // App: `null` = no filter / not decided yet (the record still loading).
  function mountNullable(allowed: string[] | null, bound: string | null = null, id: SignetIdentity | null = identity) {
    return renderHook(({ allow, b, ident }) => useCarousel(ident, [], [], allow ? new Set(allow) : null, b), {
      initialProps: { allow: allowed, b: bound, ident: id },
    });
  }

  it('an empty list then the bound persona: the bound persona\'s card, never the add card', () => {
    const h = mountNullable([], null);
    expect(h.result.current.rows.map(r => r.type)).toEqual(['add']);
    h.rerender({ allow: [P], b: P, ident: identity });
    expect(h.result.current.activeIdentity.publicKey).toBe(P);
    h.rerender({ allow: [P, E1, E2], b: P, ident: identity });
    expect(h.result.current.activeIdentity.publicKey).toBe(P);
  });

  it('unlocking while the record loads (null), then the bound persona, then the full list: P\'s card, even if the add card was on screen before the lock', async () => {
    const h = mountNullable(null, null);
    // On the add card (the last row) when the phone locked: the next unlock lands on the bound persona.
    await act(async () => { h.result.current.navigateToCell(3, 0); });
    h.rerender({ allow: null, b: null, ident: null });
    h.rerender({ allow: null, b: null, ident: identity });
    h.rerender({ allow: [P], b: P, ident: identity });
    expect(h.result.current.activeIdentity.publicKey).toBe(P);
    h.rerender({ allow: [P, E1, E2], b: P, ident: identity });
    expect(h.result.current.activeIdentity.publicKey).toBe(P);
    expect(h.result.current.rows[h.result.current.row].type).toBe('persona');
  });

  it('the card on screen before the list is decided is kept when the list has it', async () => {
    const h = mountNullable(null, null);
    await act(async () => { h.result.current.commitPosition(1, 0); });
    expect(h.result.current.activeIdentity.publicKey).toBe(E1);
    h.rerender({ allow: [P, E1, E2], b: P, ident: identity });
    expect(h.result.current.activeIdentity.publicKey).toBe(E1);
  });

  it('the add card stays on screen only when the user went there', async () => {
    const h = mount([P, E2]);
    await act(async () => { h.result.current.commitPosition(2, 0); });
    expect(h.result.current.rows[h.result.current.row].type).toBe('add');
    h.rerender({ allow: [E1, P, E2], b: P });
    expect(h.result.current.rows[h.result.current.row].type).toBe('add');
    h.rerender({ allow: [P], b: P });
    expect(h.result.current.rows[h.result.current.row].type).toBe('add');
  });
});
