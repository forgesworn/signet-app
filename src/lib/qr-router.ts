/**
 * Universal QR Router
 *
 * Thin wrapper over signet-protocol's routeQR. Adds app-level handling of
 * URL-shaped QRs pointing at https://mysignet.app/?auth=1&… — the canonical
 * Sign-in-with-Signet redirect URL. When a user's phone camera scans that
 * URL from a laptop, the OS opens a browser; when the in-app scanner picks
 * it up, we route it straight to the approve screen.
 *
 * The hostname pin lives here (not in signet-protocol) because the URL is
 * an app-distribution contract, not a protocol format.
 */

import { parseContactInviteLink } from './contact-invite-link';
import type { ContactInvite } from '@forgesworn/signet-contacts';
import {
  routeQR as protocolRouteQR,
  QR_MAX_PAYLOAD_SIZE,
} from 'signet-protocol';
import type {
  QRAction as ProtocolQRAction,
  AuthRequest as ProtocolAuthRequest,
  LoginRequest as ProtocolLoginRequest,
} from 'signet-protocol';
import { parseUrlAuthRequest } from './url-auth';
import { parsePairingRequest } from './companion-pair';
import type { PairingRequest } from './companion-pair';
import { isContactsPairingV2, parseContactsPairingRequestV2 } from './companion-pair-v2';
import type { PairingRequestV2 } from './companion-pair-v2';
import { isHeartwoodImportLinkText } from './heartwood-operator-import';

export { QR_MAX_PAYLOAD_SIZE };
/**
 * App-side sign-in requests: the protocol shape plus `relays`, every consumer
 * relay for relay-mode delivery, primary first (up to three, from repeated
 * `relay=` params). Invariant: when `relay` is set, `relay === relays[0]`;
 * when it is not, `relays` is empty. signet-protocol stays single-relay.
 *
 * `name` is the app name a `?auth=1` URL asked for (`name=`), cleaned the way
 * the URL handler cleans it, so a link scanned in-app keeps it too. Absent
 * when the consumer named none, and on protocol (JSON/compact) QRs.
 */
export type AuthRequest = ProtocolAuthRequest & { relays: string[]; name?: string };
export type LoginRequest = ProtocolLoginRequest & { relays: string[]; name?: string };

/** A protocol-parsed request (JSON/compact QR) carries at most its one relay. */
function withSingleRelay<T extends ProtocolAuthRequest | ProtocolLoginRequest>(request: T): T & { relays: string[] } {
  return { ...request, relays: request.relay ? [request.relay] : [] };
}

/** Protocol routing, with sign-in requests lifted to the app-side shape. */
function routeProtocolQR(raw: string): QRAction {
  const action = protocolRouteQR(raw);
  if (action.type === 'auth') return { type: 'auth', request: withSingleRelay(action.request) };
  if (action.type === 'login') return { type: 'login', request: withSingleRelay(action.request) };
  return action;
}

// Signet-app-side QRAction: the protocol union (with sign-in requests in their
// app-side shape) plus the companion-rail pairing action, which is an
// app-distribution contract (like the mysignet.app hostname pin below), not a
// protocol format.
export type QRAction =
  | Exclude<ProtocolQRAction, { type: 'auth' } | { type: 'login' }>
  | { type: 'auth'; request: AuthRequest }
  | { type: 'login'; request: LoginRequest }
  | { type: 'contact-invite'; invite: ContactInvite }
  | { type: 'companion-pair'; request: PairingRequest }
  /** Contacts v2 grant request — same `signet-grant:` carrier as v1, marked
   *  `v=2` and carrying a capability list instead of a tier scope. */
  | { type: 'contacts-pair-v2'; request: PairingRequestV2 }
  /** Sapwood "Manage from your phone" handoff link (`#/import?op=…|eop=…`) —
   *  routed to the Heartwood operator-key import (C3, §11.1.4/9). `raw` is
   *  the verbatim scan; the secret inside is resolved by the import flow. */
  | { type: 'heartwood-operator-import'; raw: string };

export const MYSIGNET_HOSTS = new Set(['mysignet.app', 'www.mysignet.app']);

/** A verified `https://mysignet.app/pair…` Android App Link carrying a pairing
 *  request (the interception-resistant replacement for the signet-grant:// scheme). */
export function isCompanionPairAppLink(raw: string): boolean {
  if (!/^https?:\/\//i.test(raw)) return false;
  try {
    const url = new URL(raw);
    return MYSIGNET_HOSTS.has(url.hostname.toLowerCase()) && url.pathname.startsWith('/pair');
  } catch {
    return false;
  }
}

export function routeQR(data: string): QRAction {
  if (data.length > QR_MAX_PAYLOAD_SIZE) return { type: 'unknown', raw: data.slice(0, 100) };
  const raw = data.trim();
  const invite = parseContactInviteLink(raw);
  if (invite) return { type: 'contact-invite', invite };

  // Companion-rail pairing request, in any carrier: the native
  // `signet-grant://pair` scheme, a same-device web-carrier URL (`?pair=1&app=…`),
  // or a verified `https://mysignet.app/pair?…` Android App Link (the exclusive,
  // interception-resistant form — see AndroidManifest.xml + assetlinks.json).
  // parsePairingRequest is scheme-agnostic (it reads the query after `?`), so all
  // three parse identically. Checked before the mysignet.app auth block so a
  // `/pair` App Link isn't mistaken for an auth request.
  if (raw.startsWith('signet-grant://pair') || raw.includes('pair=1') || isCompanionPairAppLink(raw)) {
    // v2 first: a v2 URI carries `v=2` and a `caps=` list, which the v1 parser
    // would read as a request with an empty tier scope. Checked by an explicit
    // version marker rather than by "did the other parser fail", so neither
    // version can ever be silently read as the other.
    if (isContactsPairingV2(raw)) {
      const { request } = parseContactsPairingRequestV2(raw);
      if (request) return { type: 'contacts-pair-v2', request };
      return { type: 'unknown', raw: raw.slice(0, 100) };
    }
    const { request } = parsePairingRequest(raw);
    if (request) return { type: 'companion-pair', request };
  }

  // Heartwood operator handoff link (Sapwood QR) — any origin, matched on the
  // `#/import?…` fragment carrying an operator secret. Checked before the
  // generic URL branch so a mysignet.app-hosted link isn't read as auth.
  if (raw.includes('#/import') && isHeartwoodImportLinkText(raw)) {
    return { type: 'heartwood-operator-import', raw };
  }

  // mysignet.app URL-shaped auth request (browser-handoff QR scanned in-app)
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (MYSIGNET_HOSTS.has(url.hostname.toLowerCase())) {
        const nostrConnectUri = url.searchParams.get('nostrconnect');
        if (nostrConnectUri) return routeProtocolQR(nostrConnectUri);
        const request = parseUrlAuthRequest(url.search);
        if (request) return { type: 'login', request };
        return { type: 'unknown', raw };
      }
    } catch { /* not a URL — fall through */ }
  }

  return routeProtocolQR(raw);
}
