/**
 * Dev-only preview of the My Keep screen with sample data, so the screen can
 * be looked at without a real Keep on a relay.
 *
 * On only in a dev build (`import.meta.env.DEV`) AND when the page URL's query
 * string carries `keep-preview` (e.g. `http://localhost:5174/?keep-preview#/...`).
 * MyKeep gates every use of this module on `import.meta.env.DEV`, so a
 * production build drops it entirely. The sample Keeps are shown through the
 * same rendering path as real ones; nothing here touches a relay.
 */
import type { Keep } from './keep';

/** True only for a dev build whose URL query string has the `keep-preview` flag. */
export function keepPreviewEnabled(isDev: boolean, search: string): boolean {
  if (!isDev) return false;
  return new URLSearchParams(search).has('keep-preview');
}

/** Shown on the screen while the preview is on. */
export const KEEP_PREVIEW_BANNER = 'Preview — sample Keeps, not real ones.';

const SAMPLE_NODE_ONLINE = 'a1'.repeat(32);
const SAMPLE_NODE_OFFLINE = 'b2'.repeat(32);

/**
 * Two sample Keeps owned by `owner`: one online (status card about a minute
 * old) and one that has not been heard from for three days. Every field the
 * status-card parser reads (`createdAt`, `freeBytes`, `software`) is filled.
 */
export function keepPreviewKeeps(owner: string, now: number): Keep[] {
  const claim = (node: string, id: string, name: string, region: string, age: number) => ({
    node, eventId: id.repeat(32), author: owner, createdAt: now - age, role: 'box' as const, region, name,
  });
  return [
    {
      claim: claim(SAMPLE_NODE_ONLINE, 'c3', 'Sample Keep (hallway)', 'Scotland', 30 * 86400),
      status: { createdAt: now - 60, freeBytes: 412 * 2 ** 30, software: 'bothy-node/0.3.1' },
    },
    {
      claim: claim(SAMPLE_NODE_OFFLINE, 'd4', 'Sample Keep (shed)', 'Highlands', 90 * 86400),
      status: { createdAt: now - 3 * 86400, freeBytes: 96 * 2 ** 30, software: 'bothy-node/0.2.0' },
    },
  ];
}
