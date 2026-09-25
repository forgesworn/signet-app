import type { ChildSettings, ContactRecord } from '../types';
import { resolveEffective } from './contacts-v2-effective';
import { applyOperations } from './contacts-v2-reducer';
import { listContactOperationsV2 } from './db';
export type ContactInviteDecision = 'allow' | 'guardian-review' | 'deny';
/** Blocks always win. Missing settings retain kin-only; a dependant's own
 * classification cannot bypass the guardian ceiling or manufacture Kin. */
export function contactInviteDecision(peer: string, records: ContactRecord[], options: {
  directoryId: string; settings?: ChildSettings; activeGuardianPubkeys: string[];
}): ContactInviteDecision {
  if (!/^[0-9a-f]{64}$/.test(peer)) return 'deny';
  const dependant = options.directoryId.startsWith('dependant:');
  if (options.directoryId !== 'owner' && !dependant) return 'deny';
  // A settings row for a different dependant or departed guardian is not authority.
  const settings = options.settings?.childPubkey === options.directoryId.slice('dependant:'.length)
    && options.activeGuardianPubkeys.includes(options.settings.guardianPubkey) ? options.settings : undefined;
  const matching = records.filter(record => record.directoryId === options.directoryId && record.identities.some(identity => identity.pubkey === peer));
  const effective = matching.map(record => resolveEffective(record, { directoryIsDependant: dependant,
    activeGuardianPubkeys: options.activeGuardianPubkeys, defaultChildCeiling: settings?.defaultChildCeiling ?? 'ken' }));
  if (effective.some(record => record.blocked)) return 'deny';
  if (!dependant) return 'allow';
  if (settings?.contactPolicyConflicted) return 'deny';
  const policy = settings?.contactPolicy ?? 'kin-only';
  if (policy === 'open') return 'allow';
  if (policy === 'approved') return settings?.approvedContacts?.includes(peer) ? 'allow' : 'guardian-review';
  return effective.some(record => record.lifecycle === 'active' && record.effectiveTier === 'kin') ? 'allow' : 'deny';
}
export async function storedContactInviteDecision(peer: string, key: string, options: Parameters<typeof contactInviteDecision>[2]) {
  return contactInviteDecision(peer, [...applyOperations(await listContactOperationsV2(options.directoryId, key)).values()], options);
}
