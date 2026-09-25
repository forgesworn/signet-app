import { applyOperations } from './contacts-v2-reducer';
import { frontierOf } from './contacts-v2-clock';
import { contactsMutationQueue } from './contacts-v2-queue';
/**
 * Legacy `contacts` / `ken` → contacts v2 import (§8.2 "Local storage lift").
 *
 * Both legacy stores key by the OTHER person's pubkey, so the same person held
 * by two owners collided there and cannot be recovered; this import never
 * invents a second owner to paper over that. What it does do:
 *
 *   - route by `ownerPubkey`, matched case-insensitively: an owner slot ⇒
 *     `owner`, a dependant slot ⇒ that dependant's directory, anything else
 *     ⇒ `quarantine` (never a child). A row whose OWN `pubkey` is not 64-hex
 *     is quarantined too: its `add-identity` could never satisfy the
 *     reducer's `HEX64` guard, so emitting it would file a contact with no
 *     identity on it rather than leaving the row for a later, better-informed
 *     run;
 *   - MERGE a legacy `contact` row and a `ken` row for the same
 *     `(directoryId, pubkey)` (grouped by lowercased pubkey) into ONE
 *     record — a person cannot be both a real contact and a one-way
 *     recognition at once. The contact row is the trust-bearing source
 *     whenever both exist: tier, roles, display name and evidence all come
 *     from it; the ken row contributes NOTHING to tier or evidence (a ken
 *     never upgrades to kin/kith, and it never downgrades an existing
 *     contact either), but its `sourceKey` is still recorded on the merged
 *     `ImportEntry` so a re-run recognises it as consumed too. A ken-only
 *     group behaves exactly as a standalone ken import;
 *   - a contact WITH a `relationship` ⇒ direct Kin with the relationship kept
 *     as a role; without ⇒ Kith — matching `contactToKindredEntry`;
 *   - a ken-only row ⇒ Ken, `legacy-import` provenance, `unverified`;
 *   - preserve the shared secret, verification time, group and label on the
 *     identity's direct evidence. A row with no shared secret gets NO direct
 *     evidence and stays `unverified`: the import never manufactures proof.
 *
 * Every id is domain-separated deterministic, so a re-run produces
 * byte-identical operations and the `sourceKey` markers make it a no-op.
 * Original add/identity operations retain clocks 1 and 2 and immutable payloads.
 * List membership is appended under new operation ids at clocks 3 and above — below every locally
 * authored operation, which is correct: a legacy row is the oldest fact this
 * device holds about that contact.
 *
 * `actorRole` on every produced operation follows WHERE it lands, not who
 * runs the import: `'owner'` for the owner's own directory and for
 * quarantine (nobody has been vouched for by a guardian there), `'guardian'`
 * for a dependant's directory (the owner is acting in a guardian capacity
 * over the child's contacts).
 *
 * Pure: `buildImportOps` touches no storage and no clock.
 */

import type { KenEntry } from '@forgesworn/kenspeckle';
import {
  OWNER_DIRECTORY_ID,
  QUARANTINE_DIRECTORY_ID,
  type AddContactValue,
  type AddIdentityValue,
  type Contact,
  type ContactActorRole,
  type ContactOperation,
} from '../types';
import {
  importContactId,
  importOperationId,
  importSourceKey,
  type LegacyRecordClass,
} from './contacts-v2-ids';
import { sanitizeDisplayName } from './text-sanitize';

const CAP_NAME = 100;
const IMPORT_ADD_CLOCK = 1;
const IMPORT_ITEM_CLOCK = 2;
const HEX64 = /^[0-9a-f]{64}$/;
/** What the reducer will accept as a shared secret (`isDirect`): hex, ≤ 128 chars. */
const LEGACY_SECRET = /^[0-9a-f]{1,128}$/i;

/** One dependant's directory plus every slot pubkey that can own a legacy row for it. */
export interface ImportDependantRef {
  directoryId: string;
  slotPubkeys: string[];
}

