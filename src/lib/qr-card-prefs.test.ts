// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { clearQrCardPrefs } from './qr-card-prefs';
import { purgeAllUserData } from './db';
it('clears only the QR card keys', () => {
  localStorage.setItem('signet:qr-tab:a', 'npub'); localStorage.setItem('signet:qr-share-name:a', '0'); localStorage.setItem('other', 'x');
  clearQrCardPrefs();
  expect(localStorage.getItem('signet:qr-tab:a')).toBeNull();
  expect(localStorage.getItem('signet:qr-share-name:a')).toBeNull();
  expect(localStorage.getItem('other')).toBe('x');
});
it('is part of account deletion', async () => {
  localStorage.setItem('signet:qr-tab:b', 'mysignet');
  await purgeAllUserData();
  expect(localStorage.getItem('signet:qr-tab:b')).toBeNull();
  localStorage.removeItem('other');
});
