# Relay ordering, live status and KithMoot compatibility

Advanced relay settings now provide Move up/down controls. Order is saved
through the existing preferences path, preserving enabled/read/write flags.
The first enabled write relay is labelled Preferred primary. A live fallback
connection can use a different relay.

App connection observes existing relay-service clients once a second while
the panel is mounted. It neither opens sockets nor registers over the SDK's
single state listener. Reachability remains a separate dated connection/read
check; a successful check does not imply a live app socket or accepted write.

The relay controls and status labels passed 78 focused unit/hook/preferences
checks and typechecking. Tests verify live-state changes independently of a
successful earlier reachability check, persistence across remount, primary
selection and preservation of read-only flags.
The browser relay test also passed: live connection, successful/restricted/
unavailable read checks, reordered primary, reload persistence and 320 px
with 200% text. Power Mode is enabled again after reload because it is a
session-only UI preference.

## Actual KithMoot integration

Run with a sibling KithMoot checkout and its dependencies installed:

```sh
KITHMOOT_REPO_PATH=/path/to/kithmoot npx playwright test --config playwright.kithmoot.config.ts
```

The opt-in configuration starts isolated local Signet and KithMoot desktop
renderer servers and a local Nostr relay. All identities are disposable and
public relay sockets are blocked. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` may
select an already-installed compatible Chromium binary.

Both actual-app cases passed: signing enabled completes approval, encrypted
response delivery, NIP-46 connection and a room join; signing off completes
identity approval and KithMoot displays its missing-signing explanation.

An earlier run stalled at Signet "Signing…" with KithMoot waiting for approval.
Later runs passed without a change to the handoff implementation. The field
report's cause is therefore still unproven. These checks do not establish
physical-device, packaged-desktop or public-relay acceptance.
