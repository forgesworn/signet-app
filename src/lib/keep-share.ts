/**
 * Hand an invite link to the phone's share sheet.
 *
 * In the Android app this uses the native share sheet (`@capacitor/share`):
 * the WebView has no Web Share API. In a browser it uses `navigator.share`
 * when there is one. When neither can open a sheet, or opening it fails, the
 * link is copied to the clipboard. The link holds the invite secret: it is
 * built only at the moment of sharing or copying and is never rendered.
 */
import { Share } from '@capacitor/share';
import { isNativeApp } from './native';

export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

/** What the choice between share mechanisms depends on, so tests can supply it. */
export interface ShareDeps {
  isNative: () => boolean;
  nativeShare: (text: string) => Promise<void>;
  webShare?: (text: string) => Promise<void>;
  copy?: (text: string) => Promise<void>;
}

/** The native sheet reports a dismissed sheet as a rejection with this message. */
function isCancel(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return true;
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : (e as { message?: unknown } | null)?.message;
  return typeof message === 'string' && /cancel/i.test(message);
}

function realDeps(): ShareDeps {
  return {
    isNative: isNativeApp,
    nativeShare: async text => { await Share.share({ text, dialogTitle: 'Share invite' }); },
    webShare: typeof navigator !== 'undefined' && typeof navigator.share === 'function'
      ? text => navigator.share({ text })
      : undefined,
    copy: typeof navigator !== 'undefined' && navigator.clipboard?.writeText
      ? text => navigator.clipboard.writeText(text)
      : undefined,
  };
}

export async function shareInviteLink(link: string, deps: ShareDeps = realDeps()): Promise<ShareOutcome> {
  const sheets: Array<(text: string) => Promise<void>> = [];
  if (deps.isNative()) sheets.push(deps.nativeShare);
  else if (deps.webShare) sheets.push(deps.webShare);
  for (const open of sheets) {
    try {
      await open(link);
      return 'shared';
    } catch (e) {
      if (isCancel(e)) return 'cancelled';
      // No share sheet for this: fall through to copying.
    }
  }
  try {
    if (deps.copy) {
      await deps.copy(link);
      return 'copied';
    }
  } catch { /* clipboard refused */ }
  return 'failed';
}
