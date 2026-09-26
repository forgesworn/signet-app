// "Am I on the latest APK?" — pure logic, no React, no Capacitor imports.
//
// The Android app is a SNAPSHOT of dist/ inside the APK (capacitor.config.ts
// has no server.url), so deploying mysignet.app changes nothing on an
// installed phone. The only way an APK learns it is behind is to compare its
// own versionCode against a manifest the release script publishes next to
// the APK at https://mysignet.app/get/signet-app.json.
//
// Ported from Kintrinsic apps/charter-app/src/carrier/version.ts. Two rules
// carried over because they cost real test rounds there:
//   - an unreadable self-report is NEVER "behind" (a fresh install was once
//     reported out of date because a read failure was collapsed to "old");
//   - an unreachable manifest is "could not check", never "behind".
//
// Inside the APK the manifest fetch must go over CapacitorHttp, not the
// WebView's `fetch`: mysignet.app sends no Access-Control-Allow-Origin, and
// the WebView's origin is `https://localhost`, so a plain `fetch` is CORS-
// blocked before the request ever leaves the device. CapacitorHttp makes the
// request from native code — no browser, no CORS — but only for this one
// call: `CapacitorHttp` is imported directly here rather than enabled
// globally in capacitor.config.ts, which would silently reroute every other
// `fetch`/`XMLHttpRequest` in the app through native code too.

import { CapacitorHttp } from '@capacitor/core';
import { isNativeApp } from './native';

/** Published by scripts/release.sh as a release asset; the deploy workflow
 *  copies it into dist/get/ beside the APKs. Absolute: the WebView origin is
 *  not mysignet.app. */
export const UPDATE_MANIFEST_URL = 'https://mysignet.app/get/signet-app.json';

export interface UpdateManifest {
  versionName: string;
  /** Android versionCode — the ONE number compared. */
  versionCode: number;
  /** Lowercase hex SHA-256 of the versioned APK. */
  apkSha256: string;
  /** Lowercase hex SHA-256 of the release signing certificate. */
  certSha256: string;
  sizeBytes: number;
  /** ISO-8601 build time, informational. */
  builtAt: string;
  /** Absolute https URL of the versioned APK. */
  url: string;
}

export interface InstalledVersion {
  versionName: string;
  versionCode: number;
}

export type AppUpdateState =
  /** Not running inside the APK — the web app updates itself via the SW. */
  | { kind: 'not-native' }
  /** Native, first render, nothing known yet. */
  | { kind: 'checking' }
  /** Native, but getInfo() gave no usable answer. Never reported as behind. */
  | { kind: 'unreadable' }
  /** Native, self-report fine, manifest unreachable. */
  | { kind: 'unknown'; installed: InstalledVersion }
  | { kind: 'current'; installed: InstalledVersion }
  | { kind: 'behind'; installed: InstalledVersion; latest: UpdateManifest };

const HEX64 = /^[0-9a-f]{64}$/;
/** Matches the release script's own versionName shape ("0.12.0"-style, plus
 *  suffixes like "-rc1" or "+build3"); bounded length keeps a malformed or
 *  hostile manifest from being echoed verbatim into UI copy unbounded. */
const VERSION_NAME = /^[0-9A-Za-z.\-+]{1,32}$/;
/** The APK is pinned to this exact origin — a manifest can only ever point
 *  back at mysignet.app, never at an attacker-controlled download host. */
const MANIFEST_ORIGIN = 'https://mysignet.app';

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** `url` must parse and its origin must be exactly the pinned manifest
 *  origin — rejects both other hosts and origin-confusable lookalikes
 *  (e.g. `https://mysignet.app.evil.example/...`, where `.startsWith()`
 *  would have been fooled). */
function isPinnedOriginUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return false;
  }
  return parsed.origin === MANIFEST_ORIGIN;
}

export function parseUpdateManifest(o: unknown): UpdateManifest | null {
  if (typeof o !== 'object' || o === null) return null;
  const m = o as Record<string, unknown>;
  if (typeof m.versionName !== 'string' || !VERSION_NAME.test(m.versionName)) return null;
  if (!isPositiveInt(m.versionCode)) return null;
  if (typeof m.apkSha256 !== 'string' || !HEX64.test(m.apkSha256)) return null;
  if (typeof m.certSha256 !== 'string' || !HEX64.test(m.certSha256)) return null;
  if (!isPositiveInt(m.sizeBytes)) return null;
  if (typeof m.builtAt !== 'string') return null;
  if (!isPinnedOriginUrl(m.url)) return null;
  return {
    versionName: m.versionName,
    versionCode: m.versionCode,
    apkSha256: m.apkSha256,
    certSha256: m.certSha256,
    sizeBytes: m.sizeBytes,
    builtAt: m.builtAt,
    url: m.url,
  };
}

/**
 * Parse the result of @capacitor/app `App.getInfo()`. On Android `version`
 * is versionName and `build` is versionCode AS A STRING. Anything partial or
 * malformed is "no answer" — an APK that cannot say what it is must never be
 * reported as current (or as behind).
 */
export function parseInstalledVersion(info: unknown): InstalledVersion | null {
  if (typeof info !== 'object' || info === null) return null;
  const m = info as Record<string, unknown>;
  if (typeof m.version !== 'string' || m.version.length === 0) return null;
  if (typeof m.build !== 'string' || !/^\d+$/.test(m.build)) return null;
  const versionCode = Number(m.build);
  if (!isPositiveInt(versionCode)) return null;
  return { versionName: m.version, versionCode };
}

/** The whole decision as a pure function. */
export function appUpdateState(
  isNative: boolean,
  installed: InstalledVersion | null,
  latest: UpdateManifest | null,
): AppUpdateState {
  if (!isNative) return { kind: 'not-native' };
  if (installed === null) return { kind: 'unreadable' };
  if (latest === null) return { kind: 'unknown', installed };
  return installed.versionCode < latest.versionCode
    ? { kind: 'behind', installed, latest }
    : { kind: 'current', installed };
}

/** How long to wait for the native request before giving up — matches the
 *  outer 5s budget `useAppUpdate` allows for the whole check. */
const NATIVE_REQUEST_TIMEOUT_MS = 5000;

/** Native leg: CapacitorHttp does not throw on a non-2xx status, and its
 *  `data` may already be a parsed object or may still be a JSON string
 *  (platform-dependent) — both are normalised to the same shape the web
 *  path produces before validation. */
async function fetchUpdateManifestNative(): Promise<UpdateManifest | null> {
  try {
    const res = await CapacitorHttp.get({
      url: UPDATE_MANIFEST_URL,
      connectTimeout: NATIVE_REQUEST_TIMEOUT_MS,
      readTimeout: NATIVE_REQUEST_TIMEOUT_MS,
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (res.status < 200 || res.status >= 300) return null;
    const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return parseUpdateManifest(body);
  } catch {
    return null;
  }
}

/** Fetch + parse the manifest; null on ANY failure (fail-quiet). */
export async function fetchUpdateManifest(fetcher: typeof fetch = fetch): Promise<UpdateManifest | null> {
  if (isNativeApp()) return fetchUpdateManifestNative();
  try {
    const res = await fetcher(UPDATE_MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    return parseUpdateManifest(await res.json());
  } catch {
    return null;
  }
}
