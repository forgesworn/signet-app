# Physical Mobile Smoke

Automation covers WebKit mobile layout and paste fallback, but it cannot prove that an actual iPhone camera can scan the rendered QR from another device. Before a Signet release, run this smoke on real hardware and record it with the `Physical Mobile Smoke` GitHub workflow.

Required setup:

- iPhone with Safari.
- Desktop or second phone showing `canary.trotters.cc`.
- MySignet loaded from `https://mysignet.app`.
- A reachable NostrConnect relay.

Steps:

1. Open Canary and choose Signet remote NostrConnect.
2. Confirm the QR is large enough to scan without browser zoom.
3. Scan the QR from MySignet on iPhone Safari.
4. If scanning fails, copy the NostrConnect URI shown below the QR and paste it into MySignet.
5. Approve the connection once.
6. Confirm Canary leaves the waiting state and signs in.
7. Refresh Canary and confirm the session restores.
8. Confirm a NIP-44 encrypt/decrypt round-trip succeeds after restore.

Record the result:

1. Open the MySignet `Physical Mobile Smoke` workflow.
2. Select `iPhone Safari`.
3. Mark QR scan, copy/paste fallback, NostrConnect pairing, and NIP-44 restore as `passed`.
4. Include device/browser notes if anything was marginal.

Signet release compatibility requires a recent successful physical-mobile smoke run. If the physical run fails, fix the QR/paste path before publishing Signet.
