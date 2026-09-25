/** Hostname from a URL-like string, truncated for safe display. */
export function safeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.hostname || origin.slice(0, 64);
  } catch {
    return origin.slice(0, 64);
  }
}

/** First uppercase letter of a host, stripping leading `www.` — for favicon placeholders. */
export function hostInitial(origin: string): string {
  const host = safeOrigin(origin);
  const first = host.replace(/^www\./, '').charAt(0);
  return (first || '?').toUpperCase();
}
