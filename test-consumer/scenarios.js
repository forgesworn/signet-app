// Scenario catalogue for the Signet Test Harness.
//
// Each scenario receives a `ctx` object with convenience builders. Return
// the full URL to redirect the browser to. The dashboard handles storing
// the launch context in sessionStorage so the callback page can show what
// we originally asked for.

/** 64 random hex chars — used as the sign-in challenge. */
function freshChallenge() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build the context passed to each scenario's build() function.
 * - origin: test consumer's own origin (http://localhost:8080 by default)
 * - callback: test consumer's callback page
 * - target: the Signet to redirect to (mysignet.app or a local dev URL)
 */
function makeContext(targetSignet) {
  const origin = window.location.origin;
  const callback = origin + '/callback.html';
  const now = Math.floor(Date.now() / 1000);

  return {
    origin,
    callback,
    target: targetSignet,

    /**
     * Build a Signet sign-in URL with the given extra params merged on top
     * of the standard auth=1/challenge/origin/callback/name/t set.
     *
     * `name` is required by signet-protocol's parseUrlAuthParams (returns
     * null without it — silent failure). Consumers are expected to pass
     * a human-readable site label; we default to "Signet Test Harness".
     */
    signinUrl(extra = {}, overrides = {}) {
      const challenge = overrides.challenge ?? freshChallenge();
      const t = overrides.t ?? now;
      const useOrigin = overrides.origin ?? origin;
      const useCallback = overrides.callback ?? callback;
      const useName = overrides.name ?? extra.name ?? 'Signet Test Harness';

      const params = new URLSearchParams({
        auth: '1',
        challenge,
        origin: useOrigin,
        callback: useCallback,
        name: useName,
        t: String(t),
        ...extra,
      });
      return {
        url: targetSignet.replace(/\/$/, '') + '/?' + params.toString(),
        launch: { challenge, t, origin: useOrigin, callback: useCallback, name: useName, ...extra },
      };
    },

    /**
     * Build a Signet NIP-46 pairing URL with the given nostrconnect URI.
     * Mirrors what matchpass-app does for its desktop fallback.
     */
    nostrconnectUrl(innerUri) {
      return {
        url: targetSignet.replace(/\/$/, '') + '/?nostrconnect=' + encodeURIComponent(innerUri),
        launch: { nostrconnect: innerUri },
      };
    },
  };
}

/** Generate a dummy nostrconnect URI for the pairing scenario. */
function fakeNostrconnect() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const pubkey = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  const meta = JSON.stringify({
    name: 'Test Harness',
    url: window.location.origin,
  });
  return `nostrconnect://${pubkey}?relay=wss://relay.damus.io&metadata=${encodeURIComponent(meta)}`;
}

