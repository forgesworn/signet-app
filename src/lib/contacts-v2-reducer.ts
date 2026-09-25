import { validContactOrigin, normaliseContactOrigin, type ContactOrigin } from './contact-origins';
import { CONTACT_CHECK_METHODS, validContactCheck, normaliseContactCheck } from './contact-checks';
import type { ContactCheck } from './contact-checks';
/**
 * Contacts v2 reducer (§7.10, §8.2).
 *
 * Folds an append-only operation log into materialised records. Deterministic
 * by construction: operations are sorted by (logicalClock, actorPubkey,
 * operationId) and applied in that order, so every device that holds the same
 * set of operations computes byte-identical records regardless of arrival
 * order.
 *
 * Two rules carry the safety weight:
 *   - an operation whose `value` fails its action's guard is SKIPPED, never
 *     thrown — a corrupt or hostile row must not take a directory offline;
 *   - `remove`/`archive` write a durable tombstone. While a record is
 *     `removed`, only a LATER `add` revives it; safety actions remain valid, but
 *     a straggling low-clock mutation can never undo a deletion.
 *
 * Pure: no storage, no time, no randomness.
 */

import type {
  AddContactValue,
  AddIdentityValue,
  AddMethodValue,
  BlockValue,
  CeilingValue,
  ContactAction,
  ContactListValue,
  AppContactIntroductionValue,
  SharedContactContext,
  ContactDirectEvidence,
  ContactOperation,
  ContactRecord,
  KeyLinkValue,
  NoteValue,
  RemoveItemValue,
  RenameValue,
  RevokeCeilingValue,
  SetLifecycleValue,
  SetRolesValue,
  SetTierValue,
  UpdateIdentityValue,
  UpdateMethodValue,
  VouchValue,
} from '../types';
import { linkContactList, unlinkContactList, removeContactLists, validContactLists } from './contacts-v2-membership';
import { sanitizeDisplayName, sanitizeNote } from './text-sanitize';

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * R-15: the three shapes a directory id can have — the owner's own directory,
 * the unresolved-import quarantine, and one dependant addressed by the 64-hex
 * pubkey Phase C keys them by (`directoryIdForDependant`).
 *
 * Phase C left this length-capped because every operation was authored by this
 * device's own UI. Phase E opens a second inbound path (an app proposal, built
 * from a relay-delivered request), so "well-formed enough" stops being the
 * right bar: an id nothing can resolve routes an operation to a directory that
 * does not exist, where it is neither applied nor visible nor removable.
 */
const DIRECTORY_ID = /^(owner|bots|quarantine|dependant:[0-9a-f]{64})$/;

// CAP_NAME/CAP_ROLE/CAP_METHOD_VALUE are exported so `contact-projection.test.ts`
// can pin them against the SDK wire's own MAX_* caps (I4d) rather than
// mirroring the values as separate literals.
export const CAP_NAME = 100;
export const CAP_ROLE = 40;
const CAP_ROLES = 12;
const CAP_LABEL = 60;
export const CAP_METHOD_VALUE = 200;
const CAP_REASON = 200;
const CAP_NOTE = 2000;

const ACTIONS: readonly ContactAction[] = [
  'add', 'rename', 'set-tier', 'set-roles', 'add-identity', 'update-identity',
  'add-method', 'update-method', 'remove-item', 'evidence', 'vouch', 'revoke-vouch',
  'ceiling', 'revoke-ceiling', 'block', 'unblock', 'set-lifecycle', 'archive',
  'remove', 'key-link', 'note', 'link-list', 'unlink-list', 'app-propose-list', 'review-app-list', 'receive-share', 'record-share', 'record-check', 'remove-check', 'record-origin', 'remove-origin',
];

/**
 * Opus review gap (Task 24 fix round 1): `actorRole: 'app'` was accepted for
 * every action, so once an app can author ops (Task 25) it could `block` a
 * contact and, under §7.10 (only the blocking authority may lift a block),
 * become the ONLY party able to reverse its own block — or vouch, set a
 * ceiling, or delete something it never added. An app may only add material
 * it is proposing; every action with review/authority semantics
 * (block/unblock, vouch/revoke-vouch, ceiling/revoke-ceiling, remove/archive,
 * set-tier/set-roles/set-lifecycle, note, remove-item, key-link,
 * update-identity/update-method, evidence) is refused outright for an app
 * actor.
 *
 * Pre-merge ruling: `rename` is NOT on this list. Nothing constructs an
 * app-authored rename — a `rename-app-label` proposal writes
 * `AppGrantV2.appLabels`, which is grant-scoped and consulted only when
 * building that one app's own projection, and never touches the operation
 * log. A permission with no producer is a permission waiting to be found:
 * least privilege says leave it off until something actually needs it.
 */
const APP_ALLOWED_ACTIONS: ReadonlySet<ContactAction> = new Set(['add', 'add-identity', 'add-method', 'app-propose-list']);

/**
 * The ONE place single-line free text is cleaned before it is stored (M5).
 * Roles, identity and method labels, method values and block reasons all go
 * through here at their own cap; a note goes through `sanitizeNote` instead,
 * because it is the only multi-line field in the model.
 */
function clean(raw: string, cap: number): string {
  return sanitizeDisplayName(raw, cap);
}

