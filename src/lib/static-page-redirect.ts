/**
 * Short public paths that live as static pages under a folder the web server
 * serves directly. The server's SPA fallback answers any other HTML path with
 * the app shell, so `/guide` reaches the app, which forwards it here.
 */
const STATIC_PAGE_ALIASES: Record<string, string> = {
  '/guide': '/about/guide/',
};

/** The static page to forward to for this location, or null to run the app. */
export function staticPageRedirect(pathname: string, search: string, hash: string): string | null {
  const key = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const target = STATIC_PAGE_ALIASES[key];
  return target ? target + search + hash : null;
}
