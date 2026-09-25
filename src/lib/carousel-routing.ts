import type { CarouselRow } from '../types';

/**
 * Resolve the dependant id to set as active when navigating away from a
 * carousel row in owner-mode. Returns null when the row is not a
 * dep-related row, or when the user is already in child-mode (which sets
 * activeDependantId separately via handleEnterChildMode).
 *
 * Covers all three dep-related row types so navigation from any of them
 * scopes settings to the correct dep. Spec §3.1.
 */
export function resolveDependantIdFromRow(
  row: CarouselRow | undefined,
  childMode: boolean,
): string | null {
  if (childMode) return null;
  if (!row) return null;
  if (
    row.type === 'dependant' ||
    row.type === 'dependant-persona' ||
    row.type === 'dependant-extra-persona'
  ) {
    return row.dependant.id;
  }
  return null;
}

/**
 * Resolve the dependant id for a row regardless of childMode.
 *
 * Use this when the navigation target NEEDS the dep id explicitly threaded
 * through (e.g. persona-advanced route, which scopes its slot lookup off
 * `pendingPersonaAdvancedTarget.depPubkey`) — even when `childMode` is true
 * the caller still wants the unambiguous dep id from the row.
 *
 * Contrast with `resolveDependantIdFromRow` which suppresses in child-mode
 * to avoid double-setting `activeDependantId` (already set by
 * `handleEnterChildMode`). The gear-fab route depends on
 * `pendingPersonaAdvancedTarget.depPubkey` being set, so we always emit it.
 */
export function resolveDependantIdFromRowAlways(
  row: CarouselRow | undefined,
): string | null {
  if (!row) return null;
  if (
    row.type === 'dependant' ||
    row.type === 'dependant-persona' ||
    row.type === 'dependant-extra-persona'
  ) {
    return row.dependant.id;
  }
  return null;
}

type SigningMode = 'local' | 'bunker' | 'nip07' | 'paired-child' | undefined;

/**
 * Resolve which viewer mode the settings page should render.
 *
 * 'child' for any acted-as view — both on the guardian's phone in
 * carousel child-mode AND on the kid's paired phone. 'guardian' otherwise.
 *
 * Reverts the May 7 fix (db578c7) on the carousel-childMode side to honour
 * strict-mirror per spec §3.2. Paired-child installs already returned
 * 'child'; that path is unchanged.
 */
export function resolveSettingsViewer(
  signingMode: SigningMode,
  childMode: boolean,
): 'guardian' | 'child' {
  if (signingMode === 'paired-child') return 'child';
  if (childMode) return 'child';
  return 'guardian';
}

/**
 * Whether the pairing-status hint should render on a carousel identity
 * card. Only true for owner-mode-on-dep-row on a non-paired-child
 * install — i.e. the guardian managing the dep from their own device.
 *
 * Hidden in any acted-as view: carousel child-mode (acting-as on
 * guardian's phone) or paired-child install (the dep IS the paired
 * device — pairing already happened). Per spec §3.4.
 */
export function shouldShowPairingStatus(
  rowType: CarouselRow['type'],
  childMode: boolean,
  signingMode: SigningMode,
): boolean {
  if (rowType !== 'dependant') return false;
  if (childMode) return false;
  if (signingMode === 'paired-child') return false;
  return true;
}
