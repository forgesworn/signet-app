import type { BotMetadata } from '../hooks/useBotInventory';
import type { SignetIdentity, DependantIdentity, CarouselRow } from '../types';
import { isNaturalPersonActive, isDependantNaturalPersonActive } from './identity-display';

/**
 * Should the real-name (Natural Person) card appear in the ring?
 *
 * Normally: only when the slot has been activated (spec §5). The one exception
 * is an identity whose ONLY keypair is the NP slot — with no persona to stand
 * in for it, hiding the NP would leave a ring with no identity card at all, so
 * it is shown regardless. Reachable in principle for an nsec imported into the
 * NP slot; the app's own nsec door always imports into the persona slot, where
 * `naturalPerson.publicKey` is empty and the first check already returns false.
 */
export function showNaturalPersonRow(identity: SignetIdentity): boolean {
  if (!identity.naturalPerson.publicKey) return false;
  if (isNaturalPersonActive(identity)) return true;
  return !identity.persona.publicKey;
}

/**
 * Which keypair slot does the inline "add your name" editor on THIS row write?
 *
 * `null` means the row must not be renamed through the owner-identity handler —
 * every dependant row (those belong to a dependant record, reached through the
 * dependant hooks, not `updateDisplayName`) and the `add` row. Returning the
 * ROW's slot rather than `identity.primaryKeypair` is the point: on a
 * persona-primary install the real-identity row would otherwise rename the
 * persona, which is exactly how a cross-device activation ends up with a
 * nameless real identity AND a renamed persona.
 *
 * Token shape matches `updateDisplayName` / `setPersonaAvatar`:
 * 'natural-person' | 'persona' | <extra's hex pubkey>.
 */
export function resolveRenameTarget(row: CarouselRow): string | null {
  switch (row.type) {
    case 'natural-person':
      return 'natural-person';
    case 'persona':
      return 'persona';
    case 'extra-persona':
      return row.identity.extraPersonas?.[row.personaIndex]?.publicKey ?? null;
    default:
      return null;
  }
}

/**
 * Build the vertical ring.
 *
 * Order (spec §5): persona → visible extra personas → natural-person (only when
 * `showNaturalPersonRow`) → dependants → add. The persona is the top of the ring
 * and the landing row; the real identity sits AFTER the personas so it can never
 * be used by accident. The carousel is linear (hard stop at both ends).
 */
export function buildRows(
  identity: SignetIdentity,
  dependants: DependantIdentity[],
  bots: readonly BotMetadata[] = [],
): CarouselRow[] {
  const rows: CarouselRow[] = [];

  if (identity.persona.publicKey) {
    rows.push({ type: 'persona', identity });
  }

  if (identity.extraPersonas) {
    for (let i = 0; i < identity.extraPersonas.length; i++) {
      // Hidden extras keep their slot in the array (so derivation names can't
      // be reused) but are excluded from the carousel surface. `personaIndex`
      // still indexes into the canonical array.
      if (identity.extraPersonas[i].hidden) continue;
      rows.push({ type: 'extra-persona', identity, personaIndex: i });
    }
  }

  for (const bot of bots) if (!bot.hidden && bot.removedAt === undefined) rows.push({ type: 'bot', bot });

  if (showNaturalPersonRow(identity)) {
    rows.push({ type: 'natural-person', identity });
  }

  for (const dep of dependants) {
    rows.push({ type: 'dependant', dependant: dep });
  }

  // Discoverability affordance: persistent "Add…" row at the bottom of the
  // ring. On the guardian surface it pitches both "Add persona" and "Add
  // dependant"; on a dependant's child-mode ring (see buildChildRows) it's
  // persona-only. See dependant-account-ux-spec §1.
  rows.push({ type: 'add' });

  return rows;
}

/**
 * Build child-mode rows — the dependant, followed by any extra personas
 * attached to the dependant (derived under the dependant's derivation path
 * — see `useDependants.addDependantPersona`), then the persona-only Add
 * card. No "Add dependant" button here — a dependant has no dependants of
 * their own. The extras row was missing in the initial ship;
 * without it a freshly-added child persona was written to IDB correctly
 * but never rendered — fixed as a follow-up.
 */