export interface ImportInput {
  contacts: Contact[];
  kens: KenEntry[];
  /** Owner NP / persona / extra / professional pubkeys. */
  ownerPubkeys: string[];
  dependants: ImportDependantRef[];
  deviceId: string;
  /** The owner identity authoring the import. */
  actorPubkey: string;
  /** Fallback timestamp for a legacy row with no usable one. */
  now: number;
}

export interface ImportEntry {
  /** Every legacy row folded into this one record — one, or a merged contact+ken pair. */
  sourceKeys: string[];
  directoryId: string;
  contactId: string;
  quarantined: boolean;
  ops: ContactOperation[];
}

export interface ImportPlan {
  entries: ImportEntry[];
}

interface LegacyRow {
  cls: LegacyRecordClass;
  pubkey: string;
  ownerPubkey: string;
  sourceKey: string;
  contact?: Contact;
  ken?: KenEntry;
}

interface RowGroup {
  directoryId: string;
  quarantined: boolean;
  /** Lowercased — the canonical pubkey used for every id derived from this group. */
  pubkey: string;
  rows: LegacyRow[];
}

function resolveDirectory(ownerPubkey: string, input: ImportInput): { directoryId: string; quarantined: boolean } {
  const lowered = ownerPubkey.toLowerCase();
  if (input.ownerPubkeys.some(p => p.toLowerCase() === lowered)) {
    return { directoryId: OWNER_DIRECTORY_ID, quarantined: false };
  }
  for (const dep of input.dependants) {
    if (dep.slotPubkeys.some(p => p.toLowerCase() === lowered)) {
      return { directoryId: dep.directoryId, quarantined: false };
    }
  }
  return { directoryId: QUARANTINE_DIRECTORY_ID, quarantined: true };
}

/** A dependant directory is anything but the owner's own directory and quarantine. */
function actorRoleFor(directoryId: string): ContactActorRole {
  return directoryId === OWNER_DIRECTORY_ID || directoryId === QUARANTINE_DIRECTORY_ID ? 'owner' : 'guardian';
}

function baseOp(
  input: ImportInput,
  directoryId: string,
  contactId: string,
  cls: LegacyRecordClass,
  pubkey: string,
  fieldGroup: string,
  clock: number,
  createdAt: number,
): Omit<ContactOperation, 'action' | 'value'> {
  return {
    operationId: importOperationId(directoryId, cls, pubkey, fieldGroup),
    directoryId,
    contactId,
    actorPubkey: input.actorPubkey.toLowerCase(),
    actorRole: actorRoleFor(directoryId),
    actorDeviceId: input.deviceId,
    logicalClock: clock,
    createdAt,
  };
}

/** The contact row is the trust-bearing source whenever the group has one. */
function buildAddValue(
  contactRow: LegacyRow | undefined,
  kenRow: LegacyRow | undefined,
): { displayName: string; value: Omit<AddContactValue, 'displayName'> } {
  if (contactRow) {
    const c = contactRow.contact!;
    return {
      displayName: c.displayName,
      value: {
        type: 'person',
        tier: c.relationship ? 'kin' : 'kith',
        roles: c.relationship ? [c.relationship] : [],
        lifecycle: 'active',
      },
    };
  }
  const k = kenRow!.ken!;
  return {
    displayName: k.displayName ?? '',
    value: { type: 'person', tier: 'ken', roles: [], lifecycle: 'active' },
  };
}

