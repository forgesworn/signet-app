// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({ isNativeApp: vi.fn(() => false) }));
vi.mock('./native', () => mocks);

import {
  ANDROID_APP_URL, isAndroidWeb, snoozeApkPromo, isApkPromoSnoozed,
  clearApkPromoSnooze, shouldPromoteAndroidApp,
} from './android-promo';

function setUA(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}
const DAY = 86_400_000;

describe('android-promo', () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); mocks.isNativeApp.mockReturnValue(false); });
  afterEach(() => { localStorage.clear(); });

  it('ANDROID_APP_URL is the get page', () => {
    expect(ANDROID_APP_URL).toBe('https://mysignet.app/get');
  });

  describe('isAndroidWeb', () => {
    it('true for an Android UA on web', () => { setUA('Mozilla/5.0 (Linux; Android 14)'); expect(isAndroidWeb()).toBe(true); });
    it('false inside the APK even on Android', () => { setUA('Mozilla/5.0 (Linux; Android 14)'); mocks.isNativeApp.mockReturnValue(true); expect(isAndroidWeb()).toBe(false); });
    it('false on an iOS UA', () => { setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'); expect(isAndroidWeb()).toBe(false); });
    it('false on a desktop UA', () => { setUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)'); expect(isAndroidWeb()).toBe(false); });
  });

  describe('snooze round-trip', () => {
    it('snoozed within the window, not after', () => {
      const t0 = 1_000_000_000_000;
      snoozeApkPromo(30, t0);
      expect(isApkPromoSnoozed(t0 + 29 * DAY)).toBe(true);
      expect(isApkPromoSnoozed(t0 + 31 * DAY)).toBe(false);
    });
    it('not snoozed when absent', () => { expect(isApkPromoSnoozed(1000)).toBe(false); });
    it('not snoozed when the stored value is malformed', () => {
      localStorage.setItem('signet-apk-promo-snooze-until', 'not-a-number');
      expect(isApkPromoSnoozed(1000)).toBe(false);
    });
    it('clearApkPromoSnooze removes it', () => { snoozeApkPromo(30, 1000); clearApkPromoSnooze(); expect(isApkPromoSnoozed(1000)).toBe(false); });
  });

  describe('shouldPromoteAndroidApp', () => {
    it('true for Android web with no snooze', () => { setUA('Android'); expect(shouldPromoteAndroidApp(1000)).toBe(true); });
    it('false when snoozed', () => { setUA('Android'); snoozeApkPromo(30, 5000); expect(shouldPromoteAndroidApp(6000)).toBe(false); });
    it('false inside the APK', () => { setUA('Android'); mocks.isNativeApp.mockReturnValue(true); expect(shouldPromoteAndroidApp(1000)).toBe(false); });
  });
});