/** Map key for a materialised record. */
export function recordKey(directoryId: string, contactId: string): string {
  return `${directoryId}/${contactId}`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown, cap: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= cap;
}
function isOptStr(v: unknown, cap: number): boolean {
  return v === undefined || isStr(v, cap);
}
function validSharedContext(v: unknown): boolean {
  return isObj(v) && isHex(v.guardianPubkey, HEX64)
    && (v.tier === undefined || isTier(v.tier))
    && (v.blocked === undefined || typeof v.blocked === 'boolean')
    && (v.checkRecords === undefined || (Array.isArray(v.checkRecords) && v.checkRecords.length <= 128 && everyElement(v.checkRecords, c => isHex(c.pubkey, HEX64)
      && CONTACT_CHECK_METHODS.includes(c.method as ContactCheck['method']) && Number.isSafeInteger(c.checkedAt) && Number(c.checkedAt) >= 0)))
    && (v.checks === undefined || everyElement(v.checks, c => isHex(c.pubkey, HEX64) && isVerification(c.verification)
      && (c.verifiedAt === undefined || (typeof c.verifiedAt === 'number' && Number.isFinite(c.verifiedAt) && c.verifiedAt >= 0))));
}
function validIntroduction(v: unknown): boolean {
  return isObj(v) && isHex(v.grantId, HEX32) && isHex(v.ownerIdentityPubkey, HEX64)
    && isHex(v.pubkey, HEX64) && isStr(v.displayName, CAP_NAME) && isOptStr(v.appName, CAP_NAME);
}
function isTier(v: unknown): boolean {
  return v === 'kin' || v === 'kith' || v === 'ken';
}
function isCeilingTier(v: unknown): boolean {
  return isTier(v) || v === 'none';
}
function isVerification(v: unknown): boolean {
  return v === 'unverified' || v === 'proven' || v === 'mutual';
}
function isMethodVerification(v: unknown): boolean {
  return v === 'unverified' || v === 'proven';
}
function isProvenance(v: unknown): boolean {
  return v === 'direct' || v === 'guardian-share' || v === 'app-proposal'
    || v === 'legacy-import' || v === 'key-link';
}
function isMethodKind(v: unknown): boolean {
  return v === 'phone' || v === 'email' || v === 'website' || v === 'postal-address' || v === 'other';
}
function isSharing(v: unknown): boolean {
  return v === 'private' || v === 'grantable';
}
function isLifecycleValue(v: unknown): boolean {
  return v === 'suggested' || v === 'pending' || v === 'active' || v === 'rejected';
}
function isRoles(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= CAP_ROLES
    && v.every(r => typeof r === 'string' && r.length > 0 && r.length <= CAP_ROLE);
}
const SHARED_SECRET = /^[0-9a-f]{1,128}$/;
const CAP_BOND_ASSERTION_BYTES = 4096;

/** A plain object that serialises to at most `cap` characters of JSON. */
function isBoundedObject(v: unknown, cap: number): boolean {
  if (!isObj(v)) return false;
  try {
    return JSON.stringify(v).length <= cap;
  } catch {
    return false;   // circular, or a value JSON cannot represent
  }
}

function isDirect(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (typeof v.ownerPubkey !== 'string' || !HEX64.test(v.ownerPubkey)) return false;
  if (typeof v.verifiedAt !== 'number' || !Number.isFinite(v.verifiedAt)) return false;
  // The legacy shared secret is an ECDH result in hex. Bounding it keeps an
  // unbounded blob out of the record body (and out of every later re-encrypt).
  if (v.sharedSecret !== undefined && (typeof v.sharedSecret !== 'string' || !SHARED_SECRET.test(v.sharedSecret))) return false;
  if (v.groupId !== undefined && !isStr(v.groupId, CAP_LABEL)) return false;
  if (v.isDefaultForGroup !== undefined && typeof v.isDefaultForGroup !== 'boolean') return false;
  // `bondAssertion` is typed `unknown` — accept only a bounded plain object,
  // never a string, an array, or an arbitrarily large blob.
  if (v.bondAssertion !== undefined && !isBoundedObject(v.bondAssertion, CAP_BOND_ASSERTION_BYTES)) return false;
  return true;
}

/**
 * Copy ONLY the fields the model defines. Unknown keys in a `direct` block are
 * dropped rather than persisted and re-encrypted forever — an operation is
 * append-only, so anything carried in here is carried for good.
 */
function normaliseDirect(v: ContactDirectEvidence | undefined): ContactDirectEvidence | undefined {
  if (!v) return undefined;
  return {
    ownerPubkey: v.ownerPubkey,
    ...(v.sharedSecret !== undefined ? { sharedSecret: v.sharedSecret } : {}),
    verifiedAt: v.verifiedAt,
    ...(v.bondAssertion !== undefined ? { bondAssertion: v.bondAssertion } : {}),
    ...(v.groupId !== undefined ? { groupId: v.groupId } : {}),
    ...(v.isDefaultForGroup !== undefined ? { isDefaultForGroup: v.isDefaultForGroup } : {}),
  };
}
function isScope(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (v.kind === 'contact') return true;
  return v.kind === 'identity' && typeof v.itemId === 'string' && HEX32.test(v.itemId);
}

