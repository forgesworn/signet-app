/**
 * Pages that act as the guardian, refused while the phone is in child mode.
 *
 * A guardian hands their unlocked phone to a dependant, and the phone must
 * never act with the guardian's identities then. Sign-in, connect and phone
 * apps already follow that rule. These pages did not, and in live child mode
 * they opened with no PIN at all. The companion-app grant offers the
 * guardian's personas and derives its rail key from the guardian's mnemonic.
 * The contacts grant offers the owner directory and every sibling's. Adding a
 * dependant mints under the guardian, and in local mode signs with the child's
 * key labelled as the guardian. A Heartwood operator-import QR opens the
 * guardian's Advanced settings, with the signer, relays and operator key.
 *
 * Age verification is listed too: stored credentials carry no owner
 * (`StoredCredential`), so `pickCredential` can pick the guardian's 18+
 * credential and the response then names the guardian's pubkey. There is no way
 * to offer only the child's own.
 *
 * App permission is listed so it asks for no PIN: on the guardian's phone every
 * request is refused in child mode anyway (`routeAppPermission`), and its own
 * unlock prompt was the guardian's PIN.
 *
 * `persona-advanced` holds the guardian's controls for a dependant: autonomy,
 * rules, unpair and remove. Removing the dependant there dropped the phone out
 * of child mode with no PIN.
 *
 * `settings-security` and `shamir` show or split the guardian's recovery words:
 * the Shamir split shows all three shares with no PIN.
 *
 * `settings-personas` leaves child mode with no PIN.
 *
 * The dependant management pages (`pair-dependant-device` is Phone & Pairing,
 * `child-permissions`, `family-list`, `add-dependant`, ...) are listed because
 * the scope backstop below passes them whenever they were opened for the child
 * itself, and in-app back can land on one after child mode starts. `activity`
 * here is the guardian's audit view (`guardianAuditBackend`); the paired
 * child's own activity page runs on a paired-child install, never child mode.
 *
 * `contacts-grant-code` is deliberately not listed: leaving that page strands a
 * live grant unchecked, and it is only reachable after an approve, which is now
 * refused.
 */
import type { Page } from '../types';
import type { ChildModeState } from './child-mode-sign-in';
import { sanitizeDisplayName } from './text-sanitize';

export const CHILD_MODE_GUARDIAN_PAGES: readonly Page[] = [
  'approve-companion-grant',
  'contacts-grant-approve',
  'approve-add-dependant',
  'settings-advanced',
  'approve-verification',
  'approve-app-permission',
  'persona-advanced',
  'settings-security',
  'shamir',
  'settings-personas',
  // The guardian's management pages for a dependant. The live-child backstop
  // lets these through when they were opened for the child itself, so in-app
  // back could reach them: pairing and permissions, the family and independence.
  'pair-dependant-device',
  'pair-dependant-app',
  'child-permissions',
  'family-list',
  'family-contacts',
  'add-dependant',
  'import-dependant',
  'transition-ceremony',
  'activity',
];

/** `refuse`: show the refusal, no PIN. `hold`: child mode not yet known, show and ask nothing. */
export type ChildModePageDecision = 'allow' | 'hold' | 'refuse';

/**
 * Set only while child mode is live (not saved or locked, which have no active
 * dependant): who the child is, and whose scope the page is in.
 */
export interface LiveChildScope { childDependantId: string | null; activeDependantId: string | null }

export function childModePageDecision(
  input: { page: Page; childMode: ChildModeState; liveChild?: LiveChildScope | null },
): ChildModePageDecision {
  if (!CHILD_MODE_GUARDIAN_PAGES.includes(input.page)) {
    // Backstop: whatever moved the scope, a page outside home that is not the
    // child's own never shows in live child mode.
    // With no child id (their record left `dependants`) there is no scope to match, so only home is safe.
    const live = input.liveChild;
    if (input.childMode === 'on' && live && input.page !== 'home'
      && (live.childDependantId === null || live.activeDependantId !== live.childDependantId)) return 'refuse';
    return 'allow';
  }
  if (input.childMode === 'on') return 'refuse';
  return input.childMode === 'unknown' ? 'hold' : 'allow';
}

const NAME_MAX = 64;

export function childModeGuardianRefusalCopy(displayName: string): { title: string; body: string } {
  const name = sanitizeDisplayName(typeof displayName === 'string' ? displayName : '', NAME_MAX) || 'your child';
  return {
    title: 'Child mode is on',
    body: `This needs the guardian, not ${name}. Exit child mode with the guardian's PIN, then try again.`,
  };
}
