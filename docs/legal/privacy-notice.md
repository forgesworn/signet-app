# MySignet privacy information

> **REPOSITORY DRAFT — 23 October 2026. Unadopted; not legal advice; not reviewed by a lawyer.** Application 0.22.1, commit `335e1f6615f7db6fbcd8b5b5dfa9fdb6d0113667`; [current evidence](evidence.md).

## Scope and contact

This covers the publisher's static website, downloads, update checks and ordinary contact handling. It also explains where the software directs your device. Local processing and user-chosen services are not all presumed to be controlled by the publisher. There is no separate operating legal entity.

[DECISION: identify the applicable controller and a working private contact route for actual publisher processing. No company or natural-person identity is inferred; the inbox remains unsupplied.]

## Website requests and retention

Cloudflare and the Hetzner origin process requests needed to deliver pages, software and update information. Metadata can include IP address, headers, path, query and timing. The inspected origin is in Helsinki, Finland; Cloudflare processes internationally, so the whole delivery chain is not described as EU-only.

Routine origin access logging is disabled for the inspected MySignet/Lite routes, including redirects. Earlier redirect entries included URLs/query strings with masked addresses; the shared journal is configured for three days and historical entries were not deleted. Other error/platform logs and backups may differ. Cloudflare Web Analytics is disabled; delivery/security processing remains. HTTPS is enforced. Provider retention has no verified universal duration. See the [provider review](evidence.md#hosting-and-network-processing) for current contracts and remaining account/retention limits.
<!-- deploy/mysignet-privacy.Caddyfile:3-15; src/lib/app-update.ts:30; evidence.md#hosting-and-network-processing -->

[DECISION: adopt a hosting/security basis after assessing actual processing; legitimate interests is an unadopted candidate, with logging/analytics minimised. For voluntary support, legitimate interests is also a candidate; specific rights/complaint obligations need their actual applicable basis.]

[INPUT: finish the relevant provider/account, retention and transfer assessment, accurately disclosing any remaining limits.]

## Your device and sharing

The app stores identities, contacts, documents, credentials, permissions and preferences on your device. Private keys/mnemonics and selected sensitive records are encrypted at rest; public/routing fields may remain readable. Offline assets use a service worker/cache. Android declares system backup disabled. A bounded first visit observed database/cache creation and no cookies; that is not a universal no-cookie claim. Local signing can decrypt; a chosen remote signer, NIP-07 extension or guardian signer can receive encryption inputs and perform decryption instead. The publisher is not presumed to operate your signer.
<!-- src/lib/db.ts:45-77,388-459; src/sw.ts:9-19; android/app/src/main/AndroidManifest.xml:4; src/lib/signing-backend.ts:142-183,875-905; src/lib/heartwood-vault.ts:129-135 -->

## Network recipients

| Destination | Trigger and information |
|---|---|
| `relay.primal.net`, `relay.damus.io`, `relay.ditto.pub` and configured relays | A fresh visit connected to `relay.primal.net` before onboarding. Enabled exchanges disclose connection metadata, queries, keys and signed events/envelopes. Public profiles are readable; encrypted backups still have metadata. |
| `nostr.oxtr.dev`, `purplepag.es` and lookup relays | Authentication fallback/profile lookup discloses connection metadata and queried/routing keys. |
| `nostr.download` or chosen Blossom host | Enabled uploads send bytes, hashes and signed authorisation. Public photos are readable; private/contact-picture backup paths encrypt bytes. Upload permission defaults off. |
| NIP-05 domains, image hosts and organisation websites | Name/profile/professional checks request names, image URLs or `.well-known/signet.json`. Explicit contact-picture refresh/import omits credentials/referrer and rejects redirects. |
| `api.cqc.org.uk`, `dfe-digital.github.io`, optional `sra-prod-apim.developer.azure-api.net`/mirror | Professional lookup sends provider/URN/firm identifiers; direct SRA adds its configured API key. Optional mirror configuration does not establish a publisher-operated mirror. |
| Chosen signer/consumer/callback hosts | Pairing, signing and approved sharing send the relevant requested payloads; callback status may reveal approval/denial. |
| `mysignet.app` | Downloads and APK update checks process metadata described above. |

<!-- src/lib/relay-defaults.ts:5-14; src/App.tsx:439-444; src/lib/existing-profile.ts:35-39; src/lib/blossom.ts:27,83-119; src/hooks/usePreferences.ts:317; src/lib/contact-picture-backup.ts:83-98; src/lib/nip05-check.ts:81,143; src/lib/picture-download.ts:76-82; src/lib/professional/resolvers/cqc.ts:47-48; src/lib/professional/resolvers/gias.ts:13,39-41; src/lib/professional/resolvers/sra.ts:59-74; src/lib/professional/signet-json.ts:186-191,258-268; src/lib/nostrconnect-callback.ts:38-83; evidence.md#device-data-and-recipients -->

Guardian/under-18 features exist. A verifier intentionally sees details you show, including name, DOB and document information; this differs from sharing an approved age-range proof. No minimum age or assurance qualification is declared here. Public events/photos and remote copies may persist after local deletion; signed Blossom deletion does not guarantee every replica is erased.
<!-- src/pages/AddDependant.tsx:83-103; src/pages/VerifySomeone.tsx:200-210,409-424; src/pages/ApproveVerification.tsx:182-186; src/lib/db.ts:2599; src/lib/blossom.ts:159-189 -->

General ForgeSworn donations are separate; no automatic app contact with those channels or Signet-specific paid service is established. Other outbound links are user-click destinations.

## Contact and rights

Use the contact route above once adopted. Where applicable, you may request access, correction, erasure, restriction or portability, object to processing, withdraw consent where relied on, and complain to the controller or ICO. The proposed complaint procedure acknowledges within 30 days and responds without undue delay `[S]`; no monitoring promise is adopted while the inbox is blank. Do not send keys, recovery words or identity-document scans to support.

Law: [GB note 3–4](https://github.com/forgesworn/jurisdiction-kit/blob/bf74b72ecd897ae88e87163a2a47c55b102012bd/law/gb/online-services.md#31-when-you-are-a-controller), verified 28 September 2026 with relevant partial updates 22–23 October; Article 13 information requirements `[P]`, distributed-role/storage-exception applications `[U]`. More extensive policies require a concrete change in actual processing or service scope; they are not imposed by these publisher drafts.