/** Action-specific `value` guard. Anything not listed here is rejected. */
function validateValue(op: { action: ContactAction; value: unknown; targetOperationId?: string }): boolean {
  const v = op.value;
  switch (op.action) {
    case 'add':
      return isObj(v) && (v.type === 'person' || v.type === 'organisation')
        && isStr(v.displayName, CAP_NAME) && isTier(v.tier)
        && (v.roles === undefined || isRoles(v.roles))
        && (v.lifecycle === undefined || isLifecycleValue(v.lifecycle))
        && isOptHex(v.ownerIdentityPubkey, HEX64)
        && (v.appIntroduction === undefined || validIntroduction(v.appIntroduction));
    case 'app-propose-list':
      return validIntroduction(v);
    case 'receive-share':
      return validSharedContext(v);
    case 'record-share':
      return isObj(v) && typeof v.directoryId === 'string' && DIRECTORY_ID.test(v.directoryId) && isHex(v.contactId, HEX32);
    case 'review-app-list':
      return isObj(v) && isHex(v.grantId, HEX32) && typeof v.accept === 'boolean';
    case 'link-list':
    case 'unlink-list':
      return isObj(v) && isHex(v.ownerIdentityPubkey, HEX64);
    case 'record-origin': return validContactOrigin(v);
    case 'remove-origin': return isObj(v) && isHex(v.id, HEX32);
    case 'record-check':
      return validContactCheck(v);
    case 'remove-check':
      return isObj(v) && isHex(v.id, HEX32);
    case 'rename':
      return isObj(v) && isStr(v.displayName, CAP_NAME);
    case 'set-tier':
      return isObj(v) && isTier(v.tier);
    case 'set-roles':
      return isObj(v) && isRoles(v.roles);
    case 'add-identity':
    case 'key-link':
      return isObj(v) && typeof v.itemId === 'string' && HEX32.test(v.itemId)
        && typeof v.pubkey === 'string' && HEX64.test(v.pubkey)
        && isOptStr(v.label, CAP_LABEL)
        && (op.action === 'key-link'
          ? typeof v.linkedFromItemId === 'string' && HEX32.test(v.linkedFromItemId)
          : isProvenance(v.provenance) && isVerification(v.verification)
            && (v.direct === undefined || isDirect(v.direct))
            && (v.linkedFromItemId === undefined || HEX32.test(String(v.linkedFromItemId))));
    case 'update-identity':
    case 'evidence':
      return isObj(v) && typeof v.itemId === 'string' && HEX32.test(v.itemId)
        && isOptStr(v.label, CAP_LABEL)
        && (v.verification === undefined || isVerification(v.verification))
        && (v.direct === undefined || isDirect(v.direct));
    case 'add-method':
      return isObj(v) && typeof v.itemId === 'string' && HEX32.test(v.itemId)
        && isMethodKind(v.kind) && isStr(v.value, CAP_METHOD_VALUE)
        && isOptStr(v.label, CAP_LABEL)
        && isMethodVerification(v.verification) && isSharing(v.sharingPolicy);
    case 'update-method':
      return isObj(v) && typeof v.itemId === 'string' && HEX32.test(v.itemId)
        && isOptStr(v.label, CAP_LABEL)
        && (v.value === undefined || isStr(v.value, CAP_METHOD_VALUE))
        && (v.verification === undefined || isMethodVerification(v.verification))
        && (v.sharingPolicy === undefined || isSharing(v.sharingPolicy));
    case 'remove-item':
      return isObj(v) && typeof v.itemId === 'string' && HEX32.test(v.itemId);
    case 'vouch':
      return isObj(v) && typeof v.guardianPubkey === 'string' && HEX64.test(v.guardianPubkey)
        && isTier(v.tier) && isOptStr(v.role, CAP_ROLE);
    case 'revoke-vouch':
      return isObj(v) && typeof op.targetOperationId === 'string' && HEX32.test(op.targetOperationId);
    case 'ceiling':
      return isObj(v) && typeof v.guardianPubkey === 'string' && HEX64.test(v.guardianPubkey)
        && isCeilingTier(v.maxTier);
    case 'revoke-ceiling':
      return isObj(v) && typeof v.guardianPubkey === 'string' && HEX64.test(v.guardianPubkey);
    case 'block':
      return isObj(v) && isScope(v.scope) && isOptStr(v.reason, CAP_REASON);
    case 'unblock':
      return isObj(v) && typeof op.targetOperationId === 'string' && HEX32.test(op.targetOperationId);
    case 'set-lifecycle':
      return isObj(v) && isLifecycleValue(v.lifecycle);
    case 'note':
      return isObj(v) && typeof v.note === 'string' && v.note.length <= CAP_NOTE;
    case 'remove':
    case 'archive':
      return isObj(v);
    default:
      return false;
  }
}

/** Full structural guard. An operation that fails this is never applied. */
export function validateOperation(op: unknown): op is ContactOperation {
  if (!isObj(op)) return false;
  if (!isOptHex(op.ownerIdentityPubkey, HEX64)) return false;
  if (typeof op.operationId !== 'string' || !HEX32.test(op.operationId)) return false;
  if (typeof op.directoryId !== 'string' || !DIRECTORY_ID.test(op.directoryId)) return false;
  if (typeof op.contactId !== 'string' || !HEX32.test(op.contactId)) return false;
  if (op.itemId !== undefined && (typeof op.itemId !== 'string' || !HEX32.test(op.itemId))) return false;
  if (typeof op.actorPubkey !== 'string' || !HEX64.test(op.actorPubkey)) return false;
  if (op.actorRole !== 'owner' && op.actorRole !== 'guardian' && op.actorRole !== 'dependant' && op.actorRole !== 'app') return false;
  if (typeof op.actorDeviceId !== 'string' || !HEX32.test(op.actorDeviceId)) return false;
  if (typeof op.logicalClock !== 'number' || !Number.isInteger(op.logicalClock) || op.logicalClock < 1) return false;
  if (typeof op.createdAt !== 'number' || !Number.isFinite(op.createdAt) || op.createdAt < 0) return false;
  if (op.targetOperationId !== undefined && (typeof op.targetOperationId !== 'string' || !HEX32.test(op.targetOperationId))) return false;
  if (typeof op.action !== 'string' || !ACTIONS.includes(op.action as ContactAction)) return false;
  // Opus review gap: an app actor may only ADD material it is proposing,
  // never anything with review/authority semantics, and never a rename of the
  // owner's own record — see APP_ALLOWED_ACTIONS above.
  if (op.actorRole === 'app' && !APP_ALLOWED_ACTIONS.has(op.action as ContactAction)) return false;
  if (op.actorRole === 'app' && op.action === 'add'
    && isObj(op.value) && op.value.ownerIdentityPubkey !== undefined) return false;
  // R-15: a block's author is the operation's actor. The reducer already
  // DERIVES `blockedBy` from `actorPubkey`, so a disagreeing field is ignored
  // today — but §7.10 gives only the blocking authority the power to lift a
  // block, and an ignored claim about who blocked someone is exactly the sort
  // of thing a later reader trusts by accident.
  if ((op.action === 'record-check' || op.action === 'record-origin') && (!isObj(op.value) || op.ownerIdentityPubkey !== op.value.ownerIdentityPubkey)) return false;
  if (op.action === 'block') {
    const blockValue = op.value as Record<string, unknown> | null;
    const claimed = blockValue?.blockedBy;
    if (claimed !== undefined && claimed !== op.actorPubkey) return false;
  }
  return validateValue({
    action: op.action as ContactAction,
    value: op.value,
    targetOperationId: op.targetOperationId as string | undefined,
  });
}

