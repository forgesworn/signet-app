import { useEffect, useRef } from 'react';
import { appInviteTag, APP_INVITE_REQUEST_CAPABILITY, APP_INVITE_RECEIVE_CAPABILITY } from '@forgesworn/signet-contacts';
import { listContactGrantsV2 } from '../lib/db';
import { fetchNewestFromRelays } from '../lib/sync-relays';
import { handleContactAppInvite } from '../lib/contact-app-invites';
import type { ContactInviteService } from '../lib/contact-invite-service';
import { useAppForeground } from './useAppForeground';

/** Each poll asks a relay per grant and decrypts the grants: every 30 s while
 * the app is on screen (it was every 5 s, always, which kept the phone's CPU
 * and radio busy). In the background only when always-on serving is set, every
 * 60 s: an app's request is valid for 300 s, and serving connected apps while
 * closed is what always-on is for. */
export const APP_INVITE_POLL_MS = 30_000;
export const APP_INVITE_BACKGROUND_POLL_MS = 60_000;

/** Bounded polling of authenticated app slots. No identity mailbox is shared. */
export function useContactAppInvites(options: {
  encryptionKey: string | null; enabled: boolean; identities: string[]; relays: string[];
  service(isCurrent: () => boolean): ContactInviteService;
  /** Always-on serving: keep answering apps while the app is closed. */
  serveInBackground?: boolean;
}) {
  const latest = useRef(options); latest.current = options;
  const scope = JSON.stringify(options.identities);
  const foreground = useAppForeground();
  const polling = foreground || !!options.serveInBackground;
  useEffect(() => {
    const key = options.encryptionKey;
    if (!key || !options.enabled || !polling) return;
    let cancelled = false, running = false;
    const seen = new Set<string>();
    const valid = () => !cancelled && latest.current.encryptionKey === key && latest.current.enabled;
    const run = async () => {
      if (running || !valid()) return;
      running = true;
      try {
        const grants = await listContactGrantsV2(key);
        for (const grant of grants.filter(g => !g.revokedAt && g.directoryId === 'owner' && !!g.ownerIdentityPubkey
          && latest.current.identities.includes(g.ownerIdentityPubkey)
          && g.capabilities.some(cap => [APP_INVITE_REQUEST_CAPABILITY, APP_INVITE_RECEIVE_CAPABILITY].includes(cap as typeof APP_INVITE_REQUEST_CAPABILITY))).slice(0, 10)) {
          if (!valid()) return;
          try {
            const { event } = await fetchNewestFromRelays({ kinds: [30078], authors: [grant.appPubkey],
              '#d': [appInviteTag(grant.grantId)], since: Math.floor(Date.now() / 1000) - 300, limit: 1 }, [grant.relay], grant.appPubkey);
            if (!event || seen.has(event.id) || !valid()) continue;
            if (await handleContactAppInvite({ grantId: grant.grantId, event, encryptionKey: key,
              service: latest.current.service(valid), identities: latest.current.identities, relays: latest.current.relays,
              now: Math.floor(Date.now() / 1000), isCurrent: valid })) {
              seen.add(event.id);
              if (seen.size > 512) seen.delete(seen.values().next().value!);
            }
          } catch { /* Retry durable replies; the service limits signing attempts per unlock. */ }
        }
      } finally { running = false; }
    };
    void run().catch(() => {});
    const timer = setInterval(() => { void run().catch(() => {}); }, foreground ? APP_INVITE_POLL_MS : APP_INVITE_BACKGROUND_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [options.encryptionKey, options.enabled, scope, foreground, polling]);
}
