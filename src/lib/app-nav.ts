import type { Page } from '../types';
import type { IconName } from '../components/Icon';

export type TabId = 'home' | 'contacts' | 'bunker' | 'settings';

export interface TabDef {
  id: TabId;
  label: string;
  icon: IconName;
  page?: Page;    // navigation target; `bunker` is an action with no page
}

// Bunker uses the `key` glyph, not a padlock — it's the signing service
// (control/ownership of your keys), and the brand guide's iconography
// section (§7) asks security to read as control/keys/provenance, not fear.
const HOME: TabDef = { id: 'home', label: 'Home', icon: 'home', page: 'home' };
const CONTACTS: TabDef = { id: 'contacts', label: 'Contacts', icon: 'users', page: 'contacts' };
const BUNKER: TabDef = { id: 'bunker', label: 'Bunker', icon: 'key' };
const SETTINGS: TabDef = { id: 'settings', label: 'Settings', icon: 'settings', page: 'settings' };

/** Owner gets the Bunker tab; a dependant context (acting-as or paired-child) does not. */
export function barTabsFor(opts: { isDependantContext: boolean }): TabDef[] {
  return opts.isDependantContext ? [HOME, CONTACTS, SETTINGS] : [HOME, CONTACTS, BUNKER, SETTINGS];
}

/** Height of the mobile bottom bar in px (excludes safe-area-inset-bottom). Shared by TabBar (its own height) and AppShell (content paddingBottom) so they can't drift. */
export const BAR_HEIGHT = 64;

/** Full-screen focus surfaces where the bar must not appear. */
export const BAR_HIDDEN_PAGES: ReadonlySet<Page> = new Set<Page>([
  'approve-verification', 'approve-connect', 'approve-auth', 'approve-add-dependant',
  'relay-auth-ack', 'web-verify', 'venue-entry', 'photo-capture',
  // Ceremony / pairing / import focus surfaces — a persistent nav bar is wrong
  // here (camera/QR or multi-step flows; a stray tab tap could orphan state).
  'transition-ceremony', 'pair-dependant-device', 'pair-dependant-app',
  'paired-child-repair', 'import-dependant', 'migrate-heartwood',
]);

export function isBarHiddenPage(page: Page): boolean {
  return BAR_HIDDEN_PAGES.has(page);
}

export function activeTabForPage(page: Page): TabId | null {
  if (page === 'home') return 'home';
  if (page === 'contacts' || page === 'contact-detail' || page === 'ken-add' || page === 'ken-detail') return 'contacts';
  if (
    page === 'settings' || page.startsWith('settings-') ||
    // Settings sub-pages and pages reached from within them
    page === 'connections' || page === 'badge-embed' || page === 'shamir' ||
    page === 'identity-bridge' || page === 'roster' || page === 'persona-advanced' ||
    page === 'edit-public-profile' || page === 'activate-real-identity' || page === 'manage-carousel' ||
    // Pro surface — entered from settings-professional
    page === 'pro-onboarding' || page === 'pro-dashboard' || page === 'sub-role-pro-dashboard' ||
    page === 'self-cert-issue' || page === 'pro-attest' || page === 'lead-add-staff' ||
    page === 'lead-manage-delegates' ||
    // Guardian/paired-child dep activity — reached from per-dep Settings
    page === 'activity'
  ) return 'settings';
  return null;
}

/**
 * A bar-hidden approval page whose request state is gone. Its render branch
 * no longer matches, so the app falls through to the home carousel — but
 * AppShell still hides the nav for the page, leaving a screen with no nav and
 * no controls. Whenever this is true the caller must leave for home.
 */
export function isOrphanedApprovalPage(
  page: Page,
  state: { hasAuthRequest: boolean; hasRelayAuthAck: boolean },
): boolean {
  if (page === 'approve-auth') return !state.hasAuthRequest;
  if (page === 'relay-auth-ack') return !state.hasRelayAuthAck;
  return false;
}
