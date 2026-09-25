import type { AppGrantV2, ContactOperation, EffectiveContact } from '../types';
import { applyOperations } from './contacts-v2-reducer';
import { contactBelongsToList } from './contacts-v2-membership';

/** One disclosure boundary for publishers and proposal rename lookup. */
export function contactsForGrant(grant: AppGrantV2, contacts: readonly EffectiveContact[], ops: readonly ContactOperation[]): EffectiveContact[] {
  if (!grant.ownerIdentityPubkey || !/^[0-9a-f]{64}$/.test(grant.ownerIdentityPubkey) || grant.revokedAt) return [];
  return contacts.flatMap(contact => {
    if (contact.directoryId !== grant.directoryId) return [];
    const member = contact.listMemberships?.find(m => m.ownerIdentityPubkey === grant.ownerIdentityPubkey);
    // A previously granted blocked key remains filterable after deletion.
    if (!contactBelongsToList(contact, grant.ownerIdentityPubkey!) && !(member && contact.blocked)) return [];
    const own = contact.appIntroductions?.find(i => i.grantId === grant.grantId);
    if (own && own.status !== 'accepted') return [];
    // An app-made link must not become a way for a second app to read the
    // old fields either. It receives the same restricted list baseline.
    const intro = own ?? contact.appIntroductions?.find(i => i.ownerIdentityPubkey === grant.ownerIdentityPubkey
      && i.restricted && i.status === 'accepted');
    if (!intro?.restricted) return [{ ...contact, ...(contact.checks ? { checks: contact.checks.filter(c => c.ownerIdentityPubkey === grant.ownerIdentityPubkey) } : {}) }];
    if (intro.ownerIdentityPubkey !== grant.ownerIdentityPubkey) return [];
    const identity = contact.identities.find(i => i.pubkey === intro.pubkey);
    const seed: ContactOperation = {
      operationId: '0'.repeat(32), directoryId: contact.directoryId, contactId: contact.contactId,
      actorPubkey: grant.ownerIdentityPubkey!, actorRole: 'owner', actorDeviceId: '0'.repeat(32),
      logicalClock: 1, createdAt: intro.createdAt, action: 'add',
      value: { type: 'person', displayName: intro.displayName, tier: 'ken' },
    };
    const allowed = new Set(['rename', 'set-tier', 'add-identity', 'update-identity', 'evidence', 'add-method', 'update-method', 'remove-item', 'record-check', 'remove-check']);
    const later = ops.filter(op => op.directoryId === contact.directoryId && (op.contactId === contact.contactId || contact.mergedContactIds?.includes(op.contactId))
      && op.actorRole !== 'app' && op.ownerIdentityPubkey === grant.ownerIdentityPubkey
      && op.logicalClock > intro.logicalClock && allowed.has(op.action));
    const copy = [...applyOperations([seed, { ...seed, operationId: '1'.repeat(32), action: 'add-identity',
      value: { itemId: identity?.itemId ?? '2'.repeat(32), pubkey: intro.pubkey, provenance: 'app-proposal', verification: 'unverified' } },
      ...later.map(op => ({ ...op, contactId: contact.contactId, logicalClock: op.logicalClock + 2 })),
    ]).values()][0];
    if (!copy) return [];
    // A global removal or privacy withdrawal also applies to this copy.
    if (copy.checks) copy.checks = copy.checks.filter(c => contact.checks?.some(current => current.id === c.id));
    copy.identities = copy.identities.filter(i => contact.identities.some(c => c.pubkey === i.pubkey));
    copy.contactMethods = copy.contactMethods.filter(m => contact.contactMethods.some(c => c.itemId === m.itemId))
      .map(m => ({ ...m, sharingPolicy: contact.contactMethods.find(c => c.itemId === m.itemId)?.sharingPolicy === 'private' ? 'private' : m.sharingPolicy }));
    return [{ ...copy, lifecycle: contact.lifecycle, archived: contact.archived,
      blocked: contact.blocked, blockedBy: [], effectiveTier: contact.effectiveTier === 'none' ? 'none' : ({ ken: 1, kith: 2, kin: 3 }[copy.tier] <= { ken: 1, kith: 2, kin: 3 }[contact.effectiveTier] ? copy.tier : contact.effectiveTier), tierSource: 'direct' as const,
    }];
  });
}
