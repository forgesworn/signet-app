/**
 * Android versionCode for a semver string: major*10000 + minor*100 + patch.
 * Pre-release suffixes ("0.12.0-beta.1") are ignored for the code.
 *
 * android/app/build.gradle derives the SAME number from package.json at build
 * time — that is the single version source for the APK. This function exists
 * so a unit test pins the rule and so scripts/tests can reason about it.
 */
export function versionCodeFor(semver: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(semver);
  if (!m) throw new Error(`bad semver: ${semver}`);
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}
