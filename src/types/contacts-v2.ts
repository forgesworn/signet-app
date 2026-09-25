import type { ContactOrigin } from '../lib/contact-origins';
import type { ContactCheck } from '../lib/contact-checks';
/**
 * Contacts v2 data model (spec §7.8–7.10; exploration §5.4–5.6, §5.9, §8.2).
 *
 * The canonical key is `(directoryId, contactId)`. `contactId` is random for a
 * new contact and domain-separated deterministic for a legacy import.
 * `directoryId` is `'owner'`, `` `dependant:${dep.id.toLowerCase()}` `` for every
 * dependant — tree-derived or imported alike, see `directoryIdForDependant` —
 * or `'quarantine'` when a legacy row's owner cannot be mapped.
 *
 * Relationship evidence and policy are APPEND-ONLY facts (`vouches`,
 * `ceilings`, `blocks`), never an overwritten tier: the effective view is
 * computed by `contacts-v2-effective.ts`. Tier never grants access —
 * `accessGrants` is a separate axis and is a type only in this phase.
 */

/** Social classification. Kin = close circle, Kith = acquaintance, Ken = one-way recognised. */
export type ContactTier = 'kin' | 'kith' | 'ken';

/** A ceiling may also forbid every tier outright. */
export type ContactCeilingTier = ContactTier | 'none';

export type ContactType = 'person' | 'organisation';

export type ContactLifecycle = 'suggested' | 'pending' | 'active' | 'rejected' | 'removed';

export type ContactVerification = 'unverified' | 'proven' | 'mutual';

export type ContactIdentityProvenance =
  | 'direct'
  | 'guardian-share'
  | 'app-proposal'
  | 'legacy-import'
  | 'key-link';

export type ContactMethodKind = 'phone' | 'email' | 'website' | 'postal-address' | 'other';

export type ContactMethodSharing = 'private' | 'grantable';

export type ContactActorRole = 'owner' | 'guardian' | 'dependant' | 'app';

export type ContactTierSource = 'direct' | 'guardian-vouched' | 'guardian-limited';

export type ContactAction =
  | 'add'
  | 'rename'
  | 'set-tier'
  | 'set-roles'
  | 'add-identity'
  | 'update-identity'
  | 'add-method'
  | 'update-method'
  | 'remove-item'
  | 'evidence'
  | 'vouch'
  | 'revoke-vouch'
  | 'ceiling'
  | 'revoke-ceiling'
  | 'block'
  | 'unblock'
  | 'set-lifecycle'
  | 'archive'
  | 'remove'
  | 'key-link'
  | 'note'
  | 'link-list'
  | 'unlink-list'
  | 'app-propose-list'
  | 'review-app-list'
  | 'receive-share'
  | 'record-share'
  | 'record-origin'
  | 'remove-origin'
  | 'record-check'
  | 'remove-check';

/** Closeness order. Higher is closer. `'none'` ranks 0 — see `contacts-v2-effective.ts`. */
export const CONTACT_TIER_RANK: Record<ContactTier, number> = { ken: 1, kith: 2, kin: 3 };

/** The guardian's own directory. */
export const OWNER_DIRECTORY_ID = 'owner';

/** Legacy rows whose `ownerPubkey` maps to no known slot land here — never on a child. */
export const QUARANTINE_DIRECTORY_ID = 'quarantine';

/** Default guardian ceiling for a contact a dependant added themselves (§7.10 review note). */
export const DEFAULT_CHILD_CEILING: ContactCeilingTier = 'ken';

/** Direct (mutual-ceremony) evidence for one identity. `sharedSecret` is encrypted at rest with the record body. */
export interface ContactDirectEvidence {
  /** The owner slot pubkey that actually performed the ceremony. */
  ownerPubkey: string;
  sharedSecret?: string;
  verifiedAt: number;
  bondAssertion?: unknown;
  /** Legacy local grouping annotations, preserved verbatim on import. Never wire data. */
  groupId?: string;
  isDefaultForGroup?: boolean;
}

export interface ContactIdentity {
  itemId: string;
  /** 64-hex Nostr pubkey. */
  pubkey: string;
  label?: string;
  provenance: ContactIdentityProvenance;
  verification: ContactVerification;
  direct?: ContactDirectEvidence;
  /** Set when this identity arrived through a proven key rotation from another item. */
  linkedFromItemId?: string;
  addedAt: number;
}

export interface ContactMethod {
  itemId: string;
  kind: ContactMethodKind;
  label?: string;
  value: string;
  verification: 'unverified' | 'proven';
  sharingPolicy: ContactMethodSharing;
  addedAt: number;
}

/** Purpose-specific grant reference. Type only in this phase — nothing reads or writes it. */
export interface AccessGrantRef {
  grantId: string;
  purpose: string;
  fields: string[];
  recipientPubkey: string;
  createdAt: number;
  expiresAt?: number;
}

export interface GuardianVouch {
  vouchId: string;
  guardianPubkey: string;
  tier: ContactTier;
  role?: string;
  createdAt: number;
  operationId: string;
  revokedByOperationId?: string;
}

export interface GuardianCeiling {
  guardianPubkey: string;
  maxTier: ContactCeilingTier;
  createdAt: number;
  operationId: string;
  revokedByOperationId?: string;
}

export type BlockScope = { kind: 'contact' } | { kind: 'identity'; itemId: string };

export interface BlockFact {
  blockedBy: string;
  scope: BlockScope;
  blockedAt: number;
  reason?: string;
  operationId: string;
  liftedByOperationId?: string;
}

