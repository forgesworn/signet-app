// Native launch/open URL router (Capacitor `appUrlOpen` + `getLaunchUrl`).
//
// Two carriers reach the APK this way: the `signet-grant://` scheme and
// verified https://mysignet.app App Links (AndroidManifest.xml claims `/pair`
// and the exact root path `/`; /.well-known/assetlinks.json vouches for the
// signing cert). Pairing keeps its existing parser. A Sign-in-with-Signet URL
// (`/?auth=1&challenge=…`) is NOT parsed here beyond validation: it is handed
// back as an href so App.tsx can feed it to `consumeUrlAuthRequest`, the same
// entry point the web page, the PWA launch queue and the focus re-consumers
// use — one parser, one approval screen.
//
// Claiming the root path also captures every OTHER web carrier the browser
// build handles via mount-time `window.location.search` effects — those
// effects are inert inside the APK (its WebView location is
// `https://localhost/`, not `https://mysignet.app/`). `?verify=…`,
// `?action=add-dependant&…` and `?nostrconnect=…` all come back here as
// `root-carrier` (a non-empty root-path query that isn't a valid sign-in
// request) so App.tsx can feed the same query string to the same
// `consumeVerifyUrl` / `consumeAddDependantUrl` / `consumeNostrConnectUrl`
// callbacks the web mount effects use. A plain `https://mysignet.app/` with
// no query, or any non-root path, is `none` (App.tsx tells the user so via
// `isUnactionableMysignetLink`).
import { parsePairingRequest, type PairingRequest } from './companion-pair';
import {
  isContactsPairingV2, parseContactsPairingRequestV2, type PairingRequestV2,
} from './companion-pair-v2';
import { parseSignInRequest } from './url-auth';
import { parseContactInviteLink } from './contact-invite-link';
import { MYSIGNET_HOSTS, QR_MAX_PAYLOAD_SIZE, isCompanionPairAppLink } from './qr-router';

export type NativeUrlAction =
  | { type: 'companion-pair'; request: PairingRequest }
  /** Contacts v2 grant request on the same carrier, marked `v=2`. */
  | { type: 'contacts-pair-v2'; request: PairingRequestV2 }
  | { type: 'sign-in'; href: string }
  | { type: 'root-carrier'; href: string }
  | { type: 'none' };

/** https, one of our hosts, exact root path. Parses `raw` itself (and swallows
 *  a parse failure as `false`) so callers don't have to repeat the try/catch. */
function isMysignetRoot(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && MYSIGNET_HOSTS.has(u.hostname.toLowerCase()) && u.pathname === '/';
  } catch {
    return false;
  }
}

/** Shown when a mysignet.app link opens the app but carries nothing it can act on. */
export const NATIVE_LINK_NOTHING_TO_OPEN_COPY =
  "That link didn't contain a request My Signet can open.";

/**
 * True only for an https link on one of our own hosts that `routeNativeUrl`
 * classified as `none` — i.e. an App Link the OS handed us (bare
 * `https://mysignet.app/`, or a /pair link whose request did not parse) that
 * nothing acted on. A foreign host, a `signet-grant://` scheme link, or a link
 * that WAS routed (including every pairing/sign-in/carrier case) never counts,
 * so the notice cannot misfire for a link handled elsewhere.
 */
export function isUnactionableMysignetLink(url: string, action: NativeUrlAction): boolean {
  if (action.type !== 'none' || typeof url !== 'string') return false;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' && MYSIGNET_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * A contact invite carried on a verified App Link
 * (`https://mysignet.app/#contact-invite=…`, the same shape the web hash path
 * reads). Returns the invite serialised exactly as `pendingContactInvite`
 * holds it, or undefined for anything else — a different host or path, an
 * expired, malformed or oversized invite.
 */
export function contactInviteFromNativeUrl(url: string, now = Math.floor(Date.now() / 1000)): string | undefined {
  if (typeof url !== 'string' || url.length > QR_MAX_PAYLOAD_SIZE) return undefined;
  const raw = url.trim();
  if (!isMysignetRoot(raw)) return undefined;
  const invite = parseContactInviteLink(raw, now);
  return invite ? JSON.stringify(invite) : undefined;
}

export function routeNativeUrl(url: string): NativeUrlAction {
  if (typeof url !== 'string' || url.length === 0 || url.length > QR_MAX_PAYLOAD_SIZE) return { type: 'none' };
  const raw = url.trim();

  // Companion pairing, any carrier — checked first so a /pair App Link that
  // happens to carry auth-looking params is never read as sign-in. A pairing
  // -shaped carrier whose request doesn't actually parse (e.g. a sign-in URL
  // that merely contains the substring `pair=1` somewhere in an unrelated
  // param) falls through to sign-in/root-carrier classification below,
  // rather than dead-ending as `none` — mirrors the idiom in qr-router.ts's
  // routeQR. Host-pinned (`isMysignetRoot`) so a foreign host that merely
  // contains the substring `pair=1` can't reach the pairing parser at all.
  if (raw.startsWith('signet-grant://pair') || (isMysignetRoot(raw) && raw.includes('pair=1')) || isCompanionPairAppLink(raw)) {
    // v2 FIRST, by its explicit `v=2` marker rather than by "did the other
    // parser fail" — the same order and the same reason as `qr-router`'s
    // `routeQR`. Without this a v2 link parses cleanly as v1: the v1 parser
    // finds no tier scope and defaults to ALL tiers, so the owner would be
    // shown the legacy whole-rolodex grant screen for a capability-scoped
    // v2 request. A v2-marked carrier whose request does NOT parse is
    // refused outright rather than falling through to the v1 parser, for
    // exactly the same reason.
    if (isContactsPairingV2(raw)) {
      const { request } = parseContactsPairingRequestV2(raw);
      return request ? { type: 'contacts-pair-v2', request } : { type: 'none' };
    }
    const { request } = parsePairingRequest(raw);
    if (request) return { type: 'companion-pair', request };
  }

  if (!isMysignetRoot(raw)) return { type: 'none' };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { type: 'none' };
  }
  if (parsed.search.length === 0) return { type: 'none' };
  if (parsed.searchParams.get('auth') === '1' && parseSignInRequest(parsed.search)) {
    return { type: 'sign-in', href: raw };
  }
  return { type: 'root-carrier', href: raw };
}
