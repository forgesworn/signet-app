# Account collection: external security review pack

Status: **prepared for an external specialist; review not performed**.
The owner retains reviewer selection and acceptance. No reviewer has been
contacted by this work. Automated checks and this pack are not an independent
audit. Keep independent key backups while the feature remains a preview.

## Pinned implementation

This pack describes the preview shipped on 16 November 2026. Review the
immutable revisions below rather than whichever commits are currently at
`main`. Record the exact reviewed revisions and any subsequent fixes in the
reviewer's report.

| Repository | Revision | Delivered change |
| --- | --- | --- |
| [Signet](https://github.com/forgesworn/signet-app/tree/4da0407512d5ae5caa273bfa6bbae0c732dcbae2) | `4da0407512d5ae5caa273bfa6bbae0c732dcbae2` / `v0.29.0` | [PR #121](https://github.com/forgesworn/signet-app/pull/121): collection, authentication, atomic restore, browser/native file handling |
| [Wildbloom](https://github.com/forgesworn/wildbloom/tree/4196e5e74c6fa6e1383c741a6d15187cecf01643) | `4196e5e74c6fa6e1383c741a6d15187cecf01643` | [PR #119](https://github.com/forgesworn/wildbloom/pull/119): existing encrypted-file storage and retrieval |
| [nsec-tree](https://github.com/forgesworn/nsec-tree/tree/6c3ecdd7f3a3db329272725784ea825d2da487a6) | `6c3ecdd7f3a3db329272725784ea825d2da487a6` | [PR #64](https://github.com/forgesworn/nsec-tree/pull/64): recovery/storage documentation; library implementation from the locked `1.7.0-alpha.1` dependency |

Signet's vendored MIT Stash codec records upstream commit
`0d9f5e1917a4d4d9dd3bfa661f4bf9f97823e102`, source SHA-256
`ebcc0fc2eba6cf53538c5731f15f49bf726b69e7d1d5abf597539aa68b3899cb`
and its licence. Review that vendored source and the codec's cross-application
vectors; no access to the private upstream repository is necessary.

## Contract and trust boundaries

Read [the recovery contract](ACCOUNT-COLLECTION-RECOVERY.md) and nsec-tree's
`WRAPPED-NSEC.md` alongside the code. A collection preserves 1–100 unrelated,
locally held imported keys; it does not change them into derived accounts.
The exact 65,608-byte FSWNENC2 file and the matching Signet words, or
equivalent access to the same root, are required. Loss of either can prevent
recovery. Possession of both exposes every included key.

The outer storage key is the private key from
`derive(fromMnemonic(words), 'signet/wrapped-account-collection/v1', 0)`.
The encrypted inventory contains names, npubs and existing 181-character
`nstw1:` records. All records must authenticate before any inventory or
selected key is returned. Unselected records are checked too.

Wildbloom receives ciphertext and a storage signing identity, never the
collection decryption key. Its existing-envelope inspection is structural,
not cryptographic authentication. Its signed private receipt binds the
encrypted payload hash, size, parts and destinations. Receipt verification
does not prove upload success; independent read-back does. Two distinct
verified parts rebuild the ciphertext; confidentiality rests on encryption.

Assume hostile files, receipts, storage responses and concurrent changes in
the local application. Loss, corruption, stale snapshots, revoked authority,
malicious or unavailable nodes and users confusing words with a complete
backup are in scope. An already compromised browser/OS can observe decrypted
keys. JavaScript strings and runtime/dependency copies cannot be reliably
erased; this implementation does not promise hardware isolation.

## Source map and review questions

Paths in this table are relative to the pinned repositories above.

| Area | Source / tests | Questions to resolve |
| --- | --- | --- |
| Root ownership and derivation | Signet `src/lib/wrapped-persona-backup.ts`, `src/lib/wrapped-account-collection.ts`; nsec-tree `src/wrapped.ts`, `test/wrapped.test.ts` | Does the mnemonic match the owner? Are derivation and wrapping contexts separated and byte-compatible? Are invalid scalar/key and mismatched npub inputs rejected? |
| Envelope and inventory | Signet `src/lib/vendor/stash/frame.ts`, `src/lib/wrapped-account-collection.ts`, `src/lib/wrapped-account-collection.test.ts` | Check salt/nonce generation, HKDF, AES-GCM AAD, bounds, strict UTF-8/schema, labels, duplicate accounts, metadata and zeroisation on every exit. Can malformed or unselected records evade validation? |
| Consent, selection and write | Signet `src/components/AccountCollectionBackup.tsx`, `src/App.tsx`, `src/hooks/useIdentity.ts`, `src/lib/db.ts`; `src/hooks/useIdentity.wrapped.test.ts` | Is the inspected snapshot bound to the restore? Is there fresh approval at the actual write? Do lock, cancel, identity switch, concurrent changes and duplicate npubs leave existing data intact? |
| File handling | Signet `src/lib/wrapped-backup-file.ts`, `src/lib/native.ts`; Android `SignetNativePlugin.kt`, `WrappedBackupDocument.kt`, `WrappedBackupDocumentTest.kt` under `android/app/src/` | Are size limits enforced before allocation? Is `nstc1:` canonical bridge transport only? Does the saved binary read back exactly? Can cancellation or provider failure be mistaken for verification? |
| Storage and receipt | Wildbloom `src/core/stored-envelope.ts`, `src/core/pool.ts`, `docs/POOL-STORAGE.md` | Does the existing-envelope mode preserve exact bytes? Are signatures, payload/part hashes, lengths, placement, destinations and network policy checked? Can a receipt cause unapproved requests or claim unverified copies? |
| Fresh recovery | Signet `e2e/wrapped-account.spec.ts`; Wildbloom `scripts/stored-envelope-acceptance.mjs`, `scripts/pool-acceptance.mjs` | Can recovery work without the originating device, browser state or original storage signer? Does reconstructed ciphertext authenticate in Signet? What happens with a stale valid snapshot, a missing receipt or too few parts? |
| Memory and permissions | Signet collection, hook and database paths above | Are returned private byte arrays wiped after success, failure or cancellation? Do restored keys remain imported, with original npubs and no inherited app permissions? Identify unavoidable copies and their lifetime. |

## Evidence available and reproduction

The shipped Signet [CI run](https://github.com/forgesworn/signet-app/actions/runs/43864841354)
passed typechecking, 8,706 unit tests, conformance, the production build,
wrapped-account browser journeys and Android service tests/debug build. The
[deployment run](https://github.com/forgesworn/signet-app/actions/runs/43866808426)
also passed its production checks. The [0.29.0 release](https://github.com/forgesworn/signet-app/releases/tag/v0.29.0)
contains the signed APK, manifest and matching tag.

Wildbloom's [production run](https://github.com/forgesworn/wildbloom/actions/runs/43866809549)
passed its gates and read-back. The release's check suite passed 693 tests;
the existing-envelope browser journey recovered exact bytes through all six
two-part combinations using disposable local nodes and separate fresh
browser contexts. No owner keys or live storage destinations were used.
Existing dependency exceptions must be assessed through the pinned audit
policy rather than treated as a claim of zero advisories.

In isolated checkouts at the revisions above, use each repository's locked
dependencies and CI setup. Do not run the fixtures against an owner's signer
or profile. Useful focused entry points after dependency installation are:

```sh
# Signet: software recovery, file handling, persistence and UI
npx vitest run src/lib/wrapped-account-collection.test.ts src/lib/wrapped-persona-backup.test.ts src/lib/wrapped-backup-file.test.ts src/hooks/useIdentity.wrapped.test.ts --maxWorkers=2
npx playwright test --project=mobile-chromium --workers=1 e2e/wrapped-account.spec.ts

# nsec-tree: wrapping and the frozen derivation vectors
npm test -- --maxWorkers=2 --testTimeout=30000

# Wildbloom: full existing gates, then the local-node encrypted-file journey
npm run ci
node scripts/pool-acceptance.mjs --existing-envelope
```

Run the commands inside their named repositories. The Signet Playwright
command needs installed Chromium and starts the configured local test server.
The Wildbloom pool journey needs its production build, a compatible
`WILDBLOOM_NODE_BIN` and a browser, as documented in `docs/POOL-STORAGE.md`.
The tests use public disposable inputs; never substitute owner recovery words
or private keys into fixtures. Frozen nsec-tree vectors must remain unchanged.

## Requested report and open acceptance

Ask the specialist for the exact revisions and dependency versions reviewed,
methods and cases actually executed, findings with reproduction and impact,
recommended fixes and limitations. Track fixes by commit and obtain a review
of the relevant changes before treating a finding as resolved. Do not label
unreviewed revisions as audited.

The following remain separate from code review:

- The [owner rehearsal](ACCOUNT-COLLECTION-REHEARSAL.md) with a checked file,
  independently saved receipt and fresh recovery installation.
- Real destination admission, retention and independent failure groups.
- Direct Bothy Keep file-upload and recoverable-locator integration, whose
  requirements are in the recovery contract's handover section.
- Hardware recovery and physical-device acceptance. This collection release
  neither tests nor changes the owner's only live T-Display signer.

Review material should contain public code and synthetic evidence only. Do
not include owner words, nsecs, encrypted owner collections, private receipts,
endpoint lists, account labels or screenshots of recovery material. Follow
the repositories' security-reporting policy for a vulnerability.
