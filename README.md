# My Signet

Identity verification app for the Signet protocol. Verify your identity, then share proofs with sites and services while choosing which information to disclose.

Built on [Nostr](https://nostr.com/) using the [Signet Protocol](https://github.com/forgesworn/signet).

## What it does

- **Create an identity** from a BIP-39 mnemonic with dual keypairs (Natural Person + Persona)
- **Import** from existing backup words or Nostr nsec key
- **Add family members** via QR code or Signet ID — verified with directional spoken-token words
- **Get verified** by a professional (GP, solicitor, teacher) — in-person credential ceremony
- **Verify someone else** — issue two credentials (identity + anonymous persona)
- **Prove your age** to websites via QR scan — share age range and tier without including your date of birth or document details in the age proof
- **Sign in with Signet** — websites redirect to mysignet.app, user approves, redirected back with cryptographic proof
- **Log in** to Nostr apps via NIP-46 remote signing
- **Sign for Android apps** on the same phone as a NIP-55 signer: Amethyst, KithMoot and anything Amber-shaped find "My Signet" in their signer list, ask once, and can be allowed always. Settings → Connected Sites lists them under "Apps on this phone", where an allow-always is taken back. For five minutes after serving one, My Signet keeps its key while hidden behind that app, so an allowed-always app signs without a PIN each time
- **Back up** via Shamir secret sharing (2-of-3)
- **Manage connections** — view and revoke sites you've signed in to

## Security

- Private keys encrypted at rest with AES-256-GCM (PBKDF2 600k iterations)
- WebAuthn biometric auth with PRF extension (hardware-derived keys where supported)
- PIN fallback with brute-force lockout (30s → 5m → 1h)
- Auto-lock on inactivity (15 min) and tab switch (with 60s grace during active verification)
- All relay events are signed NIP-01 events
- Content Security Policy — no unsafe-eval, no unsafe-inline scripts
- Relay URL validation — `wss://` required for production, `ws://` only for localhost
- QR input validation — hex format, timestamp freshness, origin-callback matching, max payload size
- URL auth validation — required timestamps, origin scheme enforcement, callback origin matching
- Sensitive data auto-hidden after 90 seconds (mnemonic, Shamir shares)
- Clipboard auto-cleared after 60 seconds
- NIP-44 key material zeroized after use
- No console output in production code
- Three-round security audit completed (April 2026)

## Quick start

Prerequisite: Node.js 24, which is what CI runs. The tightest declared floor in
the toolchain is jsdom 30's `^22.22.2 || ^24.15.0 || >=26`; Vitest 5, Capacitor
CLI 8 and nsec-tree also need Node 22 or later. `engines` in package.json
states that jsdom range.

```bash
git clone https://github.com/forgesworn/signet-app.git
cd signet-app
npm install
npm run dev        # starts on https://localhost:5174 (or http if no certs)
```

`@forgesworn/signet-contacts` is installed from a pinned GitHub commit, so
`npm install` needs git access to github.com. If npm resolves it to an SSH URL
and you have no key, route it over HTTPS first (this is what CI does):

```bash
git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
```

For HTTPS (required for WebAuthn on non-localhost):

```bash
mkdir cert
# Generate self-signed cert:
mkcert -key-file cert/signet-key.pem -cert-file cert/signet.pem localhost
npm run dev
```

## Build

```bash
npm run build      # outputs to dist/
npm run preview    # preview production build
npm run typecheck  # TypeScript type checking
npm test           # unit tests (Vitest)
```

### Android

The Android app wraps the same web build with Capacitor (application ID
`app.mysignet`, minSdk 24). There is no npm script for it. You need JDK 21 and
the Android SDK (compileSdk 36). From the repository root:

```bash
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk (signed with the local debug key)
```

`npx cap open android` opens the project in Android Studio instead. For a
signed release build (`./gradlew assembleRelease`), see
[android/RELEASE_SIGNING.md](android/RELEASE_SIGNING.md).

## Sign in with Signet

For the combined sign-in and online-play flow, wire examples, verification,
NIP-46 permission scopes and backwards compatibility, see the
[app integration guide](docs/app-integration.md), which is in this repository.
Support depends on the installed My Signet version, so keep the legacy
fallback: older versions, renewals and people who choose online play later use
the separate `?action=app-permission&permission=online-play` flow, which asks
for the online-play statement on its own and answers with a
`signet-app-permission-response` instead of a sign-in answer (the guide's
"Fallback for a persona already signed in" section has its parameters).

External websites can authenticate users via a redirect flow:

1. Website redirects to `https://mysignet.app/?auth=1&challenge={hex}&origin={url}&name={name}&callback={url}&t={timestamp}`
2. User unlocks the app and sees an approval screen showing what will be shared
3. On approve, the app signs the challenge and redirects back to `{callback}?pubkey={hex}&npub={bech32}&signature={hex}&eventId={hex}&t={created_at}`
4. On deny, redirects to `{callback}?error=denied`

Request parameters:

- `challenge`: 64 hex characters, 32 fresh random bytes per attempt
- `origin`: `https://` origin of your site (`http://localhost` or `http://127.0.0.1` for development)
- `callback`: a URL on exactly that origin
- `name`: your site's display name, 1 to 64 characters
- `t`: request time in Unix seconds. My Signet ignores the request if it differs from the phone's clock by more than 300 seconds
- optional `relay` (`wss://`, or `ws://localhost` for development) with `sessionPubkey` (64 hex): both or neither. They switch to cross-device relay delivery, where the answer is a gift wrap on your relay instead of a redirect

Build the URL with `URLSearchParams` or `encodeURIComponent` so each value is
percent-encoded.

### Verifying the response

My Signet signs one Nostr event and returns its parts in the callback query.
The event is kind 21236 with empty `content` and these tags, in this order:

```text
["challenge", <your challenge>]
["origin", <the exact origin string you sent>]
["avatar_hash", ...], ["avatar_url", ...], ["avatar_key", ...]   (only if the person shared a persona picture)
```

Redirect mode adds no `app` tag. Tag order is part of the event ID, so rebuild
the tags exactly as above. The callback carries:

- `pubkey`: signer's x-only public key, 64 hex characters
- `npub`: bech32 form of `pubkey`
- `signature`: BIP-340 Schnorr signature, 128 hex characters
- `eventId`: NIP-01 event ID, the SHA-256 of `[0, pubkey, created_at, 21236, tags, ""]` as JSON, 64 hex characters
- `t`: the signed event's `created_at` in Unix seconds, not milliseconds. It reuses the name of the request's `t` but is a different value, and you need it to rebuild the event
- optional: `display_name` and `warnings` (comma-separated tokens), `fromNP=true`, `bunker`, `app_permission` (see the integration guide) and `avatar_hash`, `avatar_url`, `avatar_key`. Treat all of them as untrusted until the signature checks out

`eventId` is the hash of the rebuilt event and `signature` is the Schnorr
signature over that hash, so one check of the rebuilt event covers both. Accept
the response only if the event rebuilt from your own stored `challenge` and
`origin` verifies, and `t` is within 300 seconds of now (the same window as
`AUTH_FRESHNESS_WINDOW_SEC` in `signet-verify`). Keep each challenge to one
attempt and discard it once used. Callback values are ordinary percent-encoded
query values; read them with `URLSearchParams`. Parameters already on your
callback URL are kept, and a response parameter with the same name replaces
yours.

```js
import { verifyEvent } from 'nostr-tools/pure';

// `sent` is what you stored for this attempt: { challenge, origin }
function verifySignInCallback(callbackUrl, sent) {
  const q = new URL(callbackUrl).searchParams;
  if (q.get('error')) return { ok: false, reason: q.get('error') }; // 'denied'
  const pubkey = q.get('pubkey'), eventId = q.get('eventId'), sig = q.get('signature');
  const createdAt = Number(q.get('t'));
  if (!pubkey || !eventId || !sig || !Number.isInteger(createdAt)) return { ok: false, reason: 'missing-params' };
  if (Math.abs(Date.now() / 1000 - createdAt) > 300) return { ok: false, reason: 'stale' };
  const tags = [['challenge', sent.challenge], ['origin', sent.origin]];
  const hash = q.get('avatar_hash'), url = q.get('avatar_url'), key = q.get('avatar_key');
  if (hash && url && key) tags.push(['avatar_hash', hash], ['avatar_url', url], ['avatar_key', key]);
  const event = { id: eventId, pubkey, created_at: createdAt, kind: 21236, tags, content: '', sig };
  // verifyEvent recomputes the ID from the event, compares it with `id`, then checks the signature
  if (!verifyEvent(event)) return { ok: false, reason: 'bad-signature' };
  return { ok: true, pubkey };
}
```

Error codes: for sign-in the only `error` value is `denied`, sent with no
signature parameters. My Signet does not redirect for a request it rejects (a
bad challenge, an origin that is not `https://`, a callback on another origin,
a `t` outside the 300-second window or an invalid `app_permission`), so give
every attempt your own timeout. The codes `invalid_request`, `stale_request` and
`create_failed` belong to `?action=add-dependant`, not to sign-in.

In relay mode the answer is a NIP-59 gift wrap carrying the whole signed event
as `authEvent`, with an extra `["app", <name>]` tag. Use the `signet-verify`
package's `waitForAuthResponse` for that: it unwraps, checks the event, the
origin and the freshness window, and rejects with `denied`, `timeout`,
`expired` and other codes. It is a relay-mode helper, not a redirect-callback
verifier. It is a devDependency in this repository and nothing in `src/`
imports it.

## Relay defaults and failover

Fresh installs use `wss://relay.primal.net` (primary), `wss://relay.damus.io`
and `wss://relay.ditto.pub` for reads and writes. Authentication fallback also
uses `wss://nostr.oxtr.dev`. nos.lol, which
stopped answering in October 2026, and an earlier default are retired from the
defaults and migrated out of saved app relay settings.

Sync uses the full configured pool. Writes succeed on the first relay
acknowledgement while the other deliveries continue; network operations have
time limits. Sync reads merge completed replies and retain author checks;
a stalled read does not count as proof that no backup exists. The primary
connection fails over and reconnects with backoff after a drop. Disabled
relays and read-only choices remain respected.

Apps should supply their relay in sign-in/permission requests rather than
assuming My Signet's primary. Existing paired-device endpoints and historical
event locations retain their explicit addresses. Browser development adds
`ws://localhost:7777`; native Android uses the public defaults.

## Architecture

React 19 SPA with no router library: page state managed in `App.tsx`. All data stored client-side in IndexedDB, schema version 27 (`DB_VERSION` in `src/lib/db.ts`, via `idb`).

```
src/
├── lib/           — Core logic (crypto, storage, relay, QR routing, URL auth)
├── hooks/         — React hooks (identity, family, credentials, relay, connections)
├── pages/         — Full-page views (about 70 page components: onboarding, home, verify, contacts, settings, connections)
├── components/    — Shared UI components (QR, badges, navigation)
├── types/         — TypeScript interfaces (`routing.ts` holds the `Page` union)
└── App.tsx        — Main app component, page routing, URL auth handler
```

## Dependencies

Runtime dependencies, from `package.json`:

- `react` + `react-dom` (19): UI
- `signet-protocol`: Protocol library (credentials, badges, URL auth parsing and callback building, relay events). The app derives personas with `nsec-tree` and splits backups with `@forgesworn/shamir-words` directly (`src/lib/signet.ts`)
- `nsec-tree`: Deterministic Nostr sub-identity (persona) derivation from the mnemonic
- `@forgesworn/shamir-words`: Shamir secret sharing with BIP-39 word encoding, for the 2-of-3 backup
- `nostr-tools`: Nostr event signing and verification, relay pool, and the NIP-19, NIP-44, NIP-46 and NIP-59 helpers
- `@forgesworn/kenspeckle`: Kin, kith and ken relationship model with handshake and bond ceremonies
- `@forgesworn/signet-contacts`: Contacts v2 wire (capability-scoped pairing and grants), installed from a pinned GitHub commit
- `@forgesworn/tessera-kit`: Privacy-preserving membership-presence filter (declared directly; `src/` does not import it)
- `spoken-token`: Time-rotating spoken verification words (declared directly; `src/` does not import it, and `vite.config.ts` pre-bundles it)
- `@noble/curves` + `@noble/hashes` + `@noble/ciphers`: Cryptographic primitives
- `idb`: IndexedDB wrapper
- `qrcode` + `html5-qrcode` + `jsqr`: QR generation and scanning
- `@capacitor/core`, `@capacitor/app`, `@capacitor/local-notifications`, `@capacitor/android`: Android shell, app lifecycle and local notifications
- `@fontsource-variable/inter`, `@fontsource-variable/playfair-display`, `@fontsource-variable/geist-mono`: Bundled fonts

Build and test tooling (`devDependencies`): Vite 8 with `@vitejs/plugin-react` and `vite-plugin-pwa`, TypeScript 6, Vitest 5 with Testing Library, jsdom and `fake-indexeddb`, Playwright, `@capacitor/cli` and `@capacitor/assets`, and `signet-verify` (not imported by `src/`).

## Known limitations

- PIN lockout state is stored in localStorage. An attacker with device-level access could clear it to bypass rate limiting. This is defense-in-depth — the primary protection is AES-256-GCM decryption which requires the correct PIN regardless of lockout state.
- Auth responses and credentials published to relays are not NIP-44 encrypted (architectural design decision pending).
- Identity documents and stored credentials in IndexedDB are not encrypted at rest (encryption key threading design decision pending).

## License

MIT

## Publisher information

The [publisher information pack](docs/legal/README.md) records the software and hosting scope, privacy disclosures and remaining owner decisions. These are review drafts; they are not adopted website policies.