function isActorRole(v: unknown): boolean {
  return v === 'owner' || v === 'guardian' || v === 'dependant' || v === 'app';
}
function isRecordLifecycle(v: unknown): boolean {
  return v === 'suggested' || v === 'pending' || v === 'active' || v === 'rejected' || v === 'removed';
}
function isHex(v: unknown, re: RegExp): boolean {
  return typeof v === 'string' && re.test(v);
}
function isOptHex(v: unknown, re: RegExp): boolean {
  return v === undefined || isHex(v, re);
}
function isFinite_(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}
function everyElement(v: unknown, guard: (el: Record<string, unknown>) => boolean): boolean {
  return Array.isArray(v) && v.every(el => isObj(el) && guard(el));
}

/**
 * Element guards for the fact arrays. `Array.isArray` alone is not enough:
 * `contacts-v2-effective.ts` dereferences `v.guardianPubkey`, `c.maxTier` and
 * `b.blockedBy` without checking, so a `[null]` that passed the old guard
 * threw inside the resolver and took the whole directory offline — exactly
 * what dropping the row was meant to prevent.
 */
function isVouchFact(v: Record<string, unknown>): boolean {
  return isHex(v.guardianPubkey, HEX64) && isHex(v.operationId, HEX32)
    && isTier(v.tier) && isFinite_(v.createdAt)
    && isOptStr(v.role, CAP_ROLE)
    && isOptHex(v.revokedByOperationId, HEX32);
}
function isCeilingFact(v: Record<string, unknown>): boolean {
  return isHex(v.guardianPubkey, HEX64) && isHex(v.operationId, HEX32)
    && isCeilingTier(v.maxTier) && isFinite_(v.createdAt)
    && isOptHex(v.revokedByOperationId, HEX32);
}
function isBlockFact(v: Record<string, unknown>): boolean {
  return isHex(v.blockedBy, HEX64) && isHex(v.operationId, HEX32)
    && isScope(v.scope) && isFinite_(v.blockedAt)
    && isOptStr(v.reason, CAP_REASON)
    && isOptHex(v.liftedByOperationId, HEX32);
}
function isIdentityItem(v: Record<string, unknown>): boolean {
  return isHex(v.itemId, HEX32) && isHex(v.pubkey, HEX64)
    && isProvenance(v.provenance) && isVerification(v.verification)
    && isFinite_(v.addedAt);
}
function isMethodItem(v: Record<string, unknown>): boolean {
  return isHex(v.itemId, HEX32) && isMethodKind(v.kind)
    && typeof v.value === 'string' && v.value.length <= CAP_METHOD_VALUE
    && isMethodVerification(v.verification) && isSharing(v.sharingPolicy)
    && isFinite_(v.addedAt);
}

/**
 * Full structural guard for a materialised record read back off storage. A
 * decrypted-but-partial or shape-mismatched row must never reach a consumer
 * (`contacts-v2-effective.ts` dereferences `vouches`/`ceilings`/`blocks`
 * directly) — a row that fails this is dropped by the caller, never thrown.
 */
export function validateRecord(raw: unknown): raw is ContactRecord {
  if (!isObj(raw)) return false;
  if (!validContactLists(raw)) return false;
  if (raw.origins !== undefined && (!Array.isArray(raw.origins) || raw.origins.length > 64 || !raw.origins.every(validContactOrigin))) return false;
  if (raw.checks !== undefined && (!Array.isArray(raw.checks) || raw.checks.length > 128 || !raw.checks.every(validContactCheck))) return false;
  if (raw.mergedContactIds !== undefined && (!Array.isArray(raw.mergedContactIds) || !raw.mergedContactIds.every(id => isHex(id, HEX32)))) return false;
  if (raw.sharedContexts !== undefined && !everyElement(raw.sharedContexts, v => validSharedContext(v) && isFinite_(v.receivedAt))) return false;
  if (raw.sharesSent !== undefined && !everyElement(raw.sharesSent, v => typeof v.directoryId === 'string' && DIRECTORY_ID.test(v.directoryId)
    && isHex(v.contactId, HEX32) && isFinite_(v.sharedAt))) return false;
  if (raw.appIntroductions !== undefined && (!everyElement(raw.appIntroductions, v => validIntroduction(v)
    && ['pending', 'accepted', 'rejected'].includes(String(v.status)) && typeof v.restricted === 'boolean'
    && typeof v.logicalClock === 'number' && Number.isInteger(v.logicalClock) && v.logicalClock > 0
    && typeof v.createdAt === 'number' && Number.isFinite(v.createdAt) && v.createdAt >= 0)
    || new Set((raw.appIntroductions as { grantId: string }[]).map(i => i.grantId)).size !== (raw.appIntroductions as unknown[]).length)) return false;
  if (!isStr(raw.directoryId, 120)) return false;
  if (typeof raw.contactId !== 'string' || !HEX32.test(raw.contactId)) return false;
  if (raw.type !== 'person' && raw.type !== 'organisation') return false;
  // Not `isStr`: sanitizeDisplayName can legitimately reduce an all-control-
  // char input to '', so an empty (but capped) string is a valid record here.
  if (typeof raw.displayName !== 'string' || raw.displayName.length > CAP_NAME) return false;
  if (!isTier(raw.tier)) return false;
  if (raw.tierSetByActorRole !== undefined && !isActorRole(raw.tierSetByActorRole)) return false;
  if (!isRoles(raw.roles)) return false;
  if (!everyElement(raw.identities, isIdentityItem)) return false;
  if (!everyElement(raw.contactMethods, isMethodItem)) return false;
  if (!everyElement(raw.accessGrants, () => true)) return false;
  if (!isRecordLifecycle(raw.lifecycle)) return false;
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) return false;
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return false;
  if (raw.removedAt !== undefined && (typeof raw.removedAt !== 'number' || !Number.isFinite(raw.removedAt))) return false;
  if (raw.archived !== undefined && typeof raw.archived !== 'boolean') return false;
  if (!isActorRole(raw.createdByActorRole)) return false;
  if (typeof raw.createdByOperationId !== 'string' || !HEX32.test(raw.createdByOperationId)) return false;
  if (!everyElement(raw.vouches, isVouchFact)) return false;
  if (!everyElement(raw.ceilings, isCeilingFact)) return false;
  if (!everyElement(raw.blocks, isBlockFact)) return false;
  if (raw.notes !== undefined && (typeof raw.notes !== 'string' || raw.notes.length > CAP_NOTE)) return false;
  return true;
}