export function buildChildRows(dependant: DependantIdentity): CarouselRow[] {
  const rows: CarouselRow[] = [];
  // The `dependant` row IS the real-name card. Omit it while the real identity
  // is dormant (spec §5, §7.6) — unless there is no persona key to stand in for
  // it, in which case omitting it would leave a ring with no identity at all.
  if (isDependantNaturalPersonActive(dependant) || !dependant.persona.publicKey) {
    rows.push({ type: 'dependant', dependant });
  }
  // Built-in persona keypair (auto-derived in addDependant). Skipped only
  // for view-only imported dependants which don't have one.
  if (dependant.persona.publicKey) {
    rows.push({ type: 'dependant-persona', dependant });
  }
  if (dependant.extraPersonas) {
    for (let i = 0; i < dependant.extraPersonas.length; i++) {
      // Same hide semantics as the guardian ring (defensive — no UI yet
      // for hiding a dep's extras, but the flag is honoured if set).
      if (dependant.extraPersonas[i].hidden) continue;
      rows.push({ type: 'dependant-extra-persona', dependant, personaIndex: i });
    }
  }
  rows.push({ type: 'add' });
  return rows;
}

/** Circular index wrapping: wrapIndex(-1, 4) → 3, wrapIndex(4, 4) → 0 */
export function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

/** Linear clamp — used for vertical navigation (hard stop at both ends). */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

/** Resolved identity info for display and signing context */
export interface ResolvedIdentity {
  displayName: string;
  /** True when the underlying slot has an explicit non-empty displayName set.
   *  False when the `displayName` field above is a fallback ('Persona' /
   *  'Natural Person') because the raw slot value was empty. Consumers use
   *  this to show a placeholder prompt ("Add a name") rather than treating
   *  the fallback as a real identity name. */
  displayNameIsSet: boolean;
  publicKey: string;
  type: string;
  isDependant: boolean;
  dependantId?: string;
  /** Date of birth (dependants only, for age display) */
  dateOfBirth?: string;
  /** Photo hash for Blossom display — venue-entry photo, NP only. */
  photoHash?: string;
  blossomUrl?: string;
  photoKey?: string;
  /** Per-persona profile picture metadata. Distinct from the venue-entry
   *  photo above — populated for every persona type that supports avatars
   *  (NP, persona, extra-persona). The hook `useResolvedAvatar` consumes
   *  these to fetch + decrypt the blob into an object URL. */
  avatarHash?: string;
  avatarBlossomUrl?: string;
  avatarKey?: string;
  /** Slot target for per-persona mutations (matches the setter union):
   *  'natural-person' | 'persona' | <extra pubkey hex>. '' for non-persona rows. */
  slotTarget?: string;
  /** Contact-share avatar state (see SlotAvatarFields). */
  contactAvatarKey?: string;
  /** True when the always-current contact-avatar re-publish last FAILED —
   *  contacts may be seeing an out-of-date picture. See SlotAvatarFields. */
  contactAvatarStale?: boolean;
  /** Public Nostr profile (kind-0) state for the resolved slot. Used by the
   *  §6.8 sign-in correlation hint in ApprovalOverlay / ApproveAuth — only
   *  shown when `publicProfile.enabled === true`. Carried verbatim from the
   *  underlying slot; this is STATE-ONLY (enabled + lastEventId/At/Relay).
   *  Consumers that need the display label should read `displayName` from
   *  the slot above (or `activeIdentity.displayName`) rather than expecting
   *  `.name` here — that field used to live on PersonaPublicProfile but was
   *  moved onto the slot itself in the persona-card-source-of-truth refactor. */
  publicProfile?: import('../types').PersonaPublicProfile;
}

/** Every field the acting-slot resolver needs. A `Pick` rather than the whole
 *  record so the approval screens, whose `dependants` prop is already a
 *  projection, can call it without a cast. */