/** Membership in an owning identity's list, within this record's vault only.
 * Removed memberships remain as history; they are not active list access. */
export interface ContactListMembership {
  ownerIdentityPubkey: string;
  addedAt: number;
  removedAt?: number;
}

export interface ContactListValue { ownerIdentityPubkey: string }

export interface AppContactIntroduction {
  appName?: string;
  grantId: string;
  ownerIdentityPubkey: string;
  pubkey: string;
  displayName: string;
  status: 'pending' | 'accepted' | 'rejected';
  restricted: boolean;
  logicalClock: number;
  createdAt: number;
}
export type AppContactIntroductionValue = Pick<AppContactIntroduction, 'grantId' | 'ownerIdentityPubkey' | 'pubkey' | 'displayName' | 'appName'>;

export interface SharedContactContext {
  guardianPubkey: string;
  receivedAt: number;
  tier?: ContactTier;
  blocked?: boolean;
  checks?: { pubkey: string; verification: ContactVerification; verifiedAt?: number }[];
  checkRecords?: { pubkey: string; method: ContactCheck['method']; checkedAt: number }[];
}
export interface ContactRecord {
  origins?: ContactOrigin[];
  checks?: ContactCheck[];
  /** Internal aliases after concurrent same-npub creation. Never shared. */
  mergedContactIds?: string[];
  sharedContexts?: SharedContactContext[];
  sharesSent?: { directoryId: string; contactId: string; sharedAt: number }[];
  appIntroductions?: AppContactIntroduction[];
  /** Absent on old records until explicitly assigned; never infer from the signer. */
  primaryIdentityPubkey?: string;
  listMemberships?: ContactListMembership[];
  directoryId: string;
  contactId: string;
  type: ContactType;
  displayName: string;
  /** The owner's own (direct) classification. Never the effective tier. */
  tier: ContactTier;
  /** A later human classification supersedes the initial app-only Ken cap. */
  tierSetByActorRole?: ContactActorRole;
  roles: string[];
  identities: ContactIdentity[];
  contactMethods: ContactMethod[];
  accessGrants: AccessGrantRef[];
  lifecycle: ContactLifecycle;
  createdAt: number;
  updatedAt: number;
  removedAt?: number;
  archived?: boolean;
  /** Actor role of the `add` that created this record — drives the default child ceiling. */
  createdByActorRole: ContactActorRole;
  createdByOperationId: string;
  vouches: GuardianVouch[];
  ceilings: GuardianCeiling[];
  blocks: BlockFact[];
  /** Private owner/guardian note. Never projected to an app. */
  notes?: string;
}

export interface ContactOperation {
  /** List in which a human made this edit; used for app-introduction disclosure. */
  ownerIdentityPubkey?: string;
  /** 32 hex. Global idempotency key. */
  operationId: string;
  directoryId: string;
  contactId: string;
  itemId?: string;
  actorPubkey: string;
  actorRole: ContactActorRole;
  actorDeviceId: string;
  /** Lamport clock — see `contacts-v2-clock.ts`. */
  logicalClock: number;
  action: ContactAction;
  /** Required when revoking a prior fact (`revoke-vouch`, `unblock`). */
  targetOperationId?: string;
  /** Action-specific; validated by `validateOperation` before it is ever applied. */
  value: unknown;
  createdAt: number;
}

export interface EffectiveContact extends ContactRecord {
  effectiveTier: ContactCeilingTier;
  tierSource: ContactTierSource;
  blocked: boolean;
  blockedBy: string[];
}

export interface AddContactValue {
  appIntroduction?: AppContactIntroductionValue;
  /** The list selected by the person adding the contact, not the signing key. */
  ownerIdentityPubkey?: string;
  type: ContactType;
  displayName: string;
  tier: ContactTier;
  roles?: string[];
  /** A contact cannot be born removed — excludes 'removed' from ContactLifecycle. */
  lifecycle?: Exclude<ContactLifecycle, 'removed'>;
}
export interface RenameValue { displayName: string }
export interface SetTierValue { tier: ContactTier }
export interface SetRolesValue { roles: string[] }
export interface AddIdentityValue {
  itemId: string;
  pubkey: string;
  label?: string;
  provenance: ContactIdentityProvenance;
  verification: ContactVerification;
  direct?: ContactDirectEvidence;
  linkedFromItemId?: string;
}
export interface UpdateIdentityValue {
  itemId: string;
  label?: string;
  verification?: ContactVerification;
  direct?: ContactDirectEvidence;
}
export interface AddMethodValue {
  itemId: string;
  kind: ContactMethodKind;
  label?: string;
  value: string;
  verification: 'unverified' | 'proven';
  sharingPolicy: ContactMethodSharing;
}
export interface UpdateMethodValue {
  itemId: string;
  label?: string;
  value?: string;
  verification?: 'unverified' | 'proven';
  sharingPolicy?: ContactMethodSharing;
}
export interface RemoveItemValue { itemId: string }
export interface VouchValue { guardianPubkey: string; tier: ContactTier; role?: string }
export interface CeilingValue { guardianPubkey: string; maxTier: ContactCeilingTier }
export interface RevokeCeilingValue { guardianPubkey: string }
export interface BlockValue { scope: BlockScope; reason?: string }
export interface SetLifecycleValue { lifecycle: 'suggested' | 'pending' | 'active' | 'rejected' }
export interface KeyLinkValue { itemId: string; pubkey: string; linkedFromItemId: string }
export interface NoteValue { note: string }
