/**
 * Hand an invite link to the phone's share sheet.
 *
 * `@capacitor/share` is not a dependency of this app, so this uses the Web
 * Share API (the Android WebView supports it) and falls back to copying the
 * link to the clipboard. The link holds the invite secret: it is built only at
 * the moment of sharing or copying and is never rendered.
 */
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

export async function shareInviteLink(link: string): Promise<ShareOutcome> {
  try {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ text: link });
        return 'shared';
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
        // No share sheet for this: fall through to copying.
      }
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(link);
      return 'copied';
    }
  } catch { /* clipboard refused */ }
  return 'failed';
}