/** The ken row never contributes tier or evidence — it only rides along as a consumed source. */
function buildIdentityValue(
  contactRow: LegacyRow | undefined,
  kenRow: LegacyRow | undefined,
  createdAt: number,
): Omit<AddIdentityValue, 'itemId' | 'pubkey'> {
  if (contactRow) {
    const c = contactRow.contact!;
    // A secret the reducer's `isDirect` would reject counts as NO secret: the
    // row still imports, `unverified` and without direct evidence, rather than
    // producing an `add-identity` that applyOperations silently drops. (The
    // real ECDH secret is 64 lowercase hex; this only bites on junk, or on a
    // row whose ciphertext would not decrypt — `getAllContacts` omits that.)
    const secret = typeof c.sharedSecret === 'string' && LEGACY_SECRET.test(c.sharedSecret)
      ? c.sharedSecret.toLowerCase()
      : '';
    const hasSecret = secret.length > 0;
    return {
      ...(c.label ? { label: c.label } : {}),
      provenance: 'legacy-import',
      verification: hasSecret ? 'mutual' : 'unverified',
      ...(hasSecret
        ? {
          direct: {
            ownerPubkey: c.ownerPubkey.toLowerCase(),
            sharedSecret: secret,
            verifiedAt: createdAt,
            ...(c.groupId ? { groupId: c.groupId } : {}),
            ...(c.isDefaultForGroup ? { isDefaultForGroup: true } : {}),
          },
        }
        : {}),
    };
  }
  const k = kenRow!.ken!;
  return {
    ...(k.annotations?.label ? { label: k.annotations.label } : {}),
    provenance: 'legacy-import',
    verification: 'unverified',
  };
}

function timestampOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function entryForGroup(input: ImportInput, group: RowGroup): ImportEntry {
  const contactRow = group.rows.find(r => r.cls === 'contact');
  const kenRow = group.rows.find(r => r.cls === 'ken');
  // Determinism anchor for every id in this entry: the contact row when one
  // exists (it is the trust-bearing source), otherwise the ken row.
  const primaryCls: LegacyRecordClass = contactRow ? 'contact' : 'ken';

  const createdAt = contactRow
    ? timestampOf(contactRow.contact!.verifiedAt, input.now)
    : timestampOf(kenRow!.ken!.addedAt, input.now);

  // Membership follows the earliest known source, independently of which
  // source supplies the strongest tier and verification evidence.
  const memberships = group.rows.map(row => ({
    ownerIdentityPubkey: row.ownerPubkey.toLowerCase(),
    addedAt: Math.max(0, timestampOf(row.contact?.verifiedAt ?? row.ken?.addedAt, input.now)),
  })).sort((a, b) => a.addedAt - b.addedAt
    || (a.ownerIdentityPubkey < b.ownerIdentityPubkey ? -1 : a.ownerIdentityPubkey > b.ownerIdentityPubkey ? 1 : 0))
    .filter((m, index, all) => HEX64.test(m.ownerIdentityPubkey)
      && all.findIndex(other => other.ownerIdentityPubkey === m.ownerIdentityPubkey) === index);
  const contactId = importContactId(group.directoryId, group.pubkey);
  // The identity's item id is its own deterministic id, so a re-run addresses
  // the same child item rather than appending a duplicate.
  const itemId = importOperationId(group.directoryId, primaryCls, group.pubkey, 'identity-item');

  const built = buildAddValue(contactRow, kenRow);
  const identityValue = buildIdentityValue(contactRow, kenRow, createdAt);

  const addOp: ContactOperation = {
    ...baseOp(input, group.directoryId, contactId, primaryCls, group.pubkey, 'add', IMPORT_ADD_CLOCK, createdAt),
    action: 'add',
    value: { ...built.value, displayName: sanitizeDisplayName(built.displayName, CAP_NAME) || 'Unnamed' },
  };
  const identityOp: ContactOperation = {
    ...baseOp(input, group.directoryId, contactId, primaryCls, group.pubkey, 'identity', IMPORT_ITEM_CLOCK, createdAt),
    itemId,
    action: 'add-identity',
    value: { ...identityValue, itemId, pubkey: group.pubkey },
  };

  return {
    sourceKeys: group.rows.map(r => r.sourceKey),
    directoryId: group.directoryId,
    contactId,
    quarantined: group.quarantined,
    ops: [addOp, identityOp, ...memberships.map((membership, index): ContactOperation => ({
      ...baseOp(input, group.directoryId, contactId, primaryCls, group.pubkey,
        `list-v1:${membership.ownerIdentityPubkey}`, IMPORT_ITEM_CLOCK + 1 + index, membership.addedAt),
      action: 'link-list',
      value: { ownerIdentityPubkey: membership.ownerIdentityPubkey },
    }))],
  };
}

