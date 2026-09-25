import { sanitizeNote } from './text-sanitize';

export const CONTACT_CHECK_METHODS = ['words', 'in-person', 'nip05', 'app-attested'] as const;
export const CONTACT_CHECK_SOURCES = ['nip05', 'facebook', 'instagram', 'x', 'youtube', 'website', 'printed-card', 'other'] as const;
export interface ContactCheck {
  id: string;
  identityPubkey: string;
  ownerIdentityPubkey: string;
  method: typeof CONTACT_CHECK_METHODS[number];
  /** Unix milliseconds, consistent with the contact operation log. */
  checkedAt: number;
  source?: typeof CONTACT_CHECK_SOURCES[number];
  /** Owner-private evidence; never part of app projections or people exports. */
  evidence?: string;
}
export function validContactCheck(raw: unknown): raw is ContactCheck {
  if (!raw || typeof raw !== 'object') return false;
  const v = raw as ContactCheck;
  return typeof v.id === 'string' && /^[0-9a-f]{32}$/.test(v.id)
    && typeof v.identityPubkey === 'string' && /^[0-9a-f]{64}$/.test(v.identityPubkey)
    && typeof v.ownerIdentityPubkey === 'string' && /^[0-9a-f]{64}$/.test(v.ownerIdentityPubkey)
    && CONTACT_CHECK_METHODS.includes(v.method) && Number.isSafeInteger(v.checkedAt) && v.checkedAt >= 0 && v.checkedAt <= 253402300799999
    && (v.source === undefined || CONTACT_CHECK_SOURCES.includes(v.source))
    && (v.evidence === undefined || (typeof v.evidence === 'string' && v.evidence.length <= 2000));
}
export function normaliseContactCheck(v: ContactCheck): ContactCheck {
  return { id: v.id, identityPubkey: v.identityPubkey, ownerIdentityPubkey: v.ownerIdentityPubkey,
    method: v.method, checkedAt: v.checkedAt,
    ...(v.source ? { source: v.source } : {}),
    ...(v.evidence ? { evidence: sanitizeNote(v.evidence, 2000) } : {}) };
}
