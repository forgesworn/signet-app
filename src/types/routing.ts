import type { BotMetadata } from '../hooks/useBotInventory';
import type { SignetIdentity } from './identity';
import type { DependantIdentity } from './dependants';

export type Page = 'home' | 'contacts' | 'add' | 'contact-detail' | 'settings' | 'settings-security' | 'settings-profile' | 'settings-personas' | 'settings-advanced' | 'settings-developer' | 'settings-professional' | 'get-verified' | 'my-documents' | 'verify-someone' | 'shamir' | 'identity-bridge' | 'credential-detail' | 'approve-verification' | 'approve-connect' | 'approve-auth' | 'approve-add-dependant' | 'relay-auth-ack' | 'web-verify' | 'connections' | 'venue-entry' | 'photo-capture' | 'badge-embed' | 'vouch-someone' | 'add-dependant' | 'family-list' | 'transition-ceremony' | 'import-dependant' | 'roster' | 'pair-dependant-device' | 'pair-dependant-app' | 'paired-child-switcher' | 'paired-child-repair' | 'pro-onboarding' | 'pro-dashboard' | 'sub-role-pro-dashboard' | 'self-cert-issue' | 'pro-attest' | 'lead-add-staff' | 'lead-manage-delegates' | 'activity' | 'manage-carousel' | 'edit-public-profile' | 'activate-real-identity' | 'persona-advanced' | 'ken-add' | 'ken-detail' | 'approve-companion-grant' | 'contacts-grant-approve' | 'companion-apps' | 'migrate-heartwood' | 'family-contacts' | 'contact-new' | 'contact-invites' | 'bots' | 'child-contact-ask';

/**
 * Routing state for the per-slot Persona Advanced page (Phase 2 of the
 * persona-card-as-source-of-truth refactor). Threaded via
 * `pendingPersonaAdvancedTarget` in App.tsx and set when the carousel
 * `gear-fab` is tapped; consumed by the (Phase 2F) render branch.
 *
 * - `slotTarget`: which slot the page edits. Built-in tokens are
 *   `'natural-person' | 'persona' | 'professional-persona'`; for an
 *   extra persona this is the extra's 64-char hex pubkey (matches the
 *   `KeypairToken`-shaped string used elsewhere for slot identity).
 * - `depPubkey`: present iff the target slot lives under a dependant —
 *   carries the dep id so the page can resolve the correct record.
 */
export interface PersonaAdvancedRoute {
  slotTarget: 'natural-person' | 'persona' | 'professional-persona' | string;
  depPubkey?: string;
}

/**
 * Routing state for the real-identity activation page.
 *
 * `returnTo` is the page that sent the user here — a gated feature, or
 * `'approve-auth'` when a consumer's `accept=natural-person` hint found a
 * dormant slot (spec §6). Null means "there was no gate": return to the newly
 * activated real-identity card instead.
 */
export interface ActivateRealIdentityRoute {
  returnTo: Page | null;
}

/**
 * Who the `activate-real-identity` ceremony is acting for (spec §7.1, §7.6).
 * The dependant branch is guardian-device only — a paired-child install shows
 * copy, never this page.
 */
export type ActivationTarget =
  | { kind: 'owner' }
  | { kind: 'dependant'; depPubkey: string; dependantName: string };

/**
 * A row in the carousel's vertical ring.
 *
 * The natural-person row is the top of the ring — Contacts and Settings now
 * live in the persistent nav bar, not as carousel rows. Every variant carries
 * an identity (or dependant) payload bar the bottom `add` affordance.
 */
export type CarouselRow =
  | { type: 'natural-person'; identity: SignetIdentity }
  | { type: 'persona'; identity: SignetIdentity }
  | { type: 'bot'; bot: BotMetadata }
  | { type: 'extra-persona'; identity: SignetIdentity; personaIndex: number }
  | { type: 'dependant'; dependant: DependantIdentity }
  /**
   * A dependant's built-in `persona` keypair — the child-mode counterpart
   * to the guardian's `persona` row. The keypair is auto-derived when
   * the dependant is first added (alongside their NP). The full ApproveAuth
   * picker has always exposed this option; surfacing it as a carousel row
   * in child mode lines the camera-scan flow up with that picker so a
   * scan from this row signs as the dependant's persona, not as their NP.
   */
  | { type: 'dependant-persona'; dependant: DependantIdentity }
  /**
   * A dependant's extra persona — the child-mode counterpart to
   * `extra-persona`. Payload mirrors that variant but points at a
   * `DependantIdentity` since dependants have their own `extraPersonas[]`
   * derived under the dependant's path. Rendered in the child-mode ring
   * below the dependant row; not surfaced on the guardian surface.
   */
  | { type: 'dependant-extra-persona'; dependant: DependantIdentity; personaIndex: number }
  /**
   * Bottom-of-carousel entry point for adding a persona (both guardian + child
   * contexts) and a dependant (guardian only). Renders different buttons per
   * context — see AddCard.
   */
  | { type: 'add' };

/** Column indices in the carousel's horizontal ring */
export type CarouselColumn = 0 | 1 | 2 | 3 | 4;

/** Identity, QR, contacts, settings and camera form a horizontal loop. */
export const CAROUSEL_COLUMNS = ['card', 'qr', 'contacts', 'settings', 'camera'] as const;
export type CarouselColumnName = typeof CAROUSEL_COLUMNS[number];

