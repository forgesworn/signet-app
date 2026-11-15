# Encrypted imported-account backup preview

This preview pins the published `nsec-tree@1.7.0-alpha.1` alpha. Its lockfile
records the integrity verified against the npm tarball and the reproducible
GitHub release. Stable nsec-tree `latest` remains 1.6.0. The alpha format has
not had independent security review; use disposable test keys and retain an
independent backup.

The format, dependency artifact and cross-repository handover are in the
sibling nsec-tree checkout's `WRAPPED-NSEC.md` and
`WRAPPED-PREVIEW-HANDOVER.md`. This feature adds no relay upload or private
profile sync. Restoring requires the owner's original root and the encrypted
file; the account remains imported and keeps its exact npub. Existing raw-key
recovery words remain available.

For a local owner Signet with recovery words, the identities page offers
Restore encrypted account. Select a file, supply a display name, check the
file with fresh owner authentication, then compare the displayed npub with
the intended account. Restore this account requires another fresh approval
before saving through the existing encrypted identity store. It neither
overwrites an existing account nor activates the restored account.

Manage identity offers Encrypted account backup for an owner's local imported
extra. Authenticate to download `imported-account.nstw`, then select the saved
file to verify it with fresh authentication. Expect confirmation of the exact
npub; keep that file and the owner's Signet recovery words. During preview,
retain the account's independent backup too. Paired-child, dependant and
hardware routes do not offer these operations.

Android saves through the system document picker rather than a browser blob
download. Cancelling does not report a saved file. The native writer accepts
only the bounded encrypted envelope, writes to the selected new document and
compares its read-back bytes; the owner still selects the saved file for the
cryptographic account check. No general storage permission is added. Native
unit tests cover rejected destinations, corrupt/trailing read-back data and
bounded reads. All 78 Android unit tests passed locally; physical phone
acceptance remains pending.

Run `npm run typecheck`, the focused wrapped library/component/hook tests and
`npm run build`. `e2e/wrapped-account.spec.ts` exercises the actual browser
restore, npub confirmation, fresh PIN prompts, downloaded-file decryption and
saved-file check using public test keys. Screenshots cover the identities
confirmation and imported-account Manage identity screens at 390 x 844.
Local browser evidence does not establish Android or hardware acceptance.

Final validation passed after a clean locked install using the cached alpha:
typecheck, production build, 139 focused tests and the complete browser
scenario. The Git contacts dependency needs its normal prepare build during
installation. The local browser run used installed Google Chrome with a
390 x 844 viewport; captures are in
`e2e/results/wrapped-account-restore-an-80c12-rt-and-check-the-saved-file-mobile-chrome-preview/`
(`confirm-imported-account.png` and `checked-encrypted-backup.png`). No native
Android or hardware test is claimed.

The browser regression also refuses wrong-root and tampered records before any restore confirmation. It runs in both PR CI and deployment checks.
