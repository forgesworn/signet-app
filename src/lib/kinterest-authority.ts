import type { UnsignedEvent } from 'signet-protocol';

export const KINTEREST_SCOPE = 'kin-jar:family:v2';
export const FAMILY_PURPOSE = 'Authorise this family key to manage Kinterest and its encrypted family backup.';
export const PARENT_PURPOSE = 'Confirm parent presence to set or reset this device’s separate Kinterest parent PIN.';
export const CHILD_PURPOSE = 'Choose this My Signet dependant for Kinterest and authorise this device for child actions.';
const HEX = /^[0-9a-f]{64}$/;
export function isKinterestAuthority(t: UnsignedEvent): boolean {
  return t.tags.some(tag => tag[0] === 'd' && typeof tag[1] === 'string' && /^kin-jar\/(family-authorisation|child-selection|parent-presence)\//.test(tag[1]));
}
function one(t: UnsignedEvent, key: string): string | null {
  const tags = t.tags.filter(row => row[0] === key);
  return tags.length === 1 && tags[0]?.length === 2 ? tags[0][1] : null;
}
export interface KinterestRequest {
  familyPk: string; challenge: string; parentPresence?: true;
  child?: { identityPk: string; devicePk: string; role: 'shared-phone' | 'child-phone' };
}
export function parseKinterestRequest(t: UnsignedEvent): KinterestRequest | null {
  if (t.kind !== 30078 || !Number.isSafeInteger(t.created_at) || t.created_at < 0) return null;
  const familyPk = one(t, 'family');
  const challenge = one(t, 'challenge');
  if (!familyPk || !HEX.test(familyPk) || !challenge || !HEX.test(challenge) || one(t, 'scope') !== KINTEREST_SCOPE || one(t, 'approval') !== 'request') return null;
  if (one(t, 'd') === `kin-jar/family-authorisation/v2/${familyPk}` && t.content === FAMILY_PURPOSE && t.tags.length === 5) return { familyPk, challenge };
  if (one(t, 'd') === `kin-jar/parent-presence/v2/${familyPk}` && t.content === PARENT_PURPOSE && t.tags.length === 5) return { familyPk, challenge, parentPresence:true };
  const identityPk = one(t, 'child');
  const devicePk = one(t, 'device');
  const role = one(t, 'role');
  if (one(t, 'd') !== `kin-jar/child-selection/v2/${familyPk}` || t.content !== CHILD_PURPOSE || t.tags.length !== 8 ||
      !identityPk || !HEX.test(identityPk) || !devicePk || !HEX.test(devicePk) || devicePk === identityPk || devicePk === familyPk || !['shared-phone','child-phone'].includes(role ?? '')) return null;
  return { familyPk, challenge, child: { identityPk, devicePk, role: role as 'shared-phone' | 'child-phone' } };
}
export function confirmKinterest(t: UnsignedEvent, childContent?: string): UnsignedEvent {
  if (!parseKinterestRequest(t)) throw new Error('Invalid Kinterest request');
  return { ...t, ...(childContent === undefined ? {} : { content: childContent }), tags: t.tags.map(row => row[0] === 'approval' ? ['approval', 'confirmed'] : row[0] === 'child' && childContent ? ['child', JSON.parse(childContent).identityPk] : row) };
}
export function kinterestDescription(t: UnsignedEvent): string | null {
  const r = parseKinterestRequest(t);
  if (!r) return null;
  return r.parentPresence ? 'Kinterest parent PIN setup or reset' : r.child ? 'Kinterest child identity and device authorisation' : 'Kinterest family authorisation';
}
