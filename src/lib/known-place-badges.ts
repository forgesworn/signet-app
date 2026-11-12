/**
 * Badges for a known place, in the design's precedence order. The first badge
 * is the one a chip shows; the rest appear on the expanded row.
 *
 * Pure: whether a place signs automatically is read live by the caller from the
 * source of truth (the paired client's `askToSign`, the NIP-55 grant) and passed
 * in; nothing here is stored.
 */

import type { KnownPlace } from '../types/known-places';
import type { KeyHome } from './key-home';

export type BadgeKind =
  | 'expires-soon'
  | 'auto'
  | 'heartwood'
  | 'other-device'
  | 'shared'
  | 'pinned'
  | 'dormant';

export type Badge = { kind: BadgeKind; label: string };

export interface BadgeContext {
  /** nip46 only: the paired client asks before each signature. */
  askToSign?: boolean;
  /** nip55 only: the grant for this caller, if the person made one. */
  nip55Grant?: { allowAlways: boolean; denyAlways: boolean } | null;
  /** The paired-client list has not loaded yet: whether a client signs automatically is unknown, so claim nothing. */
  loading?: boolean;
  /** What actually signs for the place's key, read live; wins over the signer recorded at approval. */
  signedBy?: KeyHome;
  /** Unix seconds when this place's access ends, if it ends. */
  expiresAt?: number;
  /** Unix seconds. */
  now: number;
}

const DAY = 86_400;
export const EXPIRES_SOON_SECONDS = 7 * DAY;
export const DORMANT_SECONDS = 90 * DAY;

function sharedLabel(shared: KnownPlace['shared']): string | null {
  if (shared.handle && shared.picture) return 'Shared handle and picture';
  if (shared.handle) return 'Shared handle';
  if (shared.picture) return 'Shared picture';
  return null;
}

export function badgesFor(place: KnownPlace, ctx: BadgeContext): Badge[] {
  const badges: Badge[] = [];

  if (ctx.expiresAt !== undefined && ctx.expiresAt > ctx.now && ctx.expiresAt - ctx.now <= EXPIRES_SOON_SECONDS) {
    badges.push({ kind: 'expires-soon', label: 'Expires soon' });
  }

  const signsAutomatically = !ctx.loading && (
    (place.kind === 'nip46' && !ctx.askToSign) ||
    (place.kind === 'nip55' && ctx.nip55Grant?.allowAlways === true));
  if (signsAutomatically) badges.push({ kind: 'auto', label: 'Signs automatically' });

  if ((ctx.signedBy ?? place.signer) === 'heartwood') badges.push({ kind: 'heartwood', label: 'Signed by your Heartwood' });

  if (place.channel === 'other-device') badges.push({ kind: 'other-device', label: 'Another device' });

  const shared = sharedLabel(place.shared);
  if (shared) badges.push({ kind: 'shared', label: shared });

  if (place.pinned) badges.push({ kind: 'pinned', label: 'Pinned' });

  if (ctx.now - place.lastAt > DORMANT_SECONDS) badges.push({ kind: 'dormant', label: 'Not used in 3 months' });

  return badges;
}

/** The badge a chip shows: the highest-precedence one, or null for a plain place. */
export function primaryBadge(badges: Badge[]): Badge | null {
  return badges[0] ?? null;
}