const SCENARIOS = [
  // ─── Happy paths ──────────────────────────────────────────────────────────
  {
    id: 'basic',
    section: 'Happy paths',
    title: 'Basic sign-in',
    description: 'Redirect-mode, no constraints. The baseline — if this is broken, everything else is broken.',
    build: (ctx) => ctx.signinUrl(),
  },
  {
    id: 'login-18',
    section: 'Happy paths',
    title: 'Login request (18+ age gate)',
    description: 'signet-login-request with requiredAgeRange=18+. Consumer expects a persona credential attached.',
    build: (ctx) => ctx.signinUrl({ ageRange: '18+' }),
  },

  // ─── Keypair constraints ──────────────────────────────────────────────────
  {
    id: 'np-only',
    section: 'Keypair constraints',
    title: 'NP-only (accept=natural-person)',
    description: 'Forces the natural-person keypair. Persona/extra options should be hidden in the picker.',
    build: (ctx) => ctx.signinUrl({ accept: 'natural-person' }),
  },
  {
    id: 'persona-only',
    section: 'Keypair constraints',
    title: 'Persona-only (accept=persona)',
    description: 'Forces persona. Empty state should appear with "Add persona now" if none exists.',
    build: (ctx) => ctx.signinUrl({ accept: 'persona' }),
  },
  {
    id: 'persona-preferred',
    section: 'Keypair constraints',
    title: 'Persona preferred, NP allowed',
    description: 'accept=persona,natural-person + prefer=persona. Both visible; persona default-selected.',
    build: (ctx) => ctx.signinUrl({ accept: 'persona,natural-person', prefer: 'persona' }),
  },
  {
    id: 'np-with-reason',
    section: 'Keypair constraints',
    title: 'NP with explanation',
    description: 'accept=natural-person + accept_reason. The reason should render as a caption in the picker.',
    build: (ctx) => ctx.signinUrl({
      accept: 'natural-person',
      accept_reason: 'Full legal identity required for court filing',
    }),
  },

  // ─── Consumer-hint warnings ──────────────────────────────────────────────
  {
    id: 'unknown-accept',
    section: 'Consumer-hint warnings',
    title: 'Unknown accept token',
    description: 'accept=robot — parser should emit an accept-unknown:robot warning in the callback.',
    build: (ctx) => ctx.signinUrl({ accept: 'robot' }),
    tag: 'warning',
  },
  {
    id: 'prefer-not-in-allow',
    section: 'Consumer-hint warnings',
    title: 'Prefer not in allow',
    description: 'accept=persona + prefer=natural-person — inconsistent. Warning: prefer-not-in-allow.',
    build: (ctx) => ctx.signinUrl({ accept: 'persona', prefer: 'natural-person' }),
    tag: 'warning',
  },

  // ─── Expected-fail cases ─────────────────────────────────────────────────
  {
    id: 'stale-timestamp',
    section: 'Expected-fail cases',
    title: 'Stale timestamp (6 min old)',
    description: 'Should reject — Signet enforces a 5 min t= window.',
    build: (ctx) => ctx.signinUrl({}, { t: Math.floor(Date.now() / 1000) - 6 * 60 }),
    tag: 'expected-fail',
  },
  {
    id: 'origin-callback-mismatch',
    section: 'Expected-fail cases',
    title: 'Callback origin mismatches origin',
    description: 'origin=https://example.com but callback=test-harness — Signet should reject on parse.',
    build: (ctx) => ctx.signinUrl({}, { origin: 'https://example.com' }),
    tag: 'expected-fail',
  },

  // ─── NIP-46 pairing ──────────────────────────────────────────────────────
  {
    id: 'nip46-pair',
    section: 'NIP-46 pairing',
    title: 'Desktop pairing (?nostrconnect=)',
    description: 'Wraps a nostrconnect:// URI in ?nostrconnect= param — the matchpass-app desktop flow. No callback; the real app would listen on the session pubkey via relay.',
    build: (ctx) => ctx.nostrconnectUrl(fakeNostrconnect()),
  },

  // ─── Post-auth handoff ────────────────────────────────────────────────
  //
  // post= asks Signet to render an "Open <hostname> →" button on the relay-
  // ack screen after a successful cross-device approval. Validated same-
  // origin upstream. The button only renders in relay mode (cross-device);
  // in URL-redirect mode (these test-consumer scenarios) post= is parsed
  // and validated but the UI is a no-op — invalid post= still surfaces a
  // warning in the callback URL, which is observable on the callback page.
  {
    id: 'post-valid',
    section: 'Post-auth handoff',
    title: 'Valid same-origin post=',
    description: 'post= points at the test-consumer\'s own /callback.html#controller. In redirect mode the button is not rendered (no relay-ack screen); copy the URL and append &relay=wss://... to exercise the cross-device flow on a phone.',
    build: (ctx) => ctx.signinUrl({ post: ctx.origin + '/callback.html#controller' }),
  },
  {
    id: 'post-cross-origin',
    section: 'Post-auth handoff',
    title: 'Cross-origin post= (post-cross-origin warning)',
    description: 'post= points at a different origin. Signet should strip it silently and surface a post-cross-origin token in the callback warnings list.',
    build: (ctx) => ctx.signinUrl({ post: 'https://evil.example/handoff' }),
    tag: 'warning',
  },
  {
    id: 'post-invalid-scheme',
    section: 'Post-auth handoff',
    title: 'javascript: post= (post-invalid-scheme warning)',
    description: 'post= with a non-http(s) scheme. Signet should strip it and surface a post-invalid-scheme warning. Defends against the open-redirector-into-script-execution vector.',
    build: (ctx) => ctx.signinUrl({ post: 'javascript:alert(1)' }),
    tag: 'warning',
  },
];

// Expose for index.html.
window.SCENARIOS = SCENARIOS;
window.makeContext = makeContext;
