/**
 * Entry points that bypass the page decision (child-mode allowlist design, B3).
 *
 * A guardian's unlocked phone in a dependant's hands never acts as the
 * guardian, and never shows the guardian's family to the child. Both read the
 * three-state signal (`unknown` counts as child mode, D4).
 */
import type { ChildModeState } from './child-mode-sign-in';

/** What a native notification says while the phone may be in a child's hands: no names, apps or family details. */
export const CHILD_MODE_GENERIC_NOTIFICATION: { title: string; body: string } = {
  title: 'A request is waiting',
  body: 'Open Signet to review it.',
};

/** The notification to raise: the named one outside child mode, the generic line otherwise. */
export function notificationForChildMode(
  childMode: ChildModeState,
  named: { title: string; body: string },
): { title: string; body: string } {
  return childMode === 'off' ? named : CHILD_MODE_GENERIC_NOTIFICATION;
}

/**
 * Whether a request on the guardian's OWN persona route may be served.
 * Dependant routes and a child's own routes are not the guardian acting and
 * are never held back by child mode.
 */
export function childModeHoldsRoute(route: { dependantId?: string; childGate?: unknown }, childMode: ChildModeState): boolean {
  return !route.dependantId && !route.childGate && childMode !== 'off';
}

/**
 * The ids of request notifications already delivered (phone-served approvals and a
 * child's asks), emptied from their trackers. Entering child mode cancels them: they
 * were posted with names and app text, and would stay in the shade.
 */
export function takeDeliveredRequestNotificationIds(approvalHandles: Set<number>, childAskIds: Map<string, number>): number[] {
  const ids = [...approvalHandles, ...childAskIds.values()];
  approvalHandles.clear();
  childAskIds.clear();
  return ids;
}