/** Deterministic total order: clock, then actor pubkey, then operation id. */
export function sortOperations(ops: ContactOperation[]): ContactOperation[] {
  return [...ops].sort((a, b) => {
    if (a.logicalClock !== b.logicalClock) return a.logicalClock - b.logicalClock;
    if (a.actorPubkey !== b.actorPubkey) return a.actorPubkey < b.actorPubkey ? -1 : 1;
    if (a.operationId !== b.operationId) return a.operationId < b.operationId ? -1 : 1;
    return 0;
  });
}

function applyAdd(record: ContactRecord | undefined, op: ContactOperation): ContactRecord {
  const v = op.value as AddContactValue;
  const displayName = clean(v.displayName, CAP_NAME);
  const cleanRoles = (roles: string[] | undefined): string[] => {
    if (!roles) return [];
    const cleaned = roles.map(r => clean(r, CAP_ROLE)).filter(r => r.length > 0);
    // Dedupe while preserving first-occurrence order
    return [...new Set(cleaned)];
  };
  if (record && record.lifecycle !== 'removed') {
    // Idempotent re-add of a live record: refresh the scalars, keep every fact.
    return {
      ...record,
      type: v.type,
      displayName,
      tier: v.tier,
      ...(record.createdByActorRole === 'app' && op.actorRole !== 'app' ? { tierSetByActorRole: op.actorRole } : {}),
      roles: v.roles ? cleanRoles(v.roles) : record.roles,
      lifecycle: v.lifecycle ?? record.lifecycle,
      updatedAt: op.createdAt,
    };
  }
  return {
    directoryId: op.directoryId,
    contactId: op.contactId,
    type: v.type,
    displayName,
    tier: v.tier,
    ...(record?.createdByActorRole === 'app' && op.actorRole !== 'app' ? { tierSetByActorRole: op.actorRole } : {}),
    roles: cleanRoles(v.roles),
    identities: record?.identities ?? [],
    contactMethods: record?.contactMethods ?? [],
    accessGrants: record?.accessGrants ?? [],
    lifecycle: v.lifecycle ?? 'active',
    createdAt: record?.createdAt ?? op.createdAt,
    updatedAt: op.createdAt,
    removedAt: undefined,
    archived: undefined,
    // A revival keeps the ORIGINAL creator: the default child ceiling follows
    // who first put this person in the directory, not who restored the row.
    createdByActorRole: record?.createdByActorRole ?? op.actorRole,
    createdByOperationId: record?.createdByOperationId ?? op.operationId,
    vouches: record?.vouches ?? [],
    ceilings: record?.ceilings ?? [],
    blocks: record?.blocks ?? [],
    notes: record?.notes,
    ...(record?.origins ? { origins: record.origins } : {}),
    ...(record?.checks ? { checks: record.checks } : {}),
    sharedContexts: record?.sharedContexts,
    sharesSent: record?.sharesSent,
    ...(record?.appIntroductions ? { appIntroductions: record.appIntroductions } : {}),
    ...(record?.listMemberships ? { listMemberships: record.listMemberships, primaryIdentityPubkey: record.primaryIdentityPubkey } : {}),
  };
}

