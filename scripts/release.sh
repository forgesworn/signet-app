#!/usr/bin/env bash
# scripts/release.sh — cut a My Signet Android release in one go.
#
#   scripts/release.sh 0.12.0            # full run
#   SKIP_TESTS=1 scripts/release.sh 0.12.0
#   DRY_RUN=1 scripts/release.sh 0.12.0  # preflight + build + verify, no commit/push/release
#
# What it does, in order (each step fails loud):
#   1. preflight: clean tree, on main, in sync with origin, gh authed,
#      keystore.properties present, aapt2 + apksigner found, java + gradlew found
#   2. npm version X.Y.Z (package.json is THE version source; Gradle derives
#      versionName/versionCode from it — see android/app/build.gradle)
#   3. typecheck + unit tests (SKIP_TESTS=1 to skip)
#   4. vite build → cap sync android → assembleRelease
#   5. apksigner verify; refuse unsigned; refuse any cert but the canonical one
#   6. read versionName/versionCode BACK OUT of the APK (the artifact is the
#      truth), sha256, size → signet-app.json manifest
#   6a. fetch the LIVE manifest from https://mysignet.app/get/signet-app.json
#      and refuse to continue unless the new versionCode is strictly greater
#      (Android itself would refuse the "upgrade" otherwise)
#   7. commit "chore(release): vX.Y.Z", push main, tag vX.Y.Z, push the tag
#   8. gh release create with the three assets + provenance notes
#   9. print the Zapstore publish command (needs a Nostr key; not automated)
#
# If it fails part-way after main/tag are pushed, see "If it fails part-way"
# in android/RELEASE_SIGNING.md.
#
# Runs only where the release keystore lives, by construction (step 1).
set -euo pipefail

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 X.Y.Z" >&2; exit 2; }
TAG="v$VERSION"
CANONICAL_CERT="7f9994a0cfc6057a3d98aa5e44c4bddbb053cff3c9c311fd4391886422ca3730"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say() { printf '\n==> %s\n' "$*"; }
# GNU coreutils on Linux, the BSD tools on macOS: the keystore may live on either.
sha256_of() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
size_of() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ---------- 1. preflight ----------
say "preflight"
[[ -z "$(git status --porcelain)" ]] || die "working tree not clean"
[[ "$(git branch --show-current)" == "main" ]] || die "not on main"
git fetch -q origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || die "main is not in sync with origin/main"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated"
KS_PROPS="${SIGNET_KEYSTORE_PROPERTIES:-$HOME/.android-keystores/signet-app-keystore.properties}"
[[ -f "$KS_PROPS" ]] || die "no keystore.properties at $KS_PROPS — this machine cannot sign a release (android/RELEASE_SIGNING.md)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
BT="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
[[ -n "$BT" && -x "$BT/aapt2" && -x "$BT/apksigner" ]] || die "aapt2/apksigner not found under $SDK/build-tools"
command -v sha256sum >/dev/null || command -v shasum >/dev/null || die "sha256sum (or shasum) missing"
command -v curl >/dev/null || die "curl missing"
command -v java >/dev/null || die "java missing (needed by gradle)"
[[ -x android/gradlew ]] || die "android/gradlew missing or not executable"
echo "build-tools: $BT"

# ---------- 2. bump ----------
# A PR may already have bumped package.json (the version is part of the change
# it ships). Then there is nothing to bump and nothing to commit: the release
# tags the HEAD that carries it.
if [[ "$(node -p 'require("./package.json").version')" == "$VERSION" ]]; then
  say "package.json is already $VERSION — releasing HEAD as is"
  BUMPED=0
else
  say "npm version $VERSION"
  npm version "$VERSION" --no-git-tag-version >/dev/null
  grep -q "\"version\": \"$VERSION\"" package.json || die "package.json bump failed"
  trap 'git checkout -- package.json package-lock.json' EXIT
  BUMPED=1
