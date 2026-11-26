/**
 * Child side of a LEGACY phone-paired install (`mode` absent / 'phone'): learn
 * that the guardian revoked this phone, from the `signet:child-unpaired:v1`
 * notice the guardian publishes with the dependant's endpoint key before it
 * clears the endpoint (`legacy-child-unpair.ts`). A direct pairing has its own
 * reader in `useChildDeviceLink`; this one does nothing there.
 *
 * On a valid notice it does what `useChildDeviceLink`'s `markUnpaired` does on
 * a direct install: sets `unpaired` (which shows the unpaired banner and the
 * card notice with "Pair again", and stops the guardian-backdrop fetch) and
 * drops the guardian's card backdrops, keeping the phone's own picks. A legacy
 * install keeps no rules cache, so there is none to clear.
 *
 * Like the direct flag it is held in memory: the notice stays on the relay, so
 * the next unlock reads it again. It resets whenever the pairing changes (a
 * re-pair names a new endpoint and a new pairing time; the client key stays),
 * so a genuine re-pair is never refused and an old notice never undoes it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NostrEvent, NostrFilter } from 'signet-protocol';
import type { PairedChildRecord } from '../types';
import { CHILD_UNPAIRED_D_TAG } from '../lib/child-activity';
import { acceptLegacyUnpairedNotice } from '../lib/legacy-child-unpair';
import { guardianRailPubkey } from '../lib/paired-child-rail';
import { isValidRelayUrl } from '../lib/relay-url';
import { subscribeEvents } from '../lib/relay-service';
import { dropGuardianBackdrops, defaultDropGuardianBackdropDeps } from '../lib/guardian-backdrop-sync';

export interface LegacyUnpairTransport {
  subscribe(filters: NostrFilter[], relays: string[], onEvent: (ev: NostrEvent) => void): () => void;
}
const defaultTransport: LegacyUnpairTransport = {
  subscribe: (filters, relays, onEvent) => subscribeEvents(filters, relays, onEvent),
};

export interface UseLegacyChildUnpairedOpts {
  /** The paired-child record (null on any other install). */
  record: PairedChildRecord | null;
  encryptionKey: string | null;
  /** The relay the persona inventory is read on. */
  relayUrl: string;
  /** Test seams. */
  transport?: LegacyUnpairTransport;
  dropBackdrops?: () => Promise<void>;
}

export function useLegacyChildUnpaired(opts: UseLegacyChildUnpairedOpts): boolean {
  const legacy = opts.record && opts.record.mode !== 'heartwood-direct' ? opts.record : null;
  const endpoint = legacy ? guardianRailPubkey(legacy) : null;
  const clientPub = legacy?.clientKeypair.publicKey.toLowerCase() ?? null;
  const pairedAt = legacy?.pairedAt ?? null;
  const { encryptionKey, relayUrl } = opts;

  const recordRef = useRef(legacy);
  recordRef.current = legacy;
  const transportRef = useRef(opts.transport ?? defaultTransport);
  transportRef.current = opts.transport ?? defaultTransport;
  const dropRef = useRef(opts.dropBackdrops);
  dropRef.current = opts.dropBackdrops;

  const [unpaired, setUnpaired] = useState(false);
  const unpairedRef = useRef(false);
  const markUnpaired = useCallback(() => {
    if (unpairedRef.current) return;
    unpairedRef.current = true;
    setUnpaired(true);
    // The guardian can no longer send this phone anything: the pictures it sent go too. The phone's own picks stay.
    const drop = dropRef.current ?? (() => dropGuardianBackdrops(defaultDropGuardianBackdropDeps()));
    void drop().catch(() => { /* best effort */ });
  }, []);

  useEffect(() => {
    unpairedRef.current = false;
    setUnpaired(false);
    if (!endpoint || !clientPub || pairedAt === null || !encryptionKey || !isValidRelayUrl(relayUrl)) return;
    let cancelled = false;
    const unsubscribe = transportRef.current.subscribe(
      [{ kinds: [30078], authors: [endpoint], '#d': [CHILD_UNPAIRED_D_TAG], '#p': [clientPub] }],
      [relayUrl],
      (ev) => {
        const rec = recordRef.current;
        if (cancelled || !rec) return;
        if (acceptLegacyUnpairedNotice(ev, rec)) markUnpaired();
      },
    );
    return () => { cancelled = true; unsubscribe(); };
  }, [endpoint, clientPub, pairedAt, encryptionKey, relayUrl, markUnpaired]);

  return unpaired;
}