function applyOne(record: ContactRecord | undefined, op: ContactOperation): ContactRecord | null {
  if (op.action === 'add') {
    let next = applyAdd(record, op);
    const intro = (op.value as AddContactValue).appIntroduction;
    if (intro && !record && op.actorRole === 'app') {
      next = linkContactList(next, intro.ownerIdentityPubkey, op.createdAt);
      next.appIntroductions = [{ ...intro, status: 'accepted', restricted: true, logicalClock: op.logicalClock, createdAt: op.createdAt }];
    }
    const owner = (op.value as AddContactValue).ownerIdentityPubkey;
    return owner ? linkContactList(next, owner, op.createdAt) : next;
  }
  if (!record) return null;                       // no add yet — nothing to mutate
  // Only a later add revives a tombstone. Removal may harden an archive,
  // and block/unblock still update safety state without reviving the record.
  const hardeningAnArchive = op.action === 'remove' && record.archived === true;
  const safetyAction = op.action === 'block' || op.action === 'unblock';
  if (record.lifecycle === 'removed' && !hardeningAnArchive && !safetyAction) return null;

  const touched = { ...record, updatedAt: op.createdAt };
  switch (op.action) {
    case 'receive-share': {
      const v = op.value as Omit<SharedContactContext, 'receivedAt'>;
      if (v.guardianPubkey !== op.actorPubkey) return record;
      return { ...touched, sharedContexts: [...(record.sharedContexts ?? []), { ...v, receivedAt: op.createdAt }] };
    }
    case 'record-share': {
      const v = op.value as { directoryId: string; contactId: string };
      return { ...touched, sharesSent: [...(record.sharesSent ?? []), { ...v, sharedAt: op.createdAt }] };
    }
    case 'app-propose-list': {
      const intro = op.value as AppContactIntroductionValue;
      if (record.appIntroductions?.some(i => i.grantId === intro.grantId)) return record;
      const inList = record.listMemberships?.some(m => m.ownerIdentityPubkey === intro.ownerIdentityPubkey && m.removedAt === undefined);
      return { ...touched, appIntroductions: [...(record.appIntroductions ?? []), {
        ...intro, status: inList ? 'accepted' : 'pending', restricted: !inList || !!record.appIntroductions?.some(i => i.ownerIdentityPubkey === intro.ownerIdentityPubkey && i.restricted),
        logicalClock: op.logicalClock, createdAt: op.createdAt,
      }] };
    }
    case 'review-app-list': {
      const v = op.value as { grantId: string; accept: boolean };
      const intro = record.appIntroductions?.find(i => i.grantId === v.grantId && i.status === 'pending');
      if (!intro) return record;
      const next = v.accept ? linkContactList(touched, intro.ownerIdentityPubkey, op.createdAt) : touched;
      return { ...next, appIntroductions: record.appIntroductions!.map(i => i.grantId === v.grantId
        ? { ...i, status: v.accept ? 'accepted' : 'rejected' } : i) };
    }
    case 'link-list':
      return linkContactList(record, (op.value as ContactListValue).ownerIdentityPubkey, op.createdAt);
    case 'unlink-list':
      return unlinkContactList(record, (op.value as ContactListValue).ownerIdentityPubkey, op.createdAt);
    case 'rename':
      // An app may relabel what IT added, never the owner's own records —
      // ignored, not thrown, same as every other skip in this function.
      if (op.actorRole === 'app' && record.createdByActorRole !== 'app') return null;
      return { ...touched, displayName: clean((op.value as RenameValue).displayName, CAP_NAME) };
    case 'set-tier':
      return { ...touched, tier: (op.value as SetTierValue).tier, tierSetByActorRole: op.actorRole };
    case 'set-roles': {
      const roles = (op.value as SetRolesValue).roles.map(r => clean(r, CAP_ROLE)).filter(r => r.length > 0);
      // Dedupe while preserving first-occurrence order
      return { ...touched, roles: [...new Set(roles)] };
    }
    case 'set-lifecycle':
      return { ...touched, lifecycle: (op.value as SetLifecycleValue).lifecycle };
    case 'note':
      // sanitizeNote, not sanitizeDisplayName: a note is multi-line free text
      // the owner typed for themselves, and the display-name sanitiser strips
      // the \n and \t out of it.
      return { ...touched, notes: sanitizeNote((op.value as NoteValue).note, CAP_NOTE) };
    case 'remove':
      // A removal supersedes an archive: the snapshot is gone, so the record
      // must not keep reading as archived.
      return { ...removeContactLists(touched, op.createdAt), lifecycle: 'removed', removedAt: op.createdAt, archived: undefined };
    case 'archive':
      return { ...removeContactLists(touched, op.createdAt), lifecycle: 'removed', removedAt: op.createdAt, archived: true };
    case 'add-identity': {
      const v = op.value as AddIdentityValue;
      const existing = touched.identities.find(i => i.itemId === v.itemId || i.pubkey === v.pubkey);
      if (existing) {
        if (existing.pubkey !== v.pubkey || op.actorRole === 'app') return touched;
        const rank = { unverified: 0, proven: 1, mutual: 2 };
        return { ...touched, identities: touched.identities.map(i => i !== existing ? i : {
          ...i, verification: rank[v.verification] > rank[i.verification] ? v.verification : i.verification,
          ...(i.direct || v.direct ? { direct: i.direct ?? normaliseDirect(v.direct) } : {}),
        }) };
      }
      return {
        ...touched,
        identities: [...touched.identities, {
          itemId: v.itemId,
          pubkey: v.pubkey,
          label: v.label === undefined ? undefined : clean(v.label, CAP_LABEL),
          provenance: v.provenance,
          verification: v.verification,
          direct: normaliseDirect(v.direct),
          linkedFromItemId: v.linkedFromItemId,
          addedAt: op.createdAt,
        }],
      };
    }
    case 'key-link': {
      const v = op.value as KeyLinkValue;
      if (touched.identities.some(i => i.itemId === v.itemId)) return touched;
      // Key continuity follows PROOF: a key-link is only ever authored after a
      // signed rotation proof, so the new item starts `proven` and names the
      // item it replaced. Names and profile similarity never reach here.
      return {
        ...touched,
        identities: [...touched.identities, {
          itemId: v.itemId,
          pubkey: v.pubkey,
          provenance: 'key-link',
          verification: 'proven',
          linkedFromItemId: v.linkedFromItemId,
          addedAt: op.createdAt,
        }],
      };
    }
    case 'record-origin': {
      const origin = normaliseContactOrigin(op.value as ContactOrigin), origins = touched.origins ?? [];
      if (origins.length >= 64 && !origins.some(row => row.id === origin.id)) return touched;
      return { ...touched, origins: [...origins.filter(row => row.id !== origin.id), origin] };
    }
    case 'remove-origin': return { ...touched, origins: (touched.origins ?? []).filter(row => row.id !== (op.value as { id: string }).id) };
    case 'record-check': {
      const check = normaliseContactCheck(op.value as ContactCheck);
      if (!touched.identities.some(identity => identity.pubkey === check.identityPubkey)) return touched;
      const checks = touched.checks ?? [];
      if (checks.length >= 128 && !checks.some(c => c.id === check.id)) return touched;
      return { ...touched, checks: [...checks.filter(c => c.id !== check.id), check] };
    }
    case 'remove-check': {
      const id = (op.value as { id: string }).id;
      return { ...touched, checks: (touched.checks ?? []).filter(c => c.id !== id) };
    }
    case 'update-identity':
    case 'evidence': {
      const v = op.value as UpdateIdentityValue;
      if (!touched.identities.some(i => i.itemId === v.itemId)) return null;
      return {
        ...touched,
        identities: touched.identities.map(i => i.itemId !== v.itemId ? i : {
          ...i,
          label: v.label === undefined ? i.label : clean(v.label, CAP_LABEL),
          verification: v.verification ?? i.verification,
          direct: normaliseDirect(v.direct) ?? i.direct,
        }),
      };
    }
    case 'add-method': {
      const v = op.value as AddMethodValue;
      if (touched.contactMethods.some(m => m.itemId === v.itemId)) return touched;
      return {
        ...touched,
        contactMethods: [...touched.contactMethods, {
          itemId: v.itemId,
          kind: v.kind,
          label: v.label === undefined ? undefined : clean(v.label, CAP_LABEL),
          value: clean(v.value, CAP_METHOD_VALUE),
          verification: v.verification,
          sharingPolicy: v.sharingPolicy,
          addedAt: op.createdAt,
        }],
      };
    }
    case 'update-method': {
      const v = op.value as UpdateMethodValue;
      if (!touched.contactMethods.some(m => m.itemId === v.itemId)) return null;
      return {
        ...touched,
        contactMethods: touched.contactMethods.map(m => m.itemId !== v.itemId ? m : {
          ...m,
          label: v.label === undefined ? m.label : clean(v.label, CAP_LABEL),
          value: v.value === undefined ? m.value : clean(v.value, CAP_METHOD_VALUE),
          verification: v.verification ?? m.verification,
          sharingPolicy: v.sharingPolicy ?? m.sharingPolicy,
        }),
      };
    }
    case 'remove-item': {
      const v = op.value as RemoveItemValue;
      const identities = touched.identities.filter(i => i.itemId !== v.itemId);
      const contactMethods = touched.contactMethods.filter(m => m.itemId !== v.itemId);
      // Nothing matched: return the record UNTOUCHED. Bumping `updatedAt` for
      // a no-op would reorder the directory (rows sort by `updatedAt`) and
      // claim an edit that never happened.
      if (identities.length === touched.identities.length
        && contactMethods.length === touched.contactMethods.length) return record;
      return { ...touched, identities, contactMethods };
    }
    case 'vouch': {
      const v = op.value as VouchValue;
      if (v.guardianPubkey !== op.actorPubkey) return null; // each guardian vouches as themselves
      return {
        ...touched,
        // A guardian's newer vouch supersedes their own previous one; other
        // guardians' vouches are untouched (§7.10 joint guardianship).
        vouches: [
          ...touched.vouches.map(existing =>
            existing.guardianPubkey === v.guardianPubkey && !existing.revokedByOperationId
              ? { ...existing, revokedByOperationId: op.operationId }
              : existing),
          {
            vouchId: op.operationId,
            guardianPubkey: v.guardianPubkey,
            tier: v.tier,
            role: v.role,
            createdAt: op.createdAt,
            operationId: op.operationId,
          },
        ],
      };
    }
    case 'revoke-vouch': {
      const target = op.targetOperationId;
      const match = touched.vouches.find(v => v.operationId === target);
      // Only the guardian who made a vouch may revoke it.
      if (!match || match.revokedByOperationId || match.guardianPubkey !== op.actorPubkey) return null;
      return {
        ...touched,
        vouches: touched.vouches.map(v => v.operationId === target ? { ...v, revokedByOperationId: op.operationId } : v),
      };
    }
    case 'ceiling': {
      const v = op.value as CeilingValue;
      if (v.guardianPubkey !== op.actorPubkey) return null;
      return {
        ...touched,
        ceilings: [
          ...touched.ceilings.map(existing =>
            existing.guardianPubkey === v.guardianPubkey && !existing.revokedByOperationId
              ? { ...existing, revokedByOperationId: op.operationId }
              : existing),
          {
            guardianPubkey: v.guardianPubkey,
            maxTier: v.maxTier,
            createdAt: op.createdAt,
            operationId: op.operationId,
          },
        ],
      };
    }
    case 'revoke-ceiling': {
      const v = op.value as RevokeCeilingValue;
      if (v.guardianPubkey !== op.actorPubkey) return null;
      if (!touched.ceilings.some(c => c.guardianPubkey === v.guardianPubkey && !c.revokedByOperationId)) return null;
      return {
        ...touched,
        ceilings: touched.ceilings.map(c =>
          c.guardianPubkey === v.guardianPubkey && !c.revokedByOperationId
            ? { ...c, revokedByOperationId: op.operationId }
            : c),
      };
    }
    case 'block': {
      const v = op.value as BlockValue;
      const cleanedReason = v.reason === undefined ? undefined : clean(v.reason, CAP_REASON);
      const blockFact: Record<string, unknown> = {
        blockedBy: op.actorPubkey,
        scope: v.scope,
        blockedAt: op.createdAt,
        operationId: op.operationId,
      };
      // Only include reason if it's not empty after cleaning
      if (cleanedReason && cleanedReason.length > 0) {
        blockFact.reason = cleanedReason;
      }
      return {
        ...touched,
        blocks: [...touched.blocks, blockFact as any],
      };
    }
    case 'unblock': {
      const target = op.targetOperationId;
      const match = touched.blocks.find(b => b.operationId === target);
      // One guardian cannot clear another guardian's Block (§7.10).
      if (!match || match.liftedByOperationId || match.blockedBy !== op.actorPubkey) return null;
      return {
        ...touched,
        blocks: touched.blocks.map(b => b.operationId === target ? { ...b, liftedByOperationId: op.operationId } : b),
      };
    }
    default:
      return null; // item and fact actions land in Task 5
  }
}

