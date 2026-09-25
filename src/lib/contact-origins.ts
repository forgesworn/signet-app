import { sanitizeDisplayName } from './text-sanitize';
export const CONTACT_ORIGIN_METHODS = ['qr', 'npub', 'nip05', 'link', 'import', 'accepted-request', 'app', 'manual'] as const;
export const CONTACT_ORIGIN_LABELS: Record<typeof CONTACT_ORIGIN_METHODS[number], string> = {
  qr: 'Scanned QR', npub: 'Pasted public key', nip05: 'NIP-05', link: 'Contact link', import: 'Import',
  'accepted-request': 'Accepted request', app: 'Via an app', manual: 'Added manually',
};
/** Owner-private history. No origin fields are included in app projections. */
export interface ContactOrigin {
  id: string; ownerIdentityPubkey: string; method: typeof CONTACT_ORIGIN_METHODS[number]; addedAt: number;
  inviteId?: string; inviteName?: string; caption?: string; appName?: string;
}
export function validContactOrigin(raw: unknown): raw is ContactOrigin {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as ContactOrigin;
  return typeof value.id === 'string' && /^[0-9a-f]{32}$/.test(value.id)
    && typeof value.ownerIdentityPubkey === 'string' && /^[0-9a-f]{64}$/.test(value.ownerIdentityPubkey)
    && CONTACT_ORIGIN_METHODS.includes(value.method) && Number.isSafeInteger(value.addedAt) && value.addedAt >= 0 && value.addedAt <= 253402300799999
    && (value.inviteId === undefined || (typeof value.inviteId === 'string' && /^[0-9a-f]{32}$/.test(value.inviteId)))
    && [value.inviteName, value.caption, value.appName].every(s => s === undefined || (typeof s === 'string' && s.length <= 200));
}
export function normaliseContactOrigin(value: ContactOrigin): ContactOrigin {
  return { id: value.id, ownerIdentityPubkey: value.ownerIdentityPubkey, method: value.method, addedAt: value.addedAt,
    ...(value.inviteId ? { inviteId: value.inviteId } : {}),
    ...(value.inviteName ? { inviteName: sanitizeDisplayName(value.inviteName, 200) } : {}),
    ...(value.caption ? { caption: sanitizeDisplayName(value.caption, 200) } : {}),
    ...(value.appName ? { appName: sanitizeDisplayName(value.appName, 200) } : {}) };
}
