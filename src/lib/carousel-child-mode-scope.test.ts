import { describe, it, expect } from 'vitest';
import { childModeRowScope, isChildScopedRow, buildChildRows, buildRows, resolveActiveIdentity } from './carousel-utils';
import type { DependantIdentity, SignetIdentity, CarouselRow } from '../types';

const dep = (id: string): DependantIdentity => ({
  id, guardianPubkey: 'g', displayName: id, naturalPerson: { publicKey: `np-${id}`, privateKey: '', displayName: id },
  persona: { publicKey: `p-${id}`, privateKey: '', displayName: id },
  extraPersonas: [{ publicKey: `e-${id}`, privateKey: '', displayName: 'x', derivationName: 'persona-2' }],
  derivationPath: 'dependant-0', createdAt: 0, autonomyStage: 'full-control', primaryKeypair: 'natural-person',
} as unknown as DependantIdentity);
const guardian = {
  id: 'g', mnemonic: '', naturalPerson: { publicKey: 'np', privateKey: '', displayName: 'G' },
  persona: { publicKey: 'p', privateKey: '', displayName: 'P' }, primaryKeypair: 'persona', isChild: false, createdAt: 0, encrypted: true,
} as unknown as SignetIdentity;

describe('the child-mode row predicate', () => {
  const childRows = buildChildRows(dep('kid'));
  it('every row of the child ring that carries an identity is the child\'s, persona rows included', () => {
    const types = childRows.map(r => r.type);
    expect(types).toEqual(expect.arrayContaining(['dependant-persona', 'dependant-extra-persona']));
    for (const r of childRows.filter(r => r.type !== 'add')) {
      expect(isChildScopedRow(r), r.type).toBe(true);
      expect(childModeRowScope(r, true, 'kid'), r.type).toBe('child');
    }
  });

  it('persona rows are the child\'s although resolved.isDependant is false for them', () => {
    const persona = childRows.find(r => r.type === 'dependant-persona')!;
    expect(resolveActiveIdentity(persona).isDependant).toBe(false);
    expect(childModeRowScope(persona, true, 'kid')).toBe('child');
  });

  it('a sibling\'s row, or a guardian row, is foreign while child mode is on', () => {
    const sibling = buildChildRows(dep('sib'))[0];
    expect(childModeRowScope(sibling, true, 'kid')).toBe('foreign');
    for (const r of buildRows(guardian, [dep('sib')])) {
      if (r.type === 'add') continue;
      expect(childModeRowScope(r, true, 'kid'), r.type).toBe('foreign');
    }
  });

  it('with no resolved child id nothing is the child\'s', () => {
    expect(childModeRowScope(childRows[0], true, null)).toBe('foreign');
  });

  it('outside child mode the rows are not classified', () => {
    expect(childModeRowScope(childRows[0], false, 'kid')).toBe('off');
    expect(childModeRowScope(buildRows(guardian, [])[0], false, null)).toBe('off');
  });

  it('the add card is neither the child\'s nor foreign', () => {
    expect(childModeRowScope({ type: 'add' } as CarouselRow, true, 'kid')).toBe('add');
  });
});
