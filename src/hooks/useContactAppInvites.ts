import { useEffect, useRef } from 'react';
import { appInviteTag, APP_INVITE_REQUEST_CAPABILITY, APP_INVITE_RECEIVE_CAPABILITY } from '@forgesworn/signet-contacts';
import { listContactGrantsV2 } from '../lib/db';
import { fetchNewestFromRelays } from '../lib/sync-relays';
import { handleContactAppInvite } from '../lib/contact-app-invites';
import type { ContactInviteService } from '../lib/contact-invite-service';

/** Bounded polling of authenticated app slots. No identity mailbox is shared. */
export function useContactAppInvites(options: {
  encryptionKey: string | null; enabled: boolean; identities: string[]; relays: string[];
  service(isCurrent: () => boolean): ContactInviteService;
}) {
  const latest = useRef(options); latest.current = options;
  const scope = JSON.stringify(options.identities);
  useEffect(() => {
    const key = options.encryptionKey;
    if (!key || !options.enabled) return;
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
    const timer = setInterval(() => { void run().catch(() => {}); }, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [options.encryptionKey, options.enabled, scope]);
}
