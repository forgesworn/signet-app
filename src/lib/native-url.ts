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
// no query, or any non-root path, is `none`.
import { parsePairingRequest, type PairingRequest } from './companion-pair';
import {
  isContactsPairingV2, parseContactsPairingRequestV2, type PairingRequestV2,
} from './companion-pair-v2';
import { parseSignInRequest } from './url-auth';
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
