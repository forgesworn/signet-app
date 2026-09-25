/**
 * URL-based verify request helpers — mirrors the Sign-in-with-Signet
 * `?auth=1` redirect flow. External sites can redirect a user to
 *   https://mysignet.app/?verify=<base64-encoded-VerifyRequest-JSON>
 * and the app will pick up the request on mount.
 *
 * The callback URL is carried inside the VerifyRequest envelope
 * (`request.callbackUrl`) — no separate `?callback=` query param.
 * All structural validation (timestamp window, hex requestId, age-range
 * allowlist, callbackUrl scheme) is delegated to the protocol-level
 * `parseVerifyRequest`.
 */

import { parseVerifyRequest } from 'signet-protocol';
import type { VerifyRequest, VerifyResponse } from 'signet-protocol';

export function parseVerifyRequestFromUrl(search: string): VerifyRequest | null {
  const params = new URLSearchParams(search);
  const raw = params.get('verify');
  if (!raw) return null;
  return parseVerifyRequest(raw);
}

export function buildVerifyCallbackUrl(
  callbackUrl: string,
  response: VerifyResponse,
): string {
  const url = new URL(callbackUrl);
  url.searchParams.set('verified', '1');
  url.searchParams.set('response', btoa(JSON.stringify(response)));
  return url.toString();
}

export function buildVerifyDeniedUrl(callbackUrl: string): string {
  const url = new URL(callbackUrl);
  url.searchParams.set('verified', '0');
  return url.toString();
}
