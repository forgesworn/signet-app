/** Build app introductions within one granted identity list. Existing keys
 * keep their canonical record; cross-list links wait for owner review and
 * receive restricted projections. No existence result is sent to the app. */
import { sanitizeWireText } from '@forgesworn/signet-contacts/wire';
import type { AddKenValue } from '@forgesworn/signet-contacts/wire';
import type { ContactOperation } from '../types';
import { buildOperation } from './contacts-v2-mutations';
import { frontierOf, nextClock } from './contacts-v2-clock';
import { newContactId, newOperationId } from './contacts-v2-ids';
import { applyOperations, validateOperation } from './contacts-v2-reducer';
import { MAX_APP_CREATED_CONTACTS } from '../types';

// 'quarantine' is excluded deliberately: it is where unresolved LEGACY rows
// wait, not a directory anybody may be added to.
const DIRECTORY_ID = /^(owner|dependant:[0-9a-f]{64})$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const MAX_NAME = 100;

export interface AppProposalContext {
  /** This install's stable actor pubkey — never the app's. */
  grantId?: string;
  appName?: string;
  ownerIdentityPubkey?: string;
  actorPubkey: string;
  actorDeviceId: string;
  /** Every operation already in the target directory, for clock seeding. */
  existingOps: readonly ContactOperation[];
  /** Milliseconds, matching `ContactOperation.createdAt`. */
  now: number;
}

export type AppProposalResult =
  | { ok: true; outcome: 'created' | 'existing'; contactId: string; operations: ContactOperation[] }
  | { ok: false; reason: 'invalid-directory' | 'invalid-actor' | 'invalid-operation' | 'directory-full' };

export function applyContactProposal(
  directoryId: string,
  proposal: AddKenValue,
  ctx: AppProposalContext,
): AppProposalResult {
  if (!ctx.grantId || !HEX32.test(ctx.grantId) || !ctx.ownerIdentityPubkey || !HEX64.test(ctx.ownerIdentityPubkey)) return { ok: false, reason: 'invalid-operation' };
  if (!DIRECTORY_ID.test(directoryId)) return { ok: false, reason: 'invalid-directory' };
  if (!HEX64.test(ctx.actorPubkey) || !HEX32.test(ctx.actorDeviceId)) {
    return { ok: false, reason: 'invalid-actor' };
  }

  const pubkey = typeof proposal.pubkey === 'string' ? proposal.pubkey.toLowerCase() : '';
  if (!HEX64.test(pubkey)) return { ok: false, reason: 'invalid-operation' };
  // A/M2 (R-6): the SDK's own sanitiser, the same one the parser and the
  // projection builder use. Two sanitisers over one wire string is what R-6
  // exists to prevent, and the app's `sanitizeDisplayName` slices by UTF-16
  // code unit where this one slices by code point.
  const displayName = sanitizeWireText(proposal.displayName, MAX_NAME);
  if (displayName.length === 0) return { ok: false, reason: 'invalid-operation' };

  // R-28(a)/(b): both answers come from the directory as it stands, so they are
  // computed once, from the operations the caller already had to read.
  const records = [...applyOperations([...ctx.existingOps]).values()].filter(r => r.directoryId === directoryId);
  const live = records.filter(r => r.lifecycle !== 'removed');

  const removed = records.find(r => r.lifecycle === 'removed' && r.identities.some(i => i.pubkey === pubkey));
  if (removed) return { ok: false, reason: 'invalid-operation' };
  const existing = live.find((r) => r.identities.some((i) => i.pubkey.toLowerCase() === pubkey));
  if (existing?.appIntroductions?.some(i => i.grantId === ctx.grantId)) return { ok: true, outcome: 'existing', contactId: existing.contactId, operations: [] };

  // Count introductions per grant, including rejected and removed ones.
  const appCreated = records.filter(r => r.appIntroductions?.some(i => i.grantId === ctx.grantId)).length;
  if (appCreated >= MAX_APP_CREATED_CONTACTS) return { ok: false, reason: 'directory-full' };

  const contactId = existing?.contactId ?? newContactId();
  const itemId = newOperationId();
  const actor = { actorPubkey: ctx.actorPubkey, actorRole: 'app' as const, actorDeviceId: ctx.actorDeviceId };

  // Seeded from the directory's observed frontier, like every other writer:
  // a clock below what is already there loses every conflict against it.
  const clock = nextClock(0, frontierOf([...ctx.existingOps]).maxClock);

  const intro = { ...(ctx.appName ? { appName: sanitizeWireText(ctx.appName, MAX_NAME) } : {}), grantId: ctx.grantId, ownerIdentityPubkey: ctx.ownerIdentityPubkey, pubkey, displayName };
  const operations = existing ? [buildOperation({
    directoryId, contactId, action: 'app-propose-list', value: intro, clock, actor, now: ctx.now, operationId: newOperationId(),
  })] : [
    buildOperation({
      directoryId, contactId, action: 'add', clock, actor, now: ctx.now,
      operationId: newOperationId(),
      value: { type: 'person', displayName, tier: 'ken', lifecycle: 'active', appIntroduction: intro },
    }),
    buildOperation({
      directoryId, contactId, action: 'add-identity', clock: clock + 1, actor, now: ctx.now,
      operationId: newOperationId(), itemId,
      value: { itemId, pubkey, provenance: 'app-proposal', verification: 'unverified' },
    }),
  ];

  // Never hand back something the reducer would drop: the caller persists this
  // batch wholesale, and half a contact is worse than none.
  if (!operations.every((op) => validateOperation(op))) return { ok: false, reason: 'invalid-operation' };

  return { ok: true, outcome: 'created', contactId, operations };
}
