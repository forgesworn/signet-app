/**
 * Child mode is a page ALLOWLIST: a guardian hands their unlocked phone to a
 * dependant, and the owner rule is that child mode never acts as the guardian.
 * A page is open to the child only if `CHILD_MODE_PAGE_RULES` says so; every
 * other page shows the refusal, with no PIN. The table is typed exhaustively
 * over `Page`, so a new page fails to compile until someone classifies it.
 * (Before 2026-11-18 this was a denylist of guardian pages, and four review
 * rounds each found another page that was missing from it.)
 *
 * The rules:
 * - `live-and-saved`: the child's own screens, also when the phone is locked or
 *   cold-started with the session only on disk (a sign-in arriving then).
 * - `live-only`: the child's screens that need the child's scope loaded, so
 *   only while the carousel is in child mode. In saved state they are refused:
 *   there the scope is the guardian's (Settings would be the guardian's menu).
 * - `refuse`: everything else, including pages that look harmless but act with
 *   the guardian's keys, mnemonic, signer or operator key, or sign as the
 *   child with no PIN (`venue-entry`, `vouch-someone`, `photo-capture`).
 *
 * The decision is pure. `unknown` (the saved session is still being read)
 * lets home render and holds the rest blank, never treated as off.
 */
import type { Page } from '../types';
import type { ChildModeState } from './child-mode-sign-in';
import { sanitizeDisplayName } from './text-sanitize';

export type ChildModePageRule = 'live-and-saved' | 'live-only' | 'refuse';

export const CHILD_MODE_PAGE_RULES = {
  home: 'live-and-saved',
  'approve-auth': 'live-and-saved',
  'approve-connect': 'live-and-saved',
  'relay-auth-ack': 'live-and-saved',

  settings: 'live-only',
  'web-verify': 'live-only',
  contacts: 'live-only',
  'contact-detail': 'live-only',
  'contact-new': 'live-only',
  'contact-invites': 'live-only',
  'contact-handshake': 'live-only',
  'ken-add': 'live-only',

  add: 'refuse',
  'settings-security': 'refuse',
  'settings-signing': 'refuse',
  'settings-profile': 'refuse',
  'settings-personas': 'refuse',
  'settings-advanced': 'refuse',
  'settings-developer': 'refuse',
  'settings-professional': 'refuse',
  'get-verified': 'refuse',
  'my-documents': 'refuse',
  'verify-someone': 'refuse',
  shamir: 'refuse',
  'identity-bridge': 'refuse',
  'credential-detail': 'refuse',
  'approve-verification': 'refuse',
  'approve-add-dependant': 'refuse',
  'approve-app-permission': 'refuse',
  connections: 'refuse',
  'venue-entry': 'refuse',
  'photo-capture': 'refuse',
  'badge-embed': 'refuse',
  'vouch-someone': 'refuse',
  'add-dependant': 'refuse',
  'family-list': 'refuse',
  'transition-ceremony': 'refuse',
  'import-dependant': 'refuse',
  roster: 'refuse',
  'pair-dependant-device': 'refuse',
  'pair-dependant-app': 'refuse',
  'paired-child-switcher': 'refuse',
  'paired-child-repair': 'refuse',
  'pro-onboarding': 'refuse',
  'pro-dashboard': 'refuse',
  'sub-role-pro-dashboard': 'refuse',
  'self-cert-issue': 'refuse',
  'pro-attest': 'refuse',
  'lead-add-staff': 'refuse',
  'lead-manage-delegates': 'refuse',
  activity: 'refuse',
  'manage-carousel': 'refuse',
  'edit-public-profile': 'refuse',
  'activate-real-identity': 'refuse',
  'persona-advanced': 'refuse',
  'ken-detail': 'refuse',
  'approve-companion-grant': 'refuse',
  'contacts-grant-approve': 'refuse',
  'contacts-grant-code': 'refuse',
  'companion-apps': 'refuse',
  'my-keep': 'refuse',
  'migrate-heartwood': 'refuse',
  'family-contacts': 'refuse',
  'contact-invite-send': 'refuse',
  bots: 'refuse',
  'child-contact-ask': 'refuse',
  'child-permissions': 'refuse',
} as const satisfies Record<Page, ChildModePageRule>;

/** `refuse`: show the refusal, no PIN. `hold`: child mode not yet known, show and ask nothing. */
export type ChildModePageDecision = 'allow' | 'hold' | 'refuse';

export interface ChildModePageDecisionInput {
  page: Page;
  childMode: ChildModeState;
  /** The carousel is in child mode (not just a session on disk). */
  live: boolean;
  /** The lock-proof child id (`signInChildDependant`), or null when none is resolved. */
  stableChildId: string | null;
  /** Whose scope the page would open in. */
  activeDependantId: string | null;
}

export function childModePageDecision(input: ChildModePageDecisionInput): ChildModePageDecision {
  const { page } = input;
  if (input.childMode === 'off') return 'allow';
  if (input.childMode === 'unknown') return page === 'home' ? 'allow' : 'hold';
  const rule: ChildModePageRule = CHILD_MODE_PAGE_RULES[page];
  if (rule === 'refuse') return 'refuse';
  if (rule === 'live-only' && !input.live) return 'refuse';
  if (page === 'home') return 'allow';
  // Every allowed page but home belongs to the child: a scope that is the
  // guardian's or a sibling's (however it got there) is refused, and with no
  // resolved child there is nothing to match. Saved state has no scope yet
  // (the restore waits for the key), so it only has to not be someone else's.
  if (input.stableChildId === null) return 'refuse';
  if (input.live) return input.activeDependantId === input.stableChildId ? 'allow' : 'refuse';
  return input.activeDependantId === null || input.activeDependantId === input.stableChildId ? 'allow' : 'refuse';
}

const NAME_MAX = 64;

export function childModeGuardianRefusalCopy(displayName: string): { title: string; body: string } {
  const name = sanitizeDisplayName(typeof displayName === 'string' ? displayName : '', NAME_MAX) || 'your child';
  return {
    title: 'Child mode is on',
    body: `This needs the guardian, not ${name}. Exit child mode with the guardian's PIN, then try again.`,
  };
}

/** A contact invite scanned in child mode: refused on the camera card, nothing parked for the guardian. */
export const CHILD_MODE_SCAN_INVITE_COPY = "This needs the guardian. Exit child mode with the guardian's PIN, then scan it again.";
