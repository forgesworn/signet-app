/**
 * Companion data rail — publish-on-change. For each active grant, rebuild the
 * scoped, secret-stripped snapshot on any contacts/kens mutation (debounced),
 * hash-dedupe, and republish. Mirrors useKensSync. Silent best-effort:
 * failures leave local IDB authoritative and retry on next mutation/unlock.
 */
import { useEffect, useRef } from 'react';
import type { SignetIdentity, Contact } from '../types';
import type { KenEntry, KindredEntry } from '@forgesworn/kenspeckle';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import * as db from '../lib/db';
import { publishSnapshot } from '../lib/companion-rail';
import { contactToKindredEntry } from '../lib/kindred-adapter';
import { identityKeypairs } from '../lib/contacts-sync';

const DEBOUNCE_MS = 1000;

interface Options {
  identity: SignetIdentity | null;
  railBackends: Map<string, DecryptingSigningBackend>; // appPubkey -> rail backend
  relayUrl: string;
  encryptionKey: string | null; // needed to decrypt contact bodies (displayName/sharedSecret)
  contacts: Contact[];
  kens: KenEntry[];
  enabled: boolean; // false in bunker mode (no mnemonic) or when no grants
}

function nowSec(): number { return Math.floor(Date.now() / 1000); }

export function useCompanionRail({ identity, railBackends, relayUrl, encryptionKey, contacts, kens, enabled }: Options) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !identity || !relayUrl || !encryptionKey || railBackends.size === 0) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      try {
        const grants = await db.listCompanionGrants();
        const owners = identityKeypairs(identity);
        // Gather the full cross-persona entry set once. getContacts needs the
        // encryption key — contact bodies (displayName/sharedSecret) are encrypted at rest.
        // No sanitising/dropping here — `publishSnapshot` -> `filterByScope`
        // (companion-rail.ts) is the one place that sanitises addedAt and
        // drops what can't be made valid, for contacts AND kens alike.
        const contactEntries: KindredEntry[] = (
          await Promise.all(owners.map(pk => db.getContacts(pk, encryptionKey)))
        ).flat().map(contactToKindredEntry);
        const kenEntries: KindredEntry[] = (
          await Promise.all(owners.map(pk => db.getKens(pk)))
        ).flat();
        const all = [...contactEntries, ...kenEntries];

        for (const grant of grants) {
          if (grant.revokedAt) continue;
          const backend = railBackends.get(grant.appPubkey);
          if (!backend) continue;
          // Each grant gets its own try/catch (kenspeckle 0.2.0 companion-rail
          // maintainer finding): one grant's envelope failing must not stop
          // the loop from reaching the rest — publish-on-change is the ONLY
          // path some grants get republished on, so a single bad snapshot
          // (or any other per-grant throw) previously starved every OTHER
          // paired app of updates on every retry.
          try {
            const res = await publishSnapshot(
              grant.scope, all, nowSec(), backend, grant.appPubkey, grant.snapshotRelay || relayUrl,
            );
            if (res.ok && res.hash !== grant.lastPayloadHash) {
              // I2 — revoke may have raced this debounced publish: re-check the
              // row right before writing back. If it's gone (deleted) or has
              // been (soft-)tombstoned (`revokedAt` set) since this loop
              // started gathering entries, don't resurrect it by writing a
              // fresh lastPayloadHash/lastPublishedAt over the revoke.
              const current = await db.getCompanionGrant(grant.appPubkey);
              if (!current || current.revokedAt) continue;
              await db.saveCompanionGrant({
                ...grant,
                lastPayloadHash: res.hash,
                lastPublishedAt: nowSec(),
                lastEventId: res.eventId ?? grant.lastEventId,
              });
            }
          } catch { /* non-fatal — this grant retries on the next mutation/unlock */ }
        }
      } catch { /* non-fatal — retry on next mutation */ }
    }, DEBOUNCE_MS);

    return () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };
  }, [identity, railBackends, relayUrl, encryptionKey, contacts, kens, enabled]);
}
