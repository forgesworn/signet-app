import { encodeContactInvite, parseContactInvite } from '@forgesworn/signet-contacts';
import type { ContactInvite } from '@forgesworn/signet-contacts';
/** The mailbox capability stays in the fragment, never in a server query. */
export function contactInviteLink(invite: ContactInvite, origin: string): string {
  const url = new URL('/', origin);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Invalid invite origin');
  url.hash = new URLSearchParams({ 'contact-invite': encodeContactInvite(invite) }).toString();
  return url.href;
}
export function parseContactInviteLink(raw: string, now = Math.floor(Date.now() / 1000)): ContactInvite | null {
  if (raw.length > 8192) return null;
  let value = raw.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const values = new URLSearchParams(url.hash.slice(1)).getAll('contact-invite');
      if (values.length !== 1) return null;
      value = values[0];
    } catch { return null; }
  }
  return parseContactInvite(value, now);
}
