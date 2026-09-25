/**
 * Contacts v2 app-grant registry (exploration §5.1–5.3, §5.10).
 *
 * One record per app grant. Unlike the v1 `CompanionGrant`, this record HOLDS
 * SECRET MATERIAL: the rail key is fresh random rather than derived, so losing
 * this row loses the ability to publish that grant's projection at all. That is
 * the deliberate trade for revocability — a derived rail can only be revoked by
 * tombstone, a random one is simply never used again — and it is why the whole
 * body is encrypted at rest and why the registry rides the contacts checkpoint.
 *
 * `grantId`, `directoryId`, `appPubkey` and `createdAt` stay in clear so the
 * store can be indexed and enumerated without unlocking, the same accepted
 * routing-metadata trade-off as `documents` and `credentials`.
 */
import type { Capability } from '@forgesworn/signet-contacts/wire';

/** One app-local rename, with the last-writer-wins clock it was applied at
 *  (R-17). `updatedAt` is the accepted proposal's own clock (ms epoch), not a
 *  local application timestamp — that is what lets a later, older-clocked
 *  replay be told apart from a genuinely newer rename. */
export interface AppLabelEntry {
  label: string;
  updatedAt: number;
}

export interface AppGrantV2 {
  /** 32 hex. Key path. Minted once at approval and never reused. */
  grantId: string;
  /** Phase B/C directory id: `'owner'`, `dependant:<64 lowercase hex>`, or `'quarantine'`. */
  directoryId: string;
  /** Missing on retired vault-wide grants: reconnect for explicit list consent. */
  ownerIdentityPubkey?: string;
  /** The consuming app's own pubkey — the only key it proves at pairing. */
  appPubkey: string;
  createdAt: number;
  /** R-2: the grants rail's last-writer-wins key. Bumped on every local change
   *  to this row, so a second device can tell a newer record from an older one
   *  without guessing from `createdAt`, which never moves after approval. */
  updatedAt: number;
  appName: string;
  capabilities: Capability[];
  railPubkey: string;
  /** 64 hex. Secret. Encrypted at rest with the rest of the body. */
  railPrivateKey: string;
  relay: string;
  maxStalenessSeconds: number;
  /** Set on revocation. The row is KEPT for audit; a revoked grant never
   *  publishes again, and R-13 lets the owner forget it outright. */
  revokedAt?: number;
  /** Explicit app-invite permission may be narrowed to manual acceptance. */
  autoAcceptInvites?: boolean;
  // The three below are DEVICE-LOCAL publish state: they describe what THIS
  // device last did, so they are excluded from the grants rail by type
  // (`WireGrantV2`) rather than by remembering to strip them.
  lastProjectionHash?: string;
  lastProjectionAt?: number;
  /** R-5: what the last publish attempt actually achieved. `'truncated'` means
   *  the app is holding a deliberately partial directory, which the grants list
   *  says out loud rather than leaving the owner to assume it is complete. */
  lastPublishState?: 'ok' | 'truncated' | 'failed';
  /** App-local renames, keyed by the GRANT-SCOPED contact id the app was given.
   *  Overrides `displayName` for this app only and is never applied locally.
   *  R-17: each entry carries its OWN clock (the proposal's `updatedAt`, ms
   *  epoch) so a replayed or reordered rename can never clobber a newer one —
   *  the enforcing writer (`useContactProposals`) applies an incoming rename
   *  only when its `updatedAt` is strictly greater than the stored entry's. */
  appLabels: Record<string, AppLabelEntry>;
  /** Proposal replay guard, newest last, trimmed to SEEN_OPERATION_ID_CAP. */
  seenOperationIds: string[];
}

/**
 * Max v2 grants at once. Separate from COMPANION_GRANT_CAP — the v1 rail has
 * its own store and its own cap, and neither should crowd out the other.
 *
 * R-13: this counts ACTIVE grants. A revoked row is kept for audit, not as a
 * reserved slot; counting revocations would mean ten disconnections locked the
 * owner out of ever connecting an app again, which is a punishment for using
 * the safety feature.
 */
export const CONTACT_GRANT_V2_CAP = 10;

/** R-2: how many app-local renames ride the grants rail per grant. Ten grants
 *  × sixteen labels × a hundred characters is the whole registry's worst case,
 *  which is what keeps it inside one envelope. */
export const MAX_APP_LABELS_PER_GRANT = 16;

/** Maximum distinct introductions per grant, including pending/rejected and
 * removed records. Rotation of proposal ids or deletion cannot reset the cap. */
export const MAX_APP_CREATED_CONTACTS = 500;

/** A proposing app is capped at 50 proposals per batch, so 500 remembered ids
 *  covers ten full batches before the oldest is forgotten. An operationId that
 *  falls out of the window can only be replayed by an app that still holds the
 *  grant, and a replayed `add-ken` is idempotent at the contacts layer anyway. */
export const SEEN_OPERATION_ID_CAP = 500;

/** Staleness windows the approval screen offers: 1 hour, 6 hours, 1 day, 7 days. */
export const STALENESS_CHOICES: readonly number[] = [3600, 21600, 86400, 604800];
