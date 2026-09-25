import { contactMailboxPlan } from '../lib/contact-mailbox-plan';
import { useEffect, useRef, useState } from 'react';
import { SimplePool } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';
import { deriveContactMailboxSecret } from '@forgesworn/signet-contacts';
import { openContactMailboxWrap } from '@forgesworn/signet-contacts/adapters/invite-nostr-tools';
import { loadContactInviteVault, recordContactArrival } from '../lib/contact-invite-store';
import type { ContactInviteService } from '../lib/contact-invite-service';

export interface ContactInviteScope { directoryId: string; identities: string[] }
/** Separate pools per identity; never subscribe an identity key itself. */
export function useContactInviteMailboxes(options: {
  encryptionKey: string | null; scopes: ContactInviteScope[]; version: number;
  service(directoryId: string, isCurrent: () => boolean): ContactInviteService;
  onChanged(): void;
}) {
  const latest = useRef(options); latest.current = options;
  const scopeKey = JSON.stringify(options.scopes);
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60000));
  const closing = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!options.encryptionKey) return;
    const timer = setInterval(() => setMinute(Math.floor(Date.now() / 60000)), 1000);
    return () => clearInterval(timer);
  }, [options.encryptionKey]);
  useEffect(() => {
    if (!options.encryptionKey) return;
    let cancelled = false;
    const pools: Array<{ pool: SimplePool; relays: Set<string>; stops: Array<() => Promise<void>> }> = [];
    const valid = () => !cancelled;
    let queue = Promise.resolve();
    const changed = () => { if (valid()) latest.current.onChanged(); };
    const start = async () => {
      await closing.current;
      if (!valid()) return;
      for (const scope of options.scopes) {
        const state = await loadContactInviteVault(scope.directoryId, options.encryptionKey!);
        if (!valid()) return;
        const now = Math.floor(Date.now() / 1000);
        for (const identity of scope.identities) {
          const { bindings } = contactMailboxPlan(state, identity, now);
          if (!bindings.length) continue;
          const owned = { pool: new SimplePool(), relays: new Set<string>(), stops: [] as Array<() => Promise<void>> };
          pools.push(owned);
          const seen = new Set([...state.arrivals.map(a => a.id), ...state.outbox.map(o => o.id)]);
          for (const binding of bindings) {
            const secret = deriveContactMailboxSecret(binding.secret);
            let pubkey: string;
            try { pubkey = getPublicKey(secret); } finally { secret.fill(0); }
            for (const relay of binding.relays) owned.relays.add(relay);
            let attempted = 0;
            const sub = owned.pool.subscribeMany(binding.relays, { kinds: [1059], '#p': [pubkey], since: now - 32 * 86400, limit: 128 }, {
              onevent: event => {
                if (!valid() || seen.has(event.id) || attempted++ >= 128) return;
                seen.add(event.id);
                const packet = openContactMailboxWrap(event, binding.secret);
                if (!packet) return;
                queue = queue.then(async () => {
                  if (!valid()) return;
                  const result = await recordContactArrival(scope.directoryId, options.encryptionKey!, {
                    id: event.id, inviteId: binding.id, identityPubkey: identity, packet,
                    receivedAt: Math.floor(Date.now() / 1000), channel: binding.channel,
                  });
                  if (result.arrivals.some(a => a.id === event.id)) changed();
                }).catch(() => { /* Bounded local storage failure is retried on next subscription. */ });
              },
            });
            owned.stops.push(async () => { await sub.close(); });
          }
        }
      }
    };
    void start().catch(() => { /* Local state remains; no identity work on arrival. */ });
    return () => {
      cancelled = true;
      // Each replacement waits for the previous pools to close; otherwise a
      // burst of state updates could briefly multiply the connection budget.
      const previous = closing.current;
      closing.current = previous.then(() => Promise.allSettled(pools.map(async owned => {
        await Promise.allSettled(owned.stops.map(stop => stop()));
        owned.pool.close([...owned.relays]);
      })));
    };
  }, [options.encryptionKey, scopeKey, options.version, minute]);

  useEffect(() => {
    if (!options.encryptionKey) return;
    let cancelled = false, running = false;
    const valid = () => !cancelled;
    const run = async () => {
      if (running || cancelled) return;
      running = true;
      try {
        for (const scope of latest.current.scopes) {
          if (!valid()) return;
          const service = latest.current.service(scope.directoryId, valid);
          // Ordinary requests stay unopened. Replies to a previously initiated
          // exchange may finish automatically, under the same unlock budget.
          await service.processAppInvites(Math.floor(Date.now() / 1000));
          await service.openInbox(Math.floor(Date.now() / 1000), true);
          await service.flush(Math.floor(Date.now() / 1000));
          await service.cleanup(Math.floor(Date.now() / 1000));
        }
      } catch { /* Durable outbox survives connection/signer failures. */ }
      finally { running = false; }
    };
    const timer = setInterval(() => { void run(); }, 15000);
    const online = () => { void run(); };
    window.addEventListener('online', online);
    void run();
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('online', online); };
  }, [options.encryptionKey, scopeKey]);
}