export type DependantCardSlotInput = Pick<
  DependantIdentity,
  'naturalPerson' | 'persona' | 'extraPersonas' | 'primaryKeypair' | 'naturalPersonActive'
>;

/** One of a dependant's keypair slots, in the shape every card/route consumer reads. */
export type DependantSlot =
  | DependantIdentity['naturalPerson']
  | DependantIdentity['persona']
  | NonNullable<DependantIdentity['extraPersonas']>[number];

/** The slot a dependant's single carousel card represents. */
export interface DependantCardSlot {
  /** Matches the per-slot setter union: 'natural-person' | 'persona' | <extra pubkey hex>. */
  slotTarget: 'natural-person' | 'persona' | string;
  slot: DependantSlot;
}

/**
 * Which of a dependant's slots is the ACTING slot? (spec §7.6, §8.)
 *
 * This is the single resolver for that question. The carousel card, the
 * gear-fab's `PersonaAdvanced` target, `resolveSigningSelection`'s dependant
 * case, the sign-in picker order and the NIP-46 route's default slot all derive
 * from it, so no surface can disagree with another about which key a dependant
 * is currently acting as.
 *
 * The answer follows `dep.primaryKeypair`, NOT activation:
 * - `'natural-person'` counts only while `isDependantNaturalPersonActive(dep)`;
 *   a dormant real identity is never the acting slot, or its pubkey leaks from
 *   the family carousel, the pairing QR and every template-without-pubkey
 *   `sign_event` — the exact failure §8 avoids for the owner.
 * - An extra persona's pubkey resolves to that extra.
 * - Everything else resolves to the persona.
 *
 * Because activation does not move `primaryKeypair` (spec §7.6: "the child
 * continues to land and sign as their handle"), running the activation ceremony
 * on a persona-first dependant changes nothing here. An existing dependant —
 * lifted active with an NP primary — resolves to the natural person exactly as
 * it always has.
 *
 * The "no key in that slot" fallbacks mirror `showNaturalPersonRow`'s rule for
 * the owner: never leave a row with no identity behind it.
 */
export function resolveDependantCardSlot(dep: DependantCardSlotInput): DependantCardSlot {
  const npActive = isDependantNaturalPersonActive(dep);
  const npCard: DependantCardSlot = { slotTarget: 'natural-person', slot: dep.naturalPerson };
  const personaCard: DependantCardSlot | null = dep.persona.publicKey
    ? { slotTarget: 'persona', slot: dep.persona }
    : null;

  if (dep.primaryKeypair === 'natural-person') {
    if (npActive && dep.naturalPerson.publicKey) return npCard;
    return personaCard ?? npCard;
  }

  if (dep.primaryKeypair !== 'persona') {
    const ep = (dep.extraPersonas ?? []).find(e => e.publicKey === dep.primaryKeypair);
    if (ep?.publicKey) return { slotTarget: ep.publicKey, slot: ep };
  }

  if (personaCard) return personaCard;
  return npCard;
}

