# Publisher evidence summary

**Repository review record — 23 October 2026. Not an adopted privacy policy or legal advice; not reviewed by a lawyer.** Application baseline: 0.22.1, `335e1f6615f7db6fbcd8b5b5dfa9fdb6d0113667`. Observations are dated and bounded; they do not establish a blanket OSA exclusion or universal absence of logs, cookies or third-party processing.

## Application and delivery

[PR #51](https://github.com/forgesworn/signet-app/pull/51) removed stale generated publisher destinations and corrected disclosure copy. Professional JSON now uses enabled publishing relays and blocks completion without one; badge embeds are inline SVG snapshots with a Nostr identity link rather than a hosted image service. Previously exported copies and old installations need their own update.

[Release 0.22.1](https://github.com/forgesworn/signet-app/releases/tag/v0.22.1) is published. Its [release deployment](https://github.com/forgesworn/signet-app/actions/runs/39981487090) passed 7,188 unit tests, conformance, browser regressions and production Canary. Independent readback matched both public APK URLs to the release manifest and verified the expected Android signature/version. The live web bundle identified that release commit at the time of the check. Physical-device installation/upgrade acceptance was not performed.

Source: `src/pages/ProOnboarding.tsx`, `src/lib/relay-service.ts`, `src/lib/badge-embed.ts`, `src/pages/BadgeEmbed.tsx`, `scripts/release.sh`, `.github/workflows/deploy.yml`.

## Hosting and network processing

The inspected MySignet/Lite origin routes serve static files and updates without an upload handler or application proxy. Cloudflare fronts a Hetzner origin. Provider metadata identifies the origin location as Helsinki, Finland; [Hetzner's location reference](https://docs.hetzner.com/cloud/general/locations/) maps the location designation. This does not locate every backup, support copy or independent service.

Routine access logging is disabled on the inspected app HTTPS routes and HTTP redirects. Earlier redirect entries included request URLs/query strings with masked addresses. The shared journal has a three-day retention configuration; historical entries were not deleted. Other error/platform logs, provider systems and backups remain separately bounded. The public [Caddy supplement](../../deploy/mysignet-privacy.Caddyfile) and [deployment notes](../../deploy/README.md) describe the targeted redirect change.

Authenticated configuration readback confirmed Cloudflare Web Analytics disabled, Always Use HTTPS enabled and origin TLS Full (strict). Public HTTPS checks passed. No universal zero-retention claim follows. Cloudflare's [self-service agreement](https://www.cloudflare.com/terms/) incorporates a customer DPA; the [DPA](https://www.cloudflare.com/cloudflare-customer-dpa/) describes international transfer arrangements. Its [privacy policy](https://www.cloudflare.com/privacypolicy/) gives purpose/legal-need retention criteria rather than one visitor-log duration. [Hetzner's guidance](https://docs.hetzner.com/general/company-and-policy/data-protection-at-hetzner/) describes its account DPA process; this review does not establish a concluded account agreement. Relevant account terms, additional logs, backups and transfer application remain inputs.

## Device data and recipients

A fresh isolated Chrome visit on 23 October observed HTTP requests including service-worker requests and page WebSocket destinations for ten seconds after network idle. All 70 observed HTTP requests went to MySignet; a Primal relay connection opened before onboarding. IndexedDB and an offline asset cache were created. No cookies, local-storage keys or session-storage keys were present at the observation point. No credentials, user proofs, onboarding or uploads were supplied. Request payloads and query values were not recorded.

This was a first-visit observation, not an existing-user, optional-feature, Android or all-regions audit. It does not override conditional edge behaviour or establish provider retention.

The [privacy draft](privacy-notice.md#network-recipients) lists default and feature-triggered recipients, including configurable relays, Blossom, profile/name/image hosts, professional registries and chosen signers/consumers. Source locations accompany the table. Device and remote-signer capabilities differ; publishing the software does not establish receipt/control of every user's documents.

Source: `src/lib/db.ts`, `src/sw.ts`, `src/lib/signing-backend.ts`, `src/lib/heartwood-vault.ts`, `src/lib/relay-defaults.ts`, `src/lib/blossom.ts`, `src/lib/professional/resolvers/`, `src/lib/app-update.ts`.

## Scope and limits

The owner reports that a separately operated relay serves only their own identities, devices and automations; it is assessed separately from the public software. This purpose statement is not an audit of all correspondents or a concluded statutory exemption. Operational details of that personal deployment are outside this public summary.

The owner confirms there is no separate operating legal entity. Signet is free; donations through Geyser, Ko-fi, GitHub and Lightning support ForgeSworn generally. No paid access, paid verification or Signet-specific allocation was established. Channel names do not establish automatic app contact or receipt of particular donor records.

The controller/contact and publisher-processing basis remain unadopted, along with relevant provider and ordinary received-message retention arrangements. No address, legal identity, minimum age, paid-service contract or OSA reporting programme is created by these drafts. The app's child/guardian features do not establish that the publisher receives children's documents. Reassess changed processing, hosted services or assurance claims on their actual facts.

Detailed local operational evidence is intentionally excluded from publication. This summary retains the relevant findings without account identifiers, private log extracts or personal-endpoint access details. The [remaining inputs](open-items.md) identify the current draft's limits.
