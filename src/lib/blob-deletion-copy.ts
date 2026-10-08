/**
 * The one-line results shown when Signet deletes an old picture or photo from
 * the Blossom server it was uploaded to. `{host}` is the server's hostname,
 * filled in by `withBlobHost`.
 */

export const OLD_PHOTO_DELETED_COPY = 'Old photo deleted from {host}.';
export const OLD_PHOTO_NOT_DELETED_COPY = "Couldn't delete the old photo from {host}.";
export const OLD_PICTURE_DELETED_COPY = 'Old picture deleted from {host}.';
export const OLD_PICTURE_NOT_DELETED_COPY = "Couldn't delete the old picture from {host}.";
export const OLD_PICTURE_STAYS_COPY = 'The old picture stays on {host} because your published profile still shows it.';

const MAX_HOST_DISPLAY = 64;

/** The server's hostname, capped for display (the server URL is user-chosen). */
export function blobHostLabel(serverUrl: string): string {
  let host: string;
  try { host = new URL(serverUrl).hostname; } catch { host = serverUrl; }
  return host.length > MAX_HOST_DISPLAY ? host.slice(0, MAX_HOST_DISPLAY) + '…' : host;
}

/** Fill `{host}` in one of the copy lines above. */
export function withBlobHost(template: string, serverUrl: string): string {
  return template.replace('{host}', () => blobHostLabel(serverUrl));
}
