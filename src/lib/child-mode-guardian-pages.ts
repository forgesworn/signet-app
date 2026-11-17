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
];

/** `refuse`: show the refusal, no PIN. `hold`: child mode not yet known, show and ask nothing. */
export type ChildModePageDecision = 'allow' | 'hold' | 'refuse';

export function childModePageDecision(input: { page: Page; childMode: ChildModeState }): ChildModePageDecision {
  if (!CHILD_MODE_GUARDIAN_PAGES.includes(input.page)) return 'allow';
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
