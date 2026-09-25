/**
 * App-level "contact card" QR wire format (no signet-protocol change). Carries
 * only what a scanner needs to find + decrypt a contact: pubkey, optional
 * display name, optional contact-share avatar key. NEVER image bytes, tier, or
 * vouch counts (those are spoofable/stale — resolved fresh from relays).
 * See 2026-06-04 contact-card-name-avatar design §B4.
 */
import { fetchPublicProfile } from './public-profile-publish';
import { sanitizeDisplayName } from './text-sanitize';
import { isValidHexKey } from './signet';

export interface ContactQRPayload {
  t: 'signet-contact';
  v: 1;
  pubkey: string;
  name?: string;
  avatarKey?: string;
}

/** Strip control/bidi chars, trim, cap at 100. */
export function sanitizeContactName(raw: string): string {
  return sanitizeDisplayName(raw, 100);
}

export function buildContactQR(input: { pubkey: string; name?: string; avatarKey?: string }): string {
  const out: ContactQRPayload = { t: 'signet-contact', v: 1, pubkey: input.pubkey.toLowerCase() };
  if (input.name) {
    const clean = sanitizeContactName(input.name);
    if (clean) out.name = clean;
  }
  if (input.avatarKey && isValidHexKey(input.avatarKey.toLowerCase())) {
    out.avatarKey = input.avatarKey.toLowerCase();
  }
  return JSON.stringify(out);
}

export function parseContactQR(raw: string): ContactQRPayload | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (o.t !== 'signet-contact' || o.v !== 1) return null;
  if (typeof o.pubkey !== 'string' || !isValidHexKey(o.pubkey.toLowerCase())) return null;
  const payload: ContactQRPayload = { t: 'signet-contact', v: 1, pubkey: o.pubkey.toLowerCase() };
  if (typeof o.name === 'string') {
    const clean = sanitizeContactName(o.name);
    if (clean) payload.name = clean;
  }
  if (typeof o.avatarKey === 'string' && isValidHexKey(o.avatarKey.toLowerCase())) {
    payload.avatarKey = o.avatarKey.toLowerCase();
  }
  return payload;
}

/**
 * Resolve the display name to prefill after a scan. Primary: the contact's
 * kind-0 profile (fresh, signature-verified inside fetchPublicProfile).
 * Fallback: the name embedded in the scanned QR (for an unpublished/anonymous
 * persona). `fetchProfile` is injectable for testing.
 */
export async function resolveScannedContactName(
  pubkeyHex: string,
  relayUrl: string,
  payloadName: string | undefined,
  fetchProfile: typeof fetchPublicProfile = fetchPublicProfile,
): Promise<string> {
  try {
    const res = await fetchProfile(pubkeyHex, relayUrl);
    const name = res?.profile.displayName;
    if (name && name.trim()) return sanitizeContactName(name);
  } catch {
    // relay/network failure — fall through to the embedded name
  }
  return payloadName ? sanitizeContactName(payloadName) : '';
}