export function buildImportOps(input: ImportInput): ImportPlan {
  const rows: LegacyRow[] = [
    ...input.contacts.map((c): LegacyRow => ({
      cls: 'contact',
      pubkey: c.pubkey,
      ownerPubkey: c.ownerPubkey,
      sourceKey: importSourceKey('contact', c.pubkey),
      contact: c,
    })),
    ...input.kens.map((k): LegacyRow => ({
      cls: 'ken',
      pubkey: k.pubkey,
      ownerPubkey: k.ownerPubkey,
      sourceKey: importSourceKey('ken', k.pubkey),
      ken: k,
    })),
  ];

  // Group by (directoryId, lowercased pubkey) so a contact row and a ken row
  // for the same person land in one entry instead of colliding on the same
  // contactId as two separately-emitted `add`s.
  const groups = new Map<string, RowGroup>();
  const order: string[] = [];
  for (const row of rows) {
    const pubkey = row.pubkey.toLowerCase();
    // A row this device cannot even name a contact for goes to quarantine
    // unresolved (R-QUARANTINE), never out as an `add` whose `add-identity`
    // the reducer would silently drop for failing HEX64.
    const routed = HEX64.test(pubkey)
      ? resolveDirectory(row.ownerPubkey, input)
      : { directoryId: QUARANTINE_DIRECTORY_ID, quarantined: true };
    const { directoryId, quarantined } = routed;
    const groupKey = `${directoryId} ${pubkey}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { directoryId, quarantined, pubkey, rows: [] };
      groups.set(groupKey, group);
      order.push(groupKey);
    }
    group.rows.push(row);
  }

  const entries = order.map(key => entryForGroup(input, groups.get(key)!));
  return { entries };
}

export function importOps(plan: ImportPlan): ContactOperation[] {
  return plan.entries.flatMap(e => e.ops);
}

/** Storage seam, injected so the run stays testable without IndexedDB. */
export interface ImportIo {
  listImportedSources: () => Promise<string[]>;
  listExistingOps?: () => Promise<ContactOperation[]>;
  saveOps: (ops: ContactOperation[]) => Promise<void>;
  markSources: (sourceKeys: string[], importedAt: number) => Promise<void>;
}

export interface ImportRunResult {
  /** Entries whose operations were saved and whose sources were marked. */
  imported: number;
  /** Entries whose source keys were already marked by an earlier run. */
  skipped: number;
  /** Entries left UNRESOLVED this run — neither saved nor marked (R-QUARANTINE). */
  quarantined: number;
  operations: number;
}

/**
 * Import every legacy row not already marked, then mark it.
 *
 * Re-runnable by design: the old UI keeps writing to the legacy stores until
 * Phase C switches it over, so this runs once per unlock and picks up
 * whatever appeared since. Sources are marked only AFTER their operations are
 * saved — a crash in between re-imports the same row next unlock, which is
 * harmless because both the contact id and the operation ids are deterministic
 * and the write is an idempotent `put`.
 *
 * An entry's `sourceKeys` is a group (a merged legacy contact + ken row for
 * one person can list both keys). An entry is skipped when ANY of its source
 * keys is already marked — a partially-marked entry must not re-mint ops —
 * and once its ops are saved, EVERY key of the entry is marked, so a partial
 * mark from an earlier run is completed rather than left half-done.
 *
 * QUARANTINE IS "UNRESOLVED", NOT "FILED" (controller ruling R-QUARANTINE). A
 * quarantined entry is neither saved nor marked: it is counted in
 * `quarantined` and retried on every later run until its owner pubkey routes.
 * The alternative — filing it under `quarantine` and marking its source — is
 * permanent, because the marker makes the next run skip the row for good. The
 * roster it needed may simply not have loaded yet (C1), so a run that cannot
 * place a row must leave it exactly where it found it.
 */
export async function runContactsV2Import(input: ImportInput, io: ImportIo): Promise<ImportRunResult> {
  return contactsMutationQueue.run(() => runImport(input, io));
}
async function runImport(input: ImportInput, io: ImportIo): Promise<ImportRunResult> {
  const plan = buildImportOps(input);
  if (plan.entries.length === 0) {
    return { imported: 0, skipped: 0, quarantined: 0, operations: 0 };
  }

  const known = new Set(await io.listImportedSources());
  const fresh = plan.entries.filter(entry => !entry.sourceKeys.some(key => known.has(key)));
  const skipped = plan.entries.length - fresh.length;
  const routed = fresh.filter(entry => !entry.quarantined);
  const quarantined = fresh.length - routed.length;
  if (routed.length === 0) {
    return { imported: 0, skipped, quarantined, operations: 0 };
  }

  const existingOps = await io.listExistingOps?.() ?? [];
  const existing = [...applyOperations(existingOps).values()];
  const clock = frontierOf(existingOps).maxClock + 1;
  const ops = routed.flatMap(entry => {
    const identity = entry.ops.find(op => op.action === 'add-identity')?.value as AddIdentityValue | undefined;
    const record = identity && existing.find(r => r.directoryId === entry.directoryId
      && r.identities.some(i => i.pubkey === identity.pubkey));
    const memberships = entry.ops.filter(op => op.action === 'link-list');
    // Additive history only: the original imported add/identity/membership
    // operations are immutable. Already-marked legacy imports stay untouched.
    const origins: ContactOperation[] = memberships.map((op, index): ContactOperation => {
      const ownerIdentityPubkey = (op.value as { ownerIdentityPubkey: string }).ownerIdentityPubkey;
      const id = importOperationId(entry.directoryId, 'contact', op.operationId, 'origin-v1');
      return { ...op, operationId: id, contactId: record?.contactId ?? entry.contactId,
        action: 'record-origin', ownerIdentityPubkey,
        logicalClock: IMPORT_ITEM_CLOCK + memberships.length + 1 + index,
        value: { id, ownerIdentityPubkey, method: 'import',
          // Legacy contacts and kens store Unix seconds; history uses millis.
          addedAt: Math.min(253402300799999, Math.max(0, Math.floor(op.createdAt * 1000))) } };
    }).filter(op => !existingOps.some(old => old.operationId === op.operationId));
    if (!record || record.contactId === entry.contactId) return [...entry.ops, ...origins];
    // A new legacy source links into the existing record, never a duplicate
    // or an implicit resurrection of a contact the owner removed.
    if (record.lifecycle === 'removed') return [];
    const links = entry.ops.filter(op => op.action === 'add' || op.action === 'link-list').flatMap((op, index) => {
      const ownerIdentityPubkey = (op.value as AddContactValue).ownerIdentityPubkey;
      if (!ownerIdentityPubkey) return [];
      return [{ ...op, contactId: record.contactId, action: 'link-list' as const,
        operationId: importOperationId(entry.directoryId, 'contact', identity!.pubkey, `list-membership:${ownerIdentityPubkey}`),
        logicalClock: clock + index, value: { ownerIdentityPubkey } }];
    });
    return [...links, ...origins.map((op, index) => ({ ...op, logicalClock: clock + links.length + index }))];
  });
  await io.saveOps(ops);
  await io.markSources(routed.flatMap(entry => entry.sourceKeys), input.now);

  return {
    imported: routed.length,
    skipped,
    quarantined,
    operations: ops.length,
  };
}
