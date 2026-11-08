// The package that launched an App Link, as the Android shell recorded it.
// UNTRUSTED: the launching app can claim any package. It is used to label a
// place and to decide whether an "Open" button is offered — never to allow,
// skip or weaken anything, and never placed in a URL or an AuthRequest.

export interface LaunchReferrerReading {
  package: string | null;
  url: string | null;
}

/** A plausible Android application id; anything else is dropped. */
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/**
 * The referrer package for `url`, or undefined. Only used when the shell's
 * recorded URL is exactly the URL being handled (a stale referrer from an
 * earlier launch must not label this one). Never throws.
 */
export async function referrerPackageFor(
  url: string,
  read: () => Promise<LaunchReferrerReading>,
): Promise<string | undefined> {
  try {
    const ret = await read();
    if (!ret || ret.url !== url) return undefined;
    const pkg = ret.package;
    if (typeof pkg !== 'string' || pkg.length > 255 || !PACKAGE_RE.test(pkg)) return undefined;
    return pkg;
  } catch {
    return undefined;
  }
}
