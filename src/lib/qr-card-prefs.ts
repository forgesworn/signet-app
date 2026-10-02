// Per-persona, per-viewer QR card conveniences kept in localStorage. Keyed by
// persona pubkey, so they are removed with the account.
export const QR_TAB_PREFIX = 'signet:qr-tab:';
export const QR_SHARE_NAME_PREFIX = 'signet:qr-share-name:';

/** Remove every remembered QR-card choice. Never throws (storage may be absent or blocked). */
export function clearQrCardPrefs(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(QR_TAB_PREFIX) || k.startsWith(QR_SHARE_NAME_PREFIX))) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch { /* storage unavailable: nothing to clear */ }
}
