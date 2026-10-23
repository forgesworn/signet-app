# MySignet software-publisher position

> **REPOSITORY DRAFT — 23 October 2026. Unadopted; not legal advice; not reviewed by a lawyer.** Application 0.22.1, commit `335e1f6615f7db6fbcd8b5b5dfa9fdb6d0113667`; [delivery/hosting evidence](evidence.md).

## Public software and hosting

MySignet publishes browser/Android identity and signing software. The inspected MySignet/Lite origin routes serve static files and updates, without an application proxy or upload handler. Public relay and storage defaults point to independently operated services; users can configure them. The client supports public events, credentials, contact exchange and encrypted backups, but those features do not establish that the publisher hosts every exchange or controls admission to the underlying services.
<!-- .github/workflows/deploy.yml:174-194; src/lib/relay-defaults.ts:5-14; src/lib/blossom.ts:27; src/lib/private-vault-publish.ts:44-55; evidence.md#hosting-and-network-processing -->

The working assessment is **software publisher with defaults and static hosting**, rather than an established public user-to-user operator. Provider/control and service-scope tests have primary statutory support `[P]`; applying them to distributed software/defaults remains `[U]` under [note 2.1–2.2](https://github.com/forgesworn/jurisdiction-kit/blob/bf74b72ecd897ae88e87163a2a47c55b102012bd/law/gb/online-services.md#21-scope). This is not a guarantee of OSA exclusion. Static hosting also has its own proportionate privacy considerations, described in the [short privacy draft](privacy-notice.md).

## Separate owner-use relay

The owner separately runs a relay for their own identities, devices and automations, rather than offering public managed relay access through MySignet. The purpose is owner-supplied and does not establish a blanket statutory exclusion. Assess this endpoint separately under [2.10–2.11](https://github.com/forgesworn/jurisdiction-kit/blob/bf74b72ecd897ae88e87163a2a47c55b102012bd/law/gb/online-services.md#210-closed-and-personal-services), whose personal-endpoint application remains `[U]`. A public app does not by itself turn every personal endpoint into a public managed service.
<!-- src/lib/relay-defaults.ts:21-41; evidence.md#scope-and-limits -->

## Funding and changes requiring review

The owner confirms no separate legal entity operates MySignet. Signet is free; general ForgeSworn donations through Geyser, Ko-fi, GitHub and Lightning do not establish paid access, paid verification or a Signet-specific allocation. No automatic app contact with donation channels is established. No entity, sole-trader status or natural-person identity is supplied here. Donation/economic-activity application is separately `[U]` in [8.1](https://github.com/forgesworn/jurisdiction-kit/blob/bf74b72ecd897ae88e87163a2a47c55b102012bd/law/gb/online-services.md#81-donations).

Revisit this position before adding project-operated public relays/storage/signers, hosted discovery or managed accounts, extending the personal relay to serve others, or offering paid/guaranteed verification. Existing client discovery is already part of the assessment. No separate OSA assessments/reporting programme is prescribed by these drafts without first establishing the regulated-service role.

The MIT licence remains the software licence (`LICENSE:5`–21); no paid-service contract is invented. More extensive terms or assurance policies need a concrete changed offering, not merely public availability. Consumer/assurance questions outside the note remain outside this bounded conclusion.

[INPUT: resolve the controller/contact role for actual hosting/contact processing before adopting the privacy draft; the inbox remains unsupplied.]

Law: [GB note](https://github.com/forgesworn/jurisdiction-kit/blob/bf74b72ecd897ae88e87163a2a47c55b102012bd/law/gb/online-services.md), headline verified 28 September 2026, relevant partial updates 22–23 October; review by 28 March 2027. Optional targeted advice is useful only where an unresolved application would change the chosen operation.