/** Replay duplicate npub records as one group. Once a key established an
 * alias it stays stable, so removing that key cannot resurrect the old id.
 * Names and methods never establish aliases. */
export function applyOperations(ops: ContactOperation[]): Map<string, ContactRecord> {
  const sorted = sortOperations(ops.filter(validateOperation));
  const raw = new Map<string, ContactRecord>();
  const firstAdds = new Map<string, ContactOperation>();
  const identityHistory = new Map<string, Set<string>>();
  for (const op of sorted) {
    const key = recordKey(op.directoryId, op.contactId);
    if (op.action === 'add' && !firstAdds.has(key)) firstAdds.set(key, op);
    const next = applyOne(raw.get(key), op);
    if (next) {
      raw.set(key, next);
      if (op.action === 'add-identity' || op.action === 'key-link') {
        const pubkey = (op.value as AddIdentityValue).pubkey;
        if (next.identities.some(i => i.pubkey === pubkey)) {
          const history = identityHistory.get(key) ?? new Set<string>();
          history.add(pubkey); identityHistory.set(key, history);
        }
      }
    }
  }
  const parent = new Map<string, string>();
  const root = (key: string): string => {
    const p = parent.get(key);
    if (!p || p === key) return key;
    const r = root(p); parent.set(key, r); return r;
  };
  const keys = new Map<string, string>();
  for (const [key, record] of raw) {
    for (const identity of identityHistory.get(key) ?? []) {
      const pubkey = `${record.directoryId}/${identity}`;
      const other = keys.get(pubkey);
      if (other) parent.set(root(key), root(other));
      else keys.set(pubkey, key);
    }
  }
  const groups = new Map<string, string[]>();
  for (const key of raw.keys()) {
    const r = root(key);
    const group = groups.get(r);
    if (group) group.push(key); else groups.set(r, [key]);
  }
  if (![...groups.values()].some(group => group.length > 1)) return raw;

  // Map iteration follows first-add replay order. The first id is canonical,
  // and old ids remain usable by later mutations through the same mapping.
  const aliases = new Map<string, string>();
  const grouped = new Map<string, string[]>();
  for (const group of groups.values()) {
    for (const key of group) aliases.set(key, group[0]);
    grouped.set(group[0], group);
  }
  const itemAliases = new Map<string, string>();
  const itemForPubkey = new Map<string, string>();
  for (const op of sorted) {
    if (op.action !== 'add-identity' && op.action !== 'key-link') continue;
    const source = recordKey(op.directoryId, op.contactId);
    const key = aliases.get(source) ?? source;
    const value = op.value as AddIdentityValue;
    const pubkey = `${key}/${value.pubkey}`;
    const item = itemForPubkey.get(pubkey) ?? value.itemId;
    itemForPubkey.set(pubkey, item);
    itemAliases.set(`${source}/${value.itemId}`, item);
  }
  const out = new Map<string, ContactRecord>();
  for (const operation of sorted) {
    const sourceKey = recordKey(operation.directoryId, operation.contactId);
    const key = aliases.get(sourceKey) ?? sourceKey;
    const canonicalId = key.slice(key.indexOf('/') + 1);
    const remapItem = (id: string) => itemAliases.get(`${sourceKey}/${id}`) ?? id;
    const value = operation.value as Record<string, unknown>;
    const op = { ...operation, contactId: canonicalId,
      ...(operation.itemId ? { itemId: remapItem(operation.itemId) } : {}),
      value: { ...value,
        ...(typeof value.itemId === 'string' ? { itemId: remapItem(value.itemId) } : {}),
        ...(typeof value.linkedFromItemId === 'string' ? { linkedFromItemId: remapItem(value.linkedFromItemId) } : {}),
        ...(operation.action === 'block' && (value.scope as BlockValue['scope']).kind === 'identity'
          ? { scope: { kind: 'identity', itemId: remapItem((value.scope as { itemId: string }).itemId) } } : {}),
      },
    };
    const group = grouped.get(key) ?? [key];
    let record = out.get(key);
    const first = firstAdds.get(sourceKey) === operation;
    if (first && key !== sourceKey && record) {
      const value = operation.value as AddContactValue;
      // Initial adds on duplicate ids are not explicit restorations and must
      // never revive a tombstone. Apps can only request a reviewed link.
      if (record.lifecycle === 'removed') continue;
      if (value.appIntroduction) {
        record = applyOne(record, { ...op, action: 'app-propose-list', value: value.appIntroduction }) ?? record;
      } else if (op.actorRole !== 'app') {
        if (value.ownerIdentityPubkey) record = linkContactList(record, value.ownerIdentityPubkey, op.createdAt);
        const rank = { ken: 1, kith: 2, kin: 3 };
        record = { ...record, tier: rank[value.tier] > rank[record.tier] ? value.tier : record.tier,
          ...(rank[value.tier] >= rank[record.tier] ? { tierSetByActorRole: op.actorRole } : {}),
          createdAt: Math.min(record.createdAt, op.createdAt) };
      }
      out.set(key, record);
      continue;
    }
    let next = applyOne(record, op);
    // An offline app believed this key was new. Once another record is
    // discovered in a different list, its membership needs owner review too.
    const intro = first && op.action === 'add' ? (operation.value as AddContactValue).appIntroduction : undefined;
    if (next && intro && group.some(other => {
      if (other === sourceKey) return false;
      const otherAdd = firstAdds.get(other);
      const value = otherAdd?.value as AddContactValue | undefined;
      const owner = value?.ownerIdentityPubkey ?? value?.appIntroduction?.ownerIdentityPubkey;
      return owner !== intro.ownerIdentityPubkey;
    })) {
      next = { ...next, primaryIdentityPubkey: undefined, listMemberships: [],
        appIntroductions: next.appIntroductions?.map(i => i.grantId === intro.grantId ? { ...i, status: 'pending' } : i) };
    }
    if (next) out.set(key, next);
  }
  for (const [key, record] of out) {
    const group = grouped.get(key);
    if (group && group.length > 1) out.set(key, { ...record,
      mergedContactIds: group.slice(1).map(k => k.slice(k.indexOf('/') + 1)),
    });
  }
  return out;
}
