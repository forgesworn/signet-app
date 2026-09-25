# My Signet

Identity verification app for the Signet protocol. Verify your identity once, prove claims about yourself anywhere — without revealing personal data.

Built on [Nostr](https://nostr.com/) using the [Signet Protocol](https://github.com/forgesworn/signet).

## What it does

- **Create an identity** from a BIP-39 mnemonic with dual keypairs (Natural Person + Persona)
- **Import** from existing backup words or Nostr nsec key
- **Add family members** via QR code or Signet ID — verified with directional spoken-token words
- **Get verified** by a professional (GP, solicitor, teacher) — in-person credential ceremony
- **Verify someone else** — issue two credentials (identity + anonymous persona)
- **Prove your age** to websites via QR scan — no personal data shared, only age range and tier
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

```bash
npm install
npm run dev        # starts on https://localhost:5174 (or http if no certs)
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
```

## Sign in with Signet

External websites can authenticate users via a redirect flow:

1. Website redirects to `https://mysignet.app/?auth=1&challenge={hex}&origin={url}&name={name}&callback={url}&t={timestamp}`
2. User unlocks the app and sees an approval screen showing what will be shared
3. On approve, the app signs the challenge and redirects back to `{callback}?pubkey={hex}&npub={bech32}&signature={hex}&eventId={hex}`
4. On deny, redirects to `{callback}?error=denied`

## Architecture

React 19 SPA with no router library — page state managed in `App.tsx`. All data stored client-side in IndexedDB v3 (via `idb`).

```
src/
├── lib/           — Core logic (crypto, storage, relay, QR routing, URL auth)
├── hooks/         — React hooks (identity, family, credentials, relay, connections)
├── pages/         — Full-page views (20 pages: onboarding, home, verify, settings, connections)
├── components/    — Shared UI components (QR, badges, navigation)
├── types.ts       — TypeScript interfaces
└── App.tsx        — Main app component, page routing, URL auth handler
```

## Dependencies

- `signet-protocol` — Protocol library (nsec-tree key derivation, credentials, badges, Shamir)
- `spoken-token` — Directional word verification for Signet Me
- `@noble/curves` + `@noble/hashes` + `@noble/ciphers` — Cryptographic primitives
- `idb` — IndexedDB wrapper
- `qrcode` + `html5-qrcode` + `jsqr` — QR generation and scanning

## Known limitations

- PIN lockout state is stored in localStorage. An attacker with device-level access could clear it to bypass rate limiting. This is defense-in-depth — the primary protection is AES-256-GCM decryption which requires the correct PIN regardless of lockout state.
- Auth responses and credentials published to relays are not NIP-44 encrypted (architectural design decision pending).
- Identity documents and stored credentials in IndexedDB are not encrypted at rest (encryption key threading design decision pending).

## License

MIT