fi

# ---------- 3. gates ----------
if [[ "${SKIP_TESTS:-0}" == "1" ]]; then
  say "SKIP_TESTS=1 — skipping typecheck + unit tests"
else
  say "typecheck"; npm run typecheck
  say "unit tests"; npm test
fi

# ---------- 4. build ----------
say "vite build"; npm run build
say "cap sync android"; npx cap sync android
say "assembleRelease"; (cd android && ./gradlew -q assembleRelease)
APK="android/app/build/outputs/apk/release/app-release.apk"
[[ -f "$APK" ]] || die "no signed APK at $APK (an unsigned build lands at app-release-unsigned.apk — keystore not picked up?)"

OUT="$(mktemp -d)"
echo "artifacts: $OUT"

# ---------- 5. verify signature ----------
say "apksigner verify"
"$BT/apksigner" verify --print-certs "$APK" > "$OUT/certs.txt"
CERT_LINE="$(grep -i 'SHA-256 digest' "$OUT/certs.txt" | head -1 || true)"
CERT="$(printf '%s' "$CERT_LINE" | grep -oE '[0-9a-f]{64}' | head -1 || true)"
[[ -n "$CERT" ]] || die "could not read signing cert digest from apksigner output: $CERT_LINE"
[[ "$CERT" == "$CANONICAL_CERT" ]] || die "APK signed with $CERT, not the canonical release cert $CANONICAL_CERT"
echo "cert ok: $CERT"

