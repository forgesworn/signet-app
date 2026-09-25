import { describe, it, expect } from 'vitest';
import { cellActions, cellActionLabel, cellSummary } from './contacts-v2-cell-actions';
import type { ManagerCell } from './contacts-v2-manager-rows';

function cell(over: Partial<ManagerCell> = {}): ManagerCell {
  return {
    directoryId: 'dependant:0', present: true, contactId: 'c1', localName: 'Dave',
    effectiveTier: 'ken', tierSource: 'direct', blocked: false,
    blockedByActor: false, ceilingMaxTier: null, actorCeilingMaxTier: null, ...over,
  };
}

describe('cellActions', () => {
  it('offers Add here for an absent cell when the row has keys', () => {
    expect(cellActions(cell({ present: false, contactId: null }), { isOwnerDirectory: false, rowHasIdentities: true }))
      .toEqual(['add-here']);
  });

  it('offers nothing for an absent cell on a keyless row', () => {
    expect(cellActions(cell({ present: false, contactId: null }), { isOwnerDirectory: false, rowHasIdentities: false }))
      .toEqual([]);
  });

  it('offers remove, block and ceiling on a present dependant cell', () => {
    expect(cellActions(cell(), { isOwnerDirectory: false, rowHasIdentities: true }))
      .toEqual(['remove-here', 'block-here', 'set-ceiling']);
  });

  it('never offers a ceiling in the owner directory', () => {
    expect(cellActions(cell({ directoryId: 'owner' }), { isOwnerDirectory: true, rowHasIdentities: true }))
      .toEqual(['remove-here', 'block-here']);
  });

  it('swaps Block for Unblock only when the actor applied the block', () => {
    expect(cellActions(cell({ blocked: true, blockedByActor: true }), { isOwnerDirectory: false, rowHasIdentities: true }))
      .toEqual(['remove-here', 'unblock-here', 'set-ceiling']);
    expect(cellActions(cell({ blocked: true, blockedByActor: false }), { isOwnerDirectory: false, rowHasIdentities: true }))
      .toEqual(['remove-here', 'set-ceiling']);
  });
});

describe('labels and summaries', () => {
  it('labels every action', () => {
    expect(cellActionLabel('add-here')).toBe('Add here');
    expect(cellActionLabel('remove-here')).toBe('Remove here');
    expect(cellActionLabel('block-here')).toBe('Block here');
    expect(cellActionLabel('unblock-here')).toBe('Unblock here');
    expect(cellActionLabel('set-ceiling')).toBe('Set ceiling');
  });

  it('summarises an absent, plain, vouched, capped and blocked cell', () => {
    expect(cellSummary(cell({ present: false, contactId: null, effectiveTier: null, tierSource: null }))).toBe('Not here');
    expect(cellSummary(cell())).toBe('Ken');
    expect(cellSummary(cell({ effectiveTier: 'kin', tierSource: 'guardian-vouched' }))).toBe('Kin via guardian');
    expect(cellSummary(cell({ effectiveTier: 'ken', tierSource: 'guardian-limited', ceilingMaxTier: 'ken' })))
      .toBe('Ken guardian-limited');
    expect(cellSummary(cell({ blocked: true }))).toBe('Blocked');
  });
});
