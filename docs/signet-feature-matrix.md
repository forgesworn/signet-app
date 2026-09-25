# Signet Feature Matrix

MySignet is the reference signer app for Signet Access. A feature is considered production-ready for MySignet only when the user-facing signer behavior is covered by an automated gate, or when the feature is explicitly out of scope for a signer app.

Signet Lite is a second, lean NIP-46 signer in the family (a PWA bunker at `lite.mysignet.app`). It is included here as a named signer target. Lite is a NIP-46 server only — it has no NIP-07, NIP-55, or Signet remote-QR surface — so several rows are N/A for it; the rows it covers are proven by its own automated tests (referenced via external gates in the manifest).

The enforced source for this table is `conformance/signet-feature-conformance.json`; CI runs `npm run check:signet-conformance` so required signer features cannot be removed without a mapped regression gate.

Status key:

- **Covered**: implemented and guarded by automated tests.
- **SDK covered**: covered in `signet-login`, but not a MySignet responsibility.
- **N/A**: not a responsibility of that project.
- **Gap**: expected but not yet covered.

| Feature | signet-login SDK | Canary reference consumer | MySignet signer app | Signet Lite signer | Required gate |
| --- | --- | --- | --- | --- | --- |
| NIP-07 browser extension | Covered by SDK signer tests. | Covered by Canary adapter tests. | N/A. MySignet serves signer requests rather than consuming `window.nostr`. | N/A. Lite is a NIP-46 bunker, not a browser extension. | Keep SDK and Canary conformance gates green. |
| Amber / NIP-55 | SDK covered as Android auth-only. | SDK covered, not exposed as a full Canary signer. | Covered. The Android APK answers `nostrsigner:` intents and the `app.mysignet.*` content-provider authorities as a NIP-55 signer, under Cambium's decision table: `src/lib/nip55.test.ts`, `src/hooks/useNip55Server.test.tsx`, `android/app/src/test/java/app/mysignet/Nip55WireTest.kt`. Physical-device acceptance against Amethyst and KithMoot passed on a real Android handset: sign-in, then a user-initiated signature answered under allow-always after an unlock. After serving a phone app the key is held for five minutes while hidden (`PHONE_APPS_WINDOW_MS` in `src/App.tsx`), so allow-always means no PIN per signature. Remains a release check. | N/A. Lite has no NIP-55 surface. | Keep SDK Amber tests green; keep the NIP-55 unit gates green. |
| Signet remote QR | Covered by SDK modal/device tests and callback persistence tests. | Covered by Canary live and protocol tests. | Covered by URL auth, QR/paste verification, and WebKit mobile regression tests. | N/A. Lite is a generic NIP-46 signer, not a Signet remote-QR sign-in signer. | `e2e/auth.spec.ts`, `e2e/verification.spec.ts`, `npm run test:e2e:webkit`. |
| NostrConnect | Covered by SDK NostrConnect modal/status tests and NIP-46 restore E2E. | Covered by Chromium, WebKit, and cross-app tests. | Covered by approve-connect, NIP-46 connect response, and cross-app Canary tests. | Covered. `signet-lite` proves the connect handshake and method contract via `src/engine/signer.signet-login-conformance.test.ts` plus `e2e/nostrconnect-full.spec.ts`. | `e2e/approve-connect.spec.ts`, `src/lib/nip46.connect-response.test.ts`, `npm run test:e2e:cross-app`. |
| bunker restore | Covered by SDK NIP-46 restore E2E. | Covered by Canary reload and NIP-44 round-trip. | Covered by persisted NostrConnect approval and cross-app restore tests. | Covered. `signet-lite` `e2e/bunker-full.spec.ts` connects a real BunkerSigner over a relay and proves connections survive lock/unlock. | `src/hooks/useBunkerServer.nostrconnect.test.tsx`, `e2e/cross-app-nostrconnect.spec.ts`. |
| nsec fallback | Covered by SDK local signer tests. | Covered by Canary protocol E2E. | N/A. MySignet owns local identity storage and recovery; it does not expose the app-side nsec fallback. | N/A. Lite is a self-contained signer, not a signet-login consumer with an nsec escape hatch. | Keep Canary protocol coverage green. |
| storage/session restore | Covered by SDK storage and restore tests. | Covered by Canary persisted bunker restore. | Covered by DB/session and lock/unlock regression tests. | Covered. `signet-lite` `e2e/bunker-full.spec.ts` proves authorised connections persist across lock/unlock. | `src/lib/db.test.ts`, `e2e/lock-unlock.spec.ts`. |
| logout/clear state | Covered by SDK logout tests. | Covered by Canary adapter logout tests. | Covered by auth connection revoke and auth-state tests. | N/A. Lite does not implement the NIP-46 `logout` method (out of its advertised surface); state is cleared locally via Delete signet. | `e2e/auth.spec.ts`, `src/lib/auth.test.ts`. |
| NIP-44 present/missing behavior | Covered by SDK NIP-07/local/bunker signer tests. | Covered by Canary adapter rejection and NIP-44 E2E. | Covered by MySignet bunker server allow/deny tests. | Covered. `signet-lite` `src/engine/signer.signet-login-conformance.test.ts` proves a NIP-44 encrypt/decrypt round-trip and that `nip04`/`logout` are absent from the advertised methods. | `src/hooks/useBunkerServer.nostrconnect.test.tsx`, `src/lib/nip46-server.test.ts`. |
| timeout/abort/error diagnostics | Covered by SDK NostrConnect status tests. | Covered by Canary diagnostics panel E2E. | Covered by approve-connect relay fallback and relay-by-relay diagnostics. | Gap. Lite has no diagnostics panel. | `e2e/approve-connect.spec.ts`. |
| mobile copy/paste fallback | Covered by SDK NostrConnect QR/URI copy tests. | Covered by Canary WebKit/mobile tests. | Covered by WebKit QR/paste tests and the physical iPhone smoke record. | N/A as a consumer fallback. Lite as a signer offers both a copy/paste `bunker://` link and `nostrconnect://` QR scanning. | `e2e/verification.spec.ts`, `npm run test:e2e:webkit`, `.github/workflows/physical-mobile-smoke.yml`. |

Current hard gates:

- MySignet deploy CI fails if the conformance manifest references a missing test, script, or workflow gate.
- MySignet non-deploy Signet compatibility can be triggered by `signet-login` release.
- Cross-app Canary NostrConnect verifies pair, approve, reload, restore, and NIP-44 round-trip.
- WebKit mobile QR/paste remains a required automated regression.
- Physical iPhone Safari QR scanning is recorded through the manual physical-mobile smoke workflow before Signet releases.
- Signet Lite signer conformance is proven in the `signet-lite` repo (`src/engine/signer.signet-login-conformance.test.ts` + bunker/nostrconnect E2E); the manifest references it via external gates. The `signetLite` column is structurally validated by `check:signet-conformance`, so a malformed status fails CI.

Known decision:

- Amber is SDK-supported and auth-only. MySignet does not implement Amber, and Canary should not expose Amber as a full signer path unless a live signer/NIP-44 handoff exists.
- Signet Lite is a NIP-46-only signer: `nip04` and the NIP-46 `logout` method are intentionally not in its advertised surface (it returns "unsupported method"), and `switch_relays` returns JSON `null` to match MySignet. signet-login's client handles all three correctly.
