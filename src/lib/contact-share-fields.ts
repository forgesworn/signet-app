import type { ContactRecord } from '../types';
import { encodeNpub, hexToBytes } from './signet';

export interface ContactShareFields {
  name: boolean;
  identities: string[];
  methods: string[];
  tier: boolean;
  roles: boolean;
  notes: boolean;
  type: boolean;
  checks: boolean;
  blocked: boolean;
}
export function defaultShareFields(contact: ContactRecord, dependant = false): ContactShareFields {
  return { name: true, identities: contact.identities.map(i => i.itemId),
    methods: dependant ? contact.contactMethods.filter(m => m.kind === 'phone').map(m => m.itemId) : [],
    tier: false, roles: false, notes: false, type: false, checks: false, blocked: false };
}
const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
/** Fold by UTF-8 octets without splitting a code point (vCard's 75-octet limit). */
function fold(line: string): string {
  let bytes = 0, out = '';
  for (const c of line) {
    const size = new TextEncoder().encode(c).length;
    if (bytes + size > 75) { out += '\r\n '; bytes = 1; }
    out += c; bytes += size;
  }
  return out;
}
/** Explicit allowlist: no evidence, source links, app metadata or invites. */
export function contactVCard(contact: ContactRecord, fields: ContactShareFields): string {
  const lines = ['BEGIN:VCARD', 'VERSION:4.0', `FN:${escape(fields.name ? contact.displayName : 'Shared contact')}`];
  for (const i of contact.identities.filter(i => fields.identities.includes(i.itemId))) {
    if (/^[0-9a-f]{64}$/i.test(i.pubkey)) lines.push(`IMPP:nostr:${encodeNpub(hexToBytes(i.pubkey))}`);
    if (fields.checks) {
      lines.push(`X-SIGNET-CHECK:${escape(i.pubkey)};${i.verification}${i.direct ? `;${i.direct.verifiedAt}` : ''}`);
      for (const check of contact.checks ?? []) if (check.identityPubkey === i.pubkey) lines.push(`X-SIGNET-CHECK-METHOD:${escape(i.pubkey)};${check.method};${check.checkedAt}`);
    }
  }
  for (const m of contact.contactMethods.filter(m => fields.methods.includes(m.itemId))) {
    const value = escape(m.value);
    switch (m.kind) {
      case 'phone': lines.push(`TEL;VALUE=text:${value}`); break;
      case 'email': lines.push(`EMAIL:${value}`); break;
      case 'website': lines.push(`URL:${value}`); break;
      case 'postal-address': lines.push(`ADR:;;${value};;;;`); break;
      default: lines.push(`X-SIGNET-OTHER:${value}`);
    }
  }
  if (fields.tier) lines.push(`X-SIGNET-TIER:${contact.tier}`);
  if (fields.roles) lines.push(`CATEGORIES:${contact.roles.map(escape).join(',')}`);
  if (fields.notes && contact.notes) lines.push(`NOTE:${escape(contact.notes)}`);
  if (fields.type) lines.push(`KIND:${contact.type === 'person' ? 'individual' : 'org'}`);
  if (fields.blocked) lines.push(`X-SIGNET-BLOCKED:${contact.blocks.some(b => !b.liftedByOperationId)}`);
  return [...lines, 'END:VCARD'].map(fold).join('\r\n') + '\r\n';
}