# ---------- 6. read the artifact back, manifest ----------
say "read version from the APK"
"$BT/aapt2" dump badging "$APK" > "$OUT/badging.txt"
BADGING="$(head -1 "$OUT/badging.txt")"
APK_VCODE="$(printf '%s' "$BADGING" | grep -oE "versionCode='[0-9]+'" | grep -oE '[0-9]+' || true)"
APK_VNAME="$(printf '%s' "$BADGING" | grep -oE "versionName='[^']+'" | sed -E "s/versionName='([^']+)'/\1/" || true)"
[[ "$APK_VNAME" == "$VERSION" ]] || die "APK versionName is '$APK_VNAME', expected '$VERSION' — Gradle did not read package.json?"
[[ "$APK_VCODE" =~ ^[0-9]+$ && "$APK_VCODE" -gt 0 ]] || die "bad versionCode '$APK_VCODE'"
echo "versionName=$APK_VNAME versionCode=$APK_VCODE"

# ---------- 6a. monotonicity: refuse to publish a versionCode Android would reject ----------
say "check versionCode against the published manifest"
PUBLISHED_JSON="$(curl -fsS --max-time 20 https://mysignet.app/get/signet-app.json || true)"
[[ -n "$PUBLISHED_JSON" ]] || die "could not fetch the published manifest from https://mysignet.app/get/signet-app.json — a release must be able to compare against what is live"
PUBLISHED_VCODE="$(node -e 'const m=JSON.parse(process.argv[1]);if(!Number.isInteger(m.versionCode))process.exit(1);console.log(m.versionCode)' "$PUBLISHED_JSON" 2>/dev/null || true)"
[[ "$PUBLISHED_VCODE" =~ ^[0-9]+$ ]] || die "published manifest has no integer versionCode"
[[ "$APK_VCODE" -gt "$PUBLISHED_VCODE" ]] || die "APK versionCode $APK_VCODE is not greater than the published $PUBLISHED_VCODE — Android would refuse the upgrade (check package.json bump / Gradle derivation)"
echo "published versionCode=$PUBLISHED_VCODE → new $APK_VCODE ok"

cp "$APK" "$OUT/signet-app-$TAG.apk"
cp "$APK" "$OUT/signet-app.apk"
SHA="$(sha256_of "$OUT/signet-app-$TAG.apk")"
SIZE="$(size_of "$OUT/signet-app-$TAG.apk")"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$OUT/signet-app.json" <<EOF
{
  "versionName": "$APK_VNAME",
  "versionCode": $APK_VCODE,
  "apkSha256": "$SHA",
  "certSha256": "$CERT",
  "sizeBytes": $SIZE,
  "builtAt": "$BUILT_AT",
  "url": "https://mysignet.app/get/signet-app-$TAG.apk"
}
EOF
node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const hex = /^[0-9a-f]{64}$/;
  const ok = m.versionName && Number.isInteger(m.versionCode) && m.versionCode > 0
    && hex.test(m.apkSha256) && hex.test(m.certSha256) && m.sizeBytes > 0
    && typeof m.builtAt === "string" && /^https:\/\//.test(m.url);
  if (!ok) { console.error("manifest failed self-check"); process.exit(1); }
' "$OUT/signet-app.json"
echo "sha256=$SHA size=$SIZE"
cat "$OUT/signet-app.json"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  say "DRY_RUN=1 — stopping before commit/push/release. Artifacts in $OUT"
  [[ "$BUMPED" == "1" ]] && git checkout -- package.json package-lock.json
  exit 0
fi

# ---------- 7. commit, push main, tag, push tag ----------
say "commit + push + tag"
SRC_COMMIT_BEFORE="$(git rev-parse HEAD)"
trap - EXIT
if [[ "$BUMPED" == "1" ]]; then
  git add package.json package-lock.json
  git commit -q -m "chore(release): $TAG"
fi
git push origin main || die "push of the release commit to origin/main failed — the commit is still local only (no tag exists anywhere). Fix the push (network/auth) and re-run 'git push origin main' by hand, or abandon this release commit with 'git reset --hard origin/main'"
git tag -a "$TAG" -m "My Signet $TAG (versionCode $APK_VCODE)" || die "could not create tag $TAG — main is pushed; create the tag by hand and continue with: git push origin $TAG, then gh release create (see android/RELEASE_SIGNING.md)"
git push origin "$TAG" || die "push of tag $TAG failed — main is already pushed to origin, but the tag is not. Re-run 'git push origin $TAG' by hand, then create the release yourself: see \"If it fails part-way\" in android/RELEASE_SIGNING.md. Artifacts are in $OUT"
SRC_COMMIT="$(git rev-parse HEAD)"

# ---------- 8. GitHub release ----------
say "gh release create $TAG"
NOTES="$OUT/notes.md"
cat > "$NOTES" <<EOF
## My Signet $TAG (versionCode $APK_VCODE)

### Provenance
- Source commit: \`$SRC_COMMIT\`$([[ "$BUMPED" == "1" ]] && printf ' (built from `%s` + the version bump)' "$SRC_COMMIT_BEFORE")
- Built with Node $(node --version), $(java -version 2>&1 | head -1), \`assembleRelease\`

### Integrity
- APK SHA-256: \`$SHA\`
- Signing certificate SHA-256 (canonical, pin this): \`$CERT\`
- Manifest: \`signet-app.json\` (what the app checks against — served at https://mysignet.app/get/signet-app.json)

Install: download \`signet-app.apk\` below or via https://mysignet.app/get/
EOF
gh release create "$TAG" \
  --title "My Signet $TAG" \
  --notes-file "$NOTES" \
  "$OUT/signet-app-$TAG.apk" "$OUT/signet-app.apk" "$OUT/signet-app.json" \
  || die "gh release create failed — main and tag $TAG are already pushed. Re-run the gh release create command by hand from the artifacts dir: see \"If it fails part-way\" in android/RELEASE_SIGNING.md. Artifacts are in $OUT"

# ---------- 9. next step ----------
say "done. The deploy workflow re-publishes mysignet.app/get on release publish."
cat <<EOF

Next (needs your Nostr key; not automated):
  SIGN_WITH=<nsec1... | bunker://...> zsp publish zapstore.yaml

Artifacts kept in: $OUT
EOF
