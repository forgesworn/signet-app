/**
 * Same-device Sign in with Signet: hand the callback URL back to the consumer.
 *
 * On the web the redirect unloads this page, so what happens to app state
 * afterwards is moot. On the Android APK it is not: the WebView hands a
 * foreign-origin URL to the browser and stays exactly where it was — so if
 * the request were still pending, reopening the app would show the finished
 * request with "Signing…" on the button and a live Deny that could send a
 * second, contradictory callback. The request is therefore retired and the
 * approval page left BEFORE the redirect is issued, on every platform.
 */
export interface AuthCallbackHandoff {
  /** Clear pendingAuthRequest and every piece of per-request approval state. */
  retireRequest: () => void;
  /** Leave the approval page for home (restores the nav). */
  leaveApprovalPage: () => void;
  /** Issue the redirect (window.location.href on both web and native). */
  redirect: (url: string) => void;
}

export function handOffAuthCallback(callbackUrl: string, deps: AuthCallbackHandoff): void {
  deps.retireRequest();
  deps.leaveApprovalPage();
  deps.redirect(callbackUrl);
}

/**
 * Should a denial be handed back to the consumer's callback? Only for a
 * request that arrived as a Sign in with Signet URL (?auth=1 on the web, or
 * the App Link on native) — QR/BroadcastChannel requests stay in the app.
 * The URL origin is recorded when the request is parsed; the consumer's
 * `name=` param is optional, so an empty site name must not demote a URL
 * request to "stay in the app" and silently drop the error=denied callback.
 */
export function shouldRedirectDenial(input: {
  fromUrlAuth: boolean;
  siteName: string;
  callbackUrl: string | undefined;
}): boolean {
  return (input.fromUrlAuth || input.siteName.length > 0) && !!input.callbackUrl;
}