/** Extract display info from a carousel row */
export function resolveActiveIdentity(row: CarouselRow): ResolvedIdentity {
  switch (row.type) {
    case 'bot': return { displayName: `${row.bot.label} · Bot`, displayNameIsSet: true, publicKey: row.bot.publicKey, type: 'Bot', isDependant: false };
    case 'natural-person': {
      const rawName = row.identity.naturalPerson.displayName;
      return {
        displayName: rawName || 'Natural Person',
        displayNameIsSet: !!rawName,
        publicKey: row.identity.naturalPerson.publicKey,
        type: 'Natural Person',
        isDependant: false,
        photoHash: row.identity.photoHash,
        blossomUrl: row.identity.blossomUrl,
        photoKey: row.identity.photoKey,
        avatarHash: row.identity.naturalPerson.avatarHash,
        avatarBlossomUrl: row.identity.naturalPerson.avatarBlossomUrl,
        avatarKey: row.identity.naturalPerson.avatarKey,
        slotTarget: 'natural-person',
        contactAvatarKey: row.identity.naturalPerson.contactAvatarKey,
        contactAvatarStale: row.identity.naturalPerson.contactAvatarStale,
        publicProfile: row.identity.naturalPerson.publicProfile,
      };
    }
    case 'persona': {
      const rawName = row.identity.persona.displayName;
      return {
        displayName: rawName || 'Persona',
        displayNameIsSet: !!rawName,
        publicKey: row.identity.persona.publicKey,
        type: 'Persona',
        isDependant: false,
        avatarHash: row.identity.persona.avatarHash,
        avatarBlossomUrl: row.identity.persona.avatarBlossomUrl,
        avatarKey: row.identity.persona.avatarKey,
        slotTarget: 'persona',
        contactAvatarKey: row.identity.persona.contactAvatarKey,
        contactAvatarStale: row.identity.persona.contactAvatarStale,
        publicProfile: row.identity.persona.publicProfile,
      };
    }
    case 'extra-persona': {
      const ep = row.identity.extraPersonas![row.personaIndex];
      const rawName = ep.displayName;
      return {
        displayName: rawName || 'Persona',
        displayNameIsSet: !!rawName,
        publicKey: ep.publicKey,
        type: 'Persona',
        isDependant: false,
        avatarHash: ep.avatarHash,
        avatarBlossomUrl: ep.avatarBlossomUrl,
        avatarKey: ep.avatarKey,
        slotTarget: ep.publicKey,
        contactAvatarKey: ep.contactAvatarKey,
        contactAvatarStale: ep.contactAvatarStale,
        publicProfile: ep.publicProfile,
      };
    }
    case 'dependant': {
      const rawName = row.dependant.displayName;
      const { slotTarget, slot } = resolveDependantCardSlot(row.dependant);
      return {
        displayName: rawName,
        displayNameIsSet: !!rawName,
        publicKey: slot.publicKey,
        type: 'Dependant',
        isDependant: true,
        dependantId: row.dependant.id,
        dateOfBirth: row.dependant.dateOfBirth,
        avatarHash: slot.avatarHash,
        avatarBlossomUrl: slot.avatarBlossomUrl,
        avatarKey: slot.avatarKey,
        slotTarget,
        contactAvatarKey: slot.contactAvatarKey,
        contactAvatarStale: slot.contactAvatarStale,
        publicProfile: slot.publicProfile,
      };
    }
    case 'dependant-persona': {
      const rawName = row.dependant.persona.displayName;
      return {
        displayName: rawName || 'Persona',
        displayNameIsSet: !!rawName,
        publicKey: row.dependant.persona.publicKey,
        type: 'Persona',
        // Persona rows aren't styled as a Dependant card — same convention
        // as `dependant-extra-persona` above (no age line, persona avatar).
        isDependant: false,
        dependantId: row.dependant.id,
        avatarHash: row.dependant.persona.avatarHash,
        avatarBlossomUrl: row.dependant.persona.avatarBlossomUrl,
        avatarKey: row.dependant.persona.avatarKey,
        slotTarget: 'persona',
        contactAvatarKey: row.dependant.persona.contactAvatarKey,
        contactAvatarStale: row.dependant.persona.contactAvatarStale,
        publicProfile: row.dependant.persona.publicProfile,
      };
    }
    case 'dependant-extra-persona': {
      const ep = row.dependant.extraPersonas![row.personaIndex];
      const rawName = ep.displayName;
      return {
        displayName: rawName || 'Persona',
        displayNameIsSet: !!rawName,
        publicKey: ep.publicKey,
        type: 'Persona',
        // Not marked isDependant: the child-mode ring still treats these
        // as persona-style rows (no age line, no guardian-only controls).
        isDependant: false,
        dependantId: row.dependant.id,
        avatarHash: ep.avatarHash,
        avatarBlossomUrl: ep.avatarBlossomUrl,
        avatarKey: ep.avatarKey,
        slotTarget: ep.publicKey,
        contactAvatarKey: ep.contactAvatarKey,
        contactAvatarStale: ep.contactAvatarStale,
        publicProfile: ep.publicProfile,
      };
    }
    case 'add':
      return {
        displayName: 'Add',
        displayNameIsSet: true,
        publicKey: '',
        type: 'Add',
        isDependant: false,
      };
  }
}

