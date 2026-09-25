import type { ChildSettings } from '../types';
const HEX = /^[0-9a-f]{64}$/;
/** Allowlisted portable form. No pairing credentials or device-local fields. */
export function portableChildContactSettings(raw: unknown): ChildSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as ChildSettings;
  if (typeof value.childPubkey !== 'string' || typeof value.guardianPubkey !== 'string'
    || !HEX.test(value.childPubkey) || !HEX.test(value.guardianPubkey)
    || !['kin-only', 'approved', 'open'].includes(value.contactPolicy)
    || !['none', 'ken', 'kith', 'kin'].includes(value.defaultChildCeiling ?? 'ken')
    || !Number.isSafeInteger(value.updatedAt ?? 0) || (value.updatedAt ?? 0) < 0 || (value.updatedAt ?? 0) > 253402300799999
    || (value.contactPolicyConflicted !== undefined && typeof value.contactPolicyConflicted !== 'boolean')) return null;
  const approved = value.approvedContacts ?? [];
  if (!Array.isArray(approved) || approved.length > 500 || !approved.every(key => typeof key === 'string' && HEX.test(key))) return null;
  return { childPubkey: value.childPubkey, guardianPubkey: value.guardianPubkey,
    contactPolicy: value.contactPolicy, defaultChildCeiling: value.defaultChildCeiling ?? 'ken',
    approvedContacts: [...new Set(approved)].sort(), updatedAt: value.updatedAt ?? 0,
    ...(value.contactPolicyConflicted ? { contactPolicyConflicted: true } : {}) };
}
/** Equal-clock disagreement has no safe ordering between Kin and an explicit
 * allowlist. Preserve a deterministic value, deny contacts until the guardian
 * makes a newer choice, and never silently union permissions. */
export function mergeChildContactSettings(local: ChildSettings | undefined, incoming: ChildSettings): ChildSettings {
  const remote = portableChildContactSettings(incoming), previous = local && portableChildContactSettings(local);
  if (!remote || (local && !previous)) throw new Error('Invalid child contact settings');
  if (!previous) return remote;
  if (previous.childPubkey !== remote.childPubkey || previous.guardianPubkey !== remote.guardianPubkey) throw new Error('Child contact settings belong to another guardian');
  if (previous.updatedAt! > remote.updatedAt!) return previous;
  if (previous.updatedAt! < remote.updatedAt!) return remote;
  const withoutConflict = (value: ChildSettings) => { const { contactPolicyConflicted: _ignored, ...rest } = value; return JSON.stringify(rest); };
  const a = withoutConflict(previous), b = withoutConflict(remote);
  if (a === b && !previous.contactPolicyConflicted && !remote.contactPolicyConflicted) return previous;
  const ceilings = ['none', 'ken', 'kith', 'kin'] as const;
  const strictest = Math.min(ceilings.indexOf(previous.defaultChildCeiling!), ceilings.indexOf(remote.defaultChildCeiling!));
  return { ...(a < b ? previous : remote), contactPolicyConflicted: true,
    approvedContacts: previous.approvedContacts!.filter(peer => remote.approvedContacts!.includes(peer)),
    defaultChildCeiling: ceilings[strictest] };
}
