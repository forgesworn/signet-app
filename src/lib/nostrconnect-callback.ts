/**
 * Validation for the `callback=` URL that companion apps may append to
 * `https://mysignet.app/?nostrconnect=...`.
 *
 * After a successful `?nostrconnect=` pairing, Signet can bounce the
 * user back to a consumer-supplied callback — solving the "stranded on
 * mysignet.app after approving" desktop UX gap.
 *
 * The validator enforces two checks:
 *
 * 1. **Scheme:** `https://` in production, or `http://localhost` /
 *    `http://127.0.0.1` for local dev. Anything else is rejected —
 *    we don't redirect to `file://`, bare `http://<ip>`, custom
 *    schemes, etc.
 *
 * 2. **Origin match:** if the inner `nostrconnect://` URI carried an
 *    `appUrl` in its metadata, the callback's origin must equal it.
 *    This is the anti-phishing guardrail: an attacker-crafted QR can't
 *    redirect back to an attacker-controlled domain while claiming to
 *    be matchpass.app. If `appUrl` is absent, we accept any well-formed
 *    https/localhost callback (the companion didn't declare an origin,
 *    so we have nothing to cross-check against).
 *
 * Rejected callbacks are dropped silently — the pairing still succeeds;
 * the user just lands on Signet's home screen rather than being
 * bounced. This matches the failure mode the companion would see if
 * the user simply closed the Signet tab.
 */

/**
 * Parse and validate a raw `callback=` URL against an optional expected
 * `appUrl` origin.
 *
 * Returns the normalised URL string on success, or `null` if the
 * callback is malformed, uses a disallowed scheme, or fails the
 * origin-match check.
 */
export function parseCallback(rawCallback: string | null, appUrl?: string): string | null {
  if (!rawCallback) return null;

  let cb: URL;
  try {
    cb = new URL(rawCallback);
  } catch {
    return null;
  }

  // Scheme gate: https everywhere, http only for loopback.
  const schemeOk =
    cb.protocol === 'https:' ||
    (cb.protocol === 'http:' && (cb.hostname === 'localhost' || cb.hostname === '127.0.0.1'));
  if (!schemeOk) return null;

  // Reject userinfo (user:pass@host). An attacker-crafted callback with
  // fake credentials is preserved by URL.toString() and surfaces in the
  // redirect location, where some browsers display it as a trust cue
  // and some trigger a basic-auth prompt on the destination.
  if (cb.username !== '' || cb.password !== '') return null;

  // If the companion declared an appUrl in the nostrconnect metadata,
  // the callback origin must match it exactly. Subdomain callbacks
  // (e.g. callback.matchpass.app when appUrl is https://matchpass.app)
  // are intentionally rejected — a companion that wants a subdomain
  // callback should declare the subdomain as its appUrl.
  if (appUrl) {
    try {
      if (cb.origin !== new URL(appUrl).origin) return null;
    } catch {
      return null;
    }
  }

  return cb.toString();
}

/**
 * Build a redirect URL by appending `status=approved|denied` to the
 * already-validated callback. Preserves any existing query params the
 * callback may have had.
 */
export function buildCallbackRedirect(callback: string, status: 'approved' | 'denied'): string {
  const url = new URL(callback);
  url.searchParams.set('status', status);
  return url.toString();
}