/**
 * Mirror of `resolveActiveIdentity` for the Sign-in approval flow, keyed
 * off an `AuthSelection` instead of a `CarouselRow`. The overlay/full
 * picker need a `ResolvedIdentity` for display, but the row-derived one
 * (`carousel.activeIdentity`) can drift after scan time when an unrelated
 * state update rebuilds `carousel.rows`. This resolver reads directly
 * from the canonical `identity` + `dependants` records using the
 * snapshot the carousel-camera handler captured at scan time, so display
 * and signing stay locked together.
 *
 * Returns `null` when the selection no longer maps to anything (e.g. the
 * dependant was deleted, or an extra persona was removed) — callers
 * should fall back to their own default in that case.
 */
export function resolveAuthSelectionIdentity(
  selection: { source: 'guardian'; keypairType: string }
    | { source: 'dependant'; dependantId: string; keypairType: string },
  identity: SignetIdentity,
  dependants: ReadonlyArray<DependantIdentity>,
): ResolvedIdentity | null {
  if (selection.source === 'guardian') {
    if (selection.keypairType === 'natural-person') {
      const rawName = identity.naturalPerson.displayName;
      return {
        displayName: rawName || 'Natural Person',
        displayNameIsSet: !!rawName,
        publicKey: identity.naturalPerson.publicKey,
        type: 'Natural Person',
        isDependant: false,
        photoHash: identity.photoHash,
        blossomUrl: identity.blossomUrl,
        photoKey: identity.photoKey,
        avatarHash: identity.naturalPerson.avatarHash,
        avatarBlossomUrl: identity.naturalPerson.avatarBlossomUrl,
        avatarKey: identity.naturalPerson.avatarKey,
        slotTarget: 'natural-person',
        contactAvatarKey: identity.naturalPerson.contactAvatarKey,
        contactAvatarStale: identity.naturalPerson.contactAvatarStale,
        publicProfile: identity.naturalPerson.publicProfile,
      };
    }
    if (selection.keypairType === 'persona') {
      const rawName = identity.persona.displayName;
      return {
        displayName: rawName || 'Persona',
        displayNameIsSet: !!rawName,
        publicKey: identity.persona.publicKey,
        type: 'Persona',
        isDependant: false,
        avatarHash: identity.persona.avatarHash,
        avatarBlossomUrl: identity.persona.avatarBlossomUrl,
        avatarKey: identity.persona.avatarKey,
        slotTarget: 'persona',
        contactAvatarKey: identity.persona.contactAvatarKey,
        contactAvatarStale: identity.persona.contactAvatarStale,
        publicProfile: identity.persona.publicProfile,
      };
    }
    const ep = identity.extraPersonas?.find(e => e.publicKey === selection.keypairType);
    if (!ep) return null;
    const rawEpName = ep.displayName;
    return {
      displayName: rawEpName || 'Persona',
      displayNameIsSet: !!rawEpName,
      publicKey: ep.publicKey,
      type: 'Persona',
      isDependant: false,
      avatarHash: ep.avatarHash,
      avatarBlossomUrl: ep.avatarBlossomUrl,
      avatarKey: ep.avatarKey,
      slotTarget: ep.publicKey,
      contactAvatarKey: ep.contactAvatarKey,
      contactAvatarStale: ep.contactAvatarStale,
      publicProfile: ep.publicProfile,
    };
  }
  const dep = dependants.find(d => d.id === selection.dependantId);
  if (!dep) return null;
  if (selection.keypairType === 'natural-person') {
    const rawName = dep.displayName;
    return {
      displayName: rawName,
      displayNameIsSet: !!rawName,
      publicKey: dep.naturalPerson.publicKey,
      type: 'Dependant',
      isDependant: true,
      dependantId: dep.id,
      dateOfBirth: dep.dateOfBirth,
      avatarHash: dep.naturalPerson.avatarHash,
      avatarBlossomUrl: dep.naturalPerson.avatarBlossomUrl,
      avatarKey: dep.naturalPerson.avatarKey,
      slotTarget: 'natural-person',
      contactAvatarKey: dep.naturalPerson.contactAvatarKey,
      contactAvatarStale: dep.naturalPerson.contactAvatarStale,
      publicProfile: dep.naturalPerson.publicProfile,
    };
  }
  if (selection.keypairType === 'persona') {
    const rawName = dep.persona.displayName;
    return {
      displayName: rawName || 'Persona',
      displayNameIsSet: !!rawName,
      publicKey: dep.persona.publicKey,
      type: 'Persona',
      isDependant: false,
      dependantId: dep.id,
      avatarHash: dep.persona.avatarHash,
      avatarBlossomUrl: dep.persona.avatarBlossomUrl,
      avatarKey: dep.persona.avatarKey,
      slotTarget: 'persona',
      contactAvatarKey: dep.persona.contactAvatarKey,
      contactAvatarStale: dep.persona.contactAvatarStale,
      publicProfile: dep.persona.publicProfile,
    };
  }
  const ep = dep.extraPersonas?.find(e => e.publicKey === selection.keypairType);
  if (!ep) return null;
  const rawEpName = ep.displayName;
  return {
    displayName: rawEpName || 'Persona',
    displayNameIsSet: !!rawEpName,
    publicKey: ep.publicKey,
    type: 'Persona',
    isDependant: false,
    dependantId: dep.id,
    avatarHash: ep.avatarHash,
    avatarBlossomUrl: ep.avatarBlossomUrl,
    avatarKey: ep.avatarKey,
    slotTarget: ep.publicKey,
    contactAvatarKey: ep.contactAvatarKey,
    contactAvatarStale: ep.contactAvatarStale,
    publicProfile: ep.publicProfile,
  };
}

