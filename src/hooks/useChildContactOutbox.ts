import { useEffect, useRef, useState } from 'react';
import { loadPairedChild } from '../lib/db';
import { extractEndpointPubkey } from '../lib/dependant-status-sync';
import { loadChildContactOutbox, type ChildContactOutboxEntry } from '../lib/child-contact-exchange';
import type { ChildRequestScope } from '../lib/child-contact-requests';

/** D4 (child). Read-only load of the child's own outgoing-request outbox —
 * the durable record `submitChildContactRequest` (D6) writes to. No relay
 * traffic: this is local state only, refreshed by bumping `version` after a
 * new ask is queued. Scope derivation mirrors `useChildContactReplyInbox`. */
export function useChildContactOutbox(options: {
  enabled: boolean; child: string | null; key: string | null; guardian: string | null; personas: string[]; version: number;
}) {
  const { enabled, child, key, guardian, version } = options;
  const personas = JSON.stringify([...options.personas].sort());
  const session = JSON.stringify([enabled, child, key, guardian, personas, version]);
  const latest = useRef(session); latest.current = session;
  const [entries, setEntries] = useState<ChildContactOutboxEntry[]>([]);
  useEffect(() => {
    setEntries([]);
    if (!enabled || !child || !key || !guardian) return;
    let active = true;
    const current = () => active && latest.current === session;
    void (async () => {
      const pair = await loadPairedChild(child, key); if (!current() || !pair || pair.guardianPubkey !== guardian) return;
      const endpoint = extractEndpointPubkey(pair.bunkerUri); if (!endpoint) return;
      const scope: ChildRequestScope = { guardian, child, endpoint, client: pair.clientKeypair.publicKey, personas: JSON.parse(personas) };
      const loaded = await loadChildContactOutbox(scope, key, current);
      if (current()) setEntries(loaded);
    })().catch(() => { if (current()) setEntries([]); });
    return () => { active = false; };
  }, [enabled, child, key, guardian, personas, version, session]);
  return entries;
}
