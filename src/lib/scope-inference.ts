import type { UnsignedEvent } from 'signet-protocol';

/**
 * User-facing scope categories for dependant-signing policy evaluation.
 *
 * These are the axes of the interaction-type × stage matrix in the
 * 2026-04-22 dependant-accounts-and-guardian-delegation spec. The child never
 * sees Nostr kinds — the bunker server infers a scope from the event template
 * and looks up the appropriate policy (stage default + remembered grant).
 *
 * `age-verify` and `vouch` don't appear here because their kinds aren't yet
 * defined in the protocol. When they are, add cases in `inferScope` and
 * widen this union.
 */
export type Scope =
  | 'sign-in'
  | 'venue-entry'
  | 'post-public'
  | 'dm-private'
  | 'upload-photo'
  | 'react-zap-reply'
  | 'pair-device'
  | 'mutate-identity';

/**
 * Map a Nostr event template to its user-facing scope category, or null
 * if the kind isn't classifiable. Callers fall back to ASK-EVERY for null
 * (conservative — every new request surfaces to the guardian).
 *
 * Kind mapping:
 *   21236                              → sign-in
 *   21235                              → venue-entry
 *   1 (no `e` tag)                     → post-public
 *   1 (with `e` tag) / 7 / 9734        → react-zap-reply
 *       (9734 is the zap REQUEST — the user-signed event. Zap receipts
 *        are kind 9735 and signed by the LNURL service, not the user.)
 *   4 / 13 / 1059                      → dm-private
 *       (Kind 13 is the NIP-59 seal — the actual bunker-visible DM kind
 *        under NIP-17, signed by the real sender. Kind 4 is legacy NIP-04.
 *        Kind 1059 is the gift-wrap, signed by an ephemeral key in-app,
 *        so the bunker should never see it in practice — kept for defence
 *        in depth if a client asks for it.)
 *   24242                              → upload-photo
 *   24133                              → pair-device
 *   0                                  → mutate-identity (profile metadata)
 *   31000 with type: *-name-change     → mutate-identity
 */
export function inferScope(template: UnsignedEvent): Scope | null {
  switch (template.kind) {
    case 21236:
      return 'sign-in';
    case 21235:
      return 'venue-entry';
    case 1: {
      const hasETag = template.tags.some(t => t[0] === 'e');
      return hasETag ? 'react-zap-reply' : 'post-public';
    }
    case 7:
    case 9734:
      return 'react-zap-reply';
    case 4:
    case 13:
    case 1059:
      return 'dm-private';
    case 24242:
      return 'upload-photo';
    case 24133:
      return 'pair-device';
    case 0:
      return 'mutate-identity';
    case 31000: {
      const typeTag = template.tags.find(t => t[0] === 'type');
      const value = typeTag?.[1];
      if (typeof value === 'string' && value.endsWith('name-change')) {
        return 'mutate-identity';
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Extract the origin a scope's remembered-grant would key on. Returns null
 * for non-origin-scoped scopes (venue-entry, post-public, vouch, pair-device,
 * mutate-identity), or when the expected tag isn't present.
 *
 * Origin shapes:
 * - `sign-in` (kind 21236): the `origin` tag value, e.g. "https://roblox.com".
 * - `upload-photo` (kind 24242): the origin of the `u` tag URL.
 * - `dm-private` / `react-zap-reply`: the first `p` tag value — recipient pubkey.
 *
 * See the 2026-04-22 dependant-accounts spec
 * §"Remembered grants".
 */
/**
 * Accept only `https://` origins (and `http://localhost` / `127.0.0.1` for
 * dev). Raw strings that aren't parseable URLs are rejected outright —
 * otherwise an attacker can plant `javascript:` / `data:` pseudo-schemes
 * in a tag and end up with `null` or arbitrary junk as the grant key.
 */
function safeOriginForGrant(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return u.origin;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return u.origin;
    return null;
  } catch {
    return null;
  }
}

export function inferOrigin(template: UnsignedEvent, scope: Scope): string | null {
  switch (scope) {
    case 'sign-in': {
      const originTag = template.tags.find(t => Array.isArray(t) && t[0] === 'origin');
      const value = originTag?.[1];
      if (typeof value !== 'string' || value.length === 0) return null;
      return safeOriginForGrant(value);
    }
    case 'upload-photo': {
      // Blossom auth: the `u` tag carries the upload URL. We key on origin
      // only so a grant for blossom.example.com covers all uploads there.
      const uTag = template.tags.find(t => Array.isArray(t) && t[0] === 'u');
      const raw = uTag?.[1];
      if (typeof raw !== 'string') return null;
      return safeOriginForGrant(raw);
    }
    case 'dm-private':
    case 'react-zap-reply': {
      // Recipient / counterparty pubkey. First `p` tag is the primary target.
      const pTag = template.tags.find(t => Array.isArray(t) && t[0] === 'p');
      const value = pTag?.[1];
      if (typeof value !== 'string') return null;
      return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
    }
    default:
      return null;
  }
}