/**
 * Find the parent-ring row index for one of the guardian's keypairs.
 * Used after a Sign-in approval to land the carousel on the card matching what
 * the user actually signed with — visual confirmation of identity.
 *
 * Resolved by searching `buildRows` rather than by arithmetic, because the ring
 * order is now conditional (the natural-person row only exists when activated).
 * Guardian rows always precede dependant rows, so an empty dependant list is
 * enough to index them.
 *
 * Falls back to row 0 when the keypair has no row (dormant natural person,
 * hidden or deleted extra, empty persona slot).
 */
export function findRowForGuardianKeypair(
  identity: SignetIdentity,
  keypairType: string,
  bots: readonly BotMetadata[] = [],
): number {
  const rows = buildRows(identity, [], bots);
  const idx = rows.findIndex(row => {
    if (row.type === 'natural-person') return keypairType === 'natural-person';
    if (row.type === 'persona') return keypairType === 'persona';
    if (row.type === 'extra-persona') {
      return identity.extraPersonas?.[row.personaIndex]?.publicKey === keypairType;
    }
    return false;
  });
  return idx >= 0 ? idx : 0;
}

/**
 * Find the parent-ring row index for a dependant. Returns `null` if the
 * dependant is no longer in the array (deleted between scan and approval).
 *
 * The parent ring shows one row per dependant — the dep's NP card. Landing on a
 * specific dep persona row would require entering child-mode for that dep, which
 * is a deliberate "hand the device over" action, so all dep selections land on
 * the same parent-ring row regardless of which keypair was picked.
 */
export function findRowForDependant(
  identity: SignetIdentity,
  dependants: ReadonlyArray<DependantIdentity>,
  dependantId: string,
  bots: readonly BotMetadata[] = [],
): number | null {
  if (!dependants.some(d => d.id === dependantId)) return null;
  const rows = buildRows(identity, [...dependants], bots);
  const idx = rows.findIndex(row => row.type === 'dependant' && row.dependant.id === dependantId);
  return idx >= 0 ? idx : null;
}
