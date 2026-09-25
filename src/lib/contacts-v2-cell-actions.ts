/**
 * What the family manager may offer in one cell.
 *
 * Kept separate from the row model so the table's affordances are a policy
 * with a test, not an accident of JSX: a guardian cannot cap their own
 * directory, cannot clear another guardian's block (spec section 7.10), and
 * cannot copy a keyless contact into another directory — there is no public
 * identity to copy, and a name match is never merge evidence.
 */
import { tierChipLabel, tierProvenanceSuffix } from './contacts-v2-copy';
import type { ManagerCell } from './contacts-v2-manager-rows';

export type CellAction = 'add-here' | 'remove-here' | 'block-here' | 'unblock-here' | 'set-ceiling';

export interface CellActionContext {
  isOwnerDirectory: boolean;
  rowHasIdentities: boolean;
}

export function cellActions(cell: ManagerCell, ctx: CellActionContext): CellAction[] {
  if (!cell.present) return ctx.rowHasIdentities ? ['add-here'] : [];
  const out: CellAction[] = ['remove-here'];
  if (cell.blocked) {
    if (cell.blockedByActor) out.push('unblock-here');
  } else {
    out.push('block-here');
  }
  if (!ctx.isOwnerDirectory) out.push('set-ceiling');
  return out;
}

const ACTION_LABELS: Record<CellAction, string> = {
  'add-here': 'Add here',
  'remove-here': 'Remove here',
  'block-here': 'Block here',
  'unblock-here': 'Unblock here',
  'set-ceiling': 'Set ceiling',
};

export function cellActionLabel(action: CellAction): string {
  return ACTION_LABELS[action];
}

export function cellSummary(cell: ManagerCell): string {
  if (!cell.present) return 'Not here';
  if (cell.blocked) return 'Blocked';
  const tier = cell.effectiveTier ? tierChipLabel(cell.effectiveTier) : 'No tier';
  const suffix = cell.tierSource ? tierProvenanceSuffix(cell.tierSource, null) : null;
  return suffix ? `${tier} ${suffix}` : tier;
}
