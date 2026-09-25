# Release signing — My Signet Android APK

The release build (`assembleRelease`) signs with a keystore supplied **entirely
from outside the repo** — no key material is ever committed. The signing config
lives in `android/app/build.gradle` (`signingConfigs.release`) and reads a
`keystore.properties` file from
`~/.android-keystores/signet-app-keystore.properties` (override the path with
the `SIGNET_KEYSTORE_PROPERTIES` env var).

**If the properties file is absent, `assembleRelease` produces an *unsigned*
APK** (`app/build/outputs/apk/release/app-release-unsigned.apk`) rather than
failing, so CI and other machines can still assemble. The `assembleDebug` build
always signs with the SDK's local debug key (fine for on-device testing,
**not** for distribution — different signature to the release key, so a debug
install must be uninstalled before a release APK will install).

> ⚠️ **The first key an app is published with is permanent.** Every future
> update must be signed by the same key or Android/GrapheneOS refuses to
> install it as an update. The key is owned by the keyholder, held off-repo,
> and backed up per the restore notes stored alongside it. Never lose it.

## keystore.properties format

```properties
storeFile=/absolute/path/to/signet-app-release.jks
storePassword=…
keyAlias=signet-app
keyPassword=…
```

## Canonical release cert

Every published APK must verify with this signing-cert digest (also stated in
the GitHub release notes so users can pin it):

```
SHA-256: 7f9994a0cfc6057a3d98aa5e44c4bddbb053cff3c9c311fd4391886422ca3730
```

## Building a signed release

```bash
# from repo root
npm run build && npx cap sync android
cd android && ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk  (signed)
```

Verify the signature:

```bash
"$ANDROID_HOME"/build-tools/<version>/apksigner verify --print-certs \
  app/build/outputs/apk/release/app-release.apk
```

The version is read from `package.json` at build time (`versionName` = the
semver, `versionCode` = major*10000 + minor*100 + patch — see
`src/lib/app-version.ts`). Bump with `npm version X.Y.Z --no-git-tag-version`,
never by editing `build.gradle`. `scripts/release.sh` does this for you.

## Publishing

One command, run on the machine that holds the keystore:

```bash
scripts/release.sh 0.12.0
```

It bumps `package.json` (the single version source — Gradle derives
`versionName`/`versionCode` from it), runs typecheck + unit tests, builds the
signed APK, verifies the signature against the canonical cert digest above,
reads the version back out of the APK, fetches the currently-published
manifest from `https://mysignet.app/get/signet-app.json` and refuses to
continue unless the new build's `versionCode` is strictly greater (Android
itself would refuse the "upgrade" otherwise), writes `signet-app.json`
(`versionName`, `versionCode`, `apkSha256`, `certSha256`, `sizeBytes`,
`builtAt`, `url`), commits + tags `vX.Y.Z`, pushes, and creates the GitHub
release with three assets: `signet-app-vX.Y.Z.apk`, the stable
`signet-app.apk`, and `signet-app.json`. `DRY_RUN=1` stops before the commit;
`SKIP_TESTS=1` skips the gates.

The repo is private, so release assets are not publicly downloadable — the
deploy workflow (which also runs on release publish) downloads them with its
repo token and serves them from `https://mysignet.app/get/`, which is where
the in-app promo, the Settings entry, and Obtainium (HTML source pointed at
that page) all resolve. The manifest at
`https://mysignet.app/get/signet-app.json` is what the installed app compares
itself against (Settings → About: "You're on the latest version" / "vX.Y.Z is
available").

### If it fails part-way

The script prints `artifacts: <dir>` right after the APK is built and
verified, before anything that pushes or publishes — that directory holds the
signed APKs, the manifest, and (once step 7 runs) the release notes, so
nothing is lost if a later step fails.

- **`git push origin main` fails** — the release commit is already on local
  main, so do **not** re-run the script (it would stop at npm "Version not
  changed"). Either push it by hand and finish the remaining steps yourself:
  `git push origin main`, then `git tag -a vX.Y.Z -m "My Signet vX.Y.Z"`,
  `git push origin vX.Y.Z`, then the `gh release create …` command below
  (from the printed artifacts dir) — or abandon the release commit with
  `git reset --hard origin/main`.
- **`git push origin vX.Y.Z` fails** (main already pushed) — push the tag by
  hand: `git push origin vX.Y.Z`. Then continue at the release-create step
  below. To abandon instead: `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`.
- **`gh release create` fails** (main and tag already pushed) — re-run it by
  hand from the printed artifacts dir:

  ```bash
  gh release create vX.Y.Z \
    --title "My Signet vX.Y.Z" \
    --notes-file <artifacts>/notes.md \
    <artifacts>/signet-app-vX.Y.Z.apk <artifacts>/signet-app.apk <artifacts>/signet-app.json
  ```

Then publish to Zapstore (needs your Nostr key):

```bash
SIGN_WITH=<nsec1... | bunker://...> zsp publish zapstore.yaml
```
