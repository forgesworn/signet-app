// Detection + snooze for the Android APK promotion (home card + settings row).
// Pure and localStorage-only so it works before an identity exists and is
// unit-testable in lib/. Never true inside the APK (isNativeApp gate).
import { isNativeApp } from './native';

/** Public download page — the release-signed APK + GrapheneOS install notes. */
export const ANDROID_APP_URL = 'https://mysignet.app/get';

const SNOOZE_KEY = 'signet-apk-promo-snooze-until'; // localStorage; ms-epoch string
const DAY_MS = 86_400_000;
const DEFAULT_SNOOZE_DAYS = 30;

/** True on an Android *web* build only (never in the APK), non-iOS. */
export function isAndroidWeb(): boolean {
  if (isNativeApp()) return false;
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iphone|ipad|ipod/i.test(ua)) return false;
  return /android/i.test(ua);
}

/** Hide the promo for `days` (default 30) from `now`. Non-fatal if storage is unavailable. */
export function snoozeApkPromo(days: number = DEFAULT_SNOOZE_DAYS, now: number = Date.now()): void {
  try { localStorage.setItem(SNOOZE_KEY, String(now + days * DAY_MS)); } catch { /* storage unavailable */ }
}

/** True while a live snooze window covers `now`. Malformed/absent → false. */
export function isApkPromoSnoozed(now: number = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    if (!raw) return false;
    const until = Number(raw);
    return Number.isFinite(until) && until > now;
  } catch { return false; }
}

/** Remove the snooze record. */
export function clearApkPromoSnooze(): void {
  try { localStorage.removeItem(SNOOZE_KEY); } catch { /* non-fatal */ }
}

/** Show the promo now? Android web AND not snoozed. */
export function shouldPromoteAndroidApp(now: number = Date.now()): boolean {
  return isAndroidWeb() && !isApkPromoSnoozed(now);
}
