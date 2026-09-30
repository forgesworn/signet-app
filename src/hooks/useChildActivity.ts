/**
 * Guardian side of the child-direct activity rails (spec §9.1, §9.2).
 *
 * For a dependant whose own phone is paired straight to the Heartwood, listen
 * on the rail relay for (a) the child's gift-wrapped gate decisions (kind
 * 1059, `#p` = rail pubkey) and (b) its connected-apps record. Both are opened
 * with the rail private key — local, no Heartwood cost — with the author
 * pinned to `childDevice.clientPubkey`. `rows` joins them with the Heartwood's
 * own C5 records (`deviceEntries`, from `useAuditLog`) via `mergeActivity`;
 * device records from before the pairing (the guardian's phone-served era)
 * are left out.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NostrEvent, NostrFilter } from 'signet-protocol';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { DependantIdentity } from '../types';
import type { AuditEntry } from '../lib/audit-fetch';
import {
  mergeActivity, openConnectedAppsEvent, unwrapChildActivity, CHILD_CONNECTED_APPS_D_TAG,
  type ChildActivityEntry, type ConnectedChildApp, type MergedActivityRow,
} from '../lib/child-activity';
import { isValidRelayUrl } from '../lib/relay-url';
import { subscribeEvents } from '../lib/relay-service';
import { loadGuardianActing as dbLoadGuardianActing } from '../lib/db';
import type { GuardianActingEntry } from '../lib/guardian-acting';

/** Child records kept (newest). */
export const CHILD_ACTIVITY_KEEP = 1000;
/** Gift-wrap timestamps are randomised up to two days back (NIP-59). */
const WRAP_JITTER_S = 2 * 86_400 + 60;
const TICK_MS = 60_000;
const HEX64 = /^[0-9a-f]{64}$/;

export interface ChildActivityRailTransport {
  subscribe(filters: NostrFilter[], relays: string[], onEvent: (ev: NostrEvent) => void): () => void;
}
const defaultTransport: ChildActivityRailTransport = {
  subscribe: (filters, relays, onEvent) => subscribeEvents(filters, relays, onEvent),
};

export interface UseChildActivityOpts {
  dependant: DependantIdentity | null;
  /** Fallback rail relay(s) for a record without `childDevice.railRelay`. */
  relays: string[];
  /** Null while locked: the hook stays idle. */
  encryptionKey: string | null;
  deviceEntries: AuditEntry[];
  transport?: ChildActivityRailTransport;
  now?: () => number;
  /** A48: this phone's own signings as the child (device-local row). */
  loadGuardianActing?: (encryptionKey: string) => Promise<GuardianActingEntry[]>;
}

export interface ChildActivity {
  apps: ConnectedChildApp[];
  rows: MergedActivityRow[];
}

/** Every pubkey a dependant's Heartwood records can carry. */
export function dependantPersonaPubkeys(dep: DependantIdentity): string[] {
  const out = [dep.id, dep.naturalPerson?.publicKey, dep.persona?.publicKey, ...(dep.extraPersonas ?? []).map(x => x.publicKey)];
  return [...new Set(out.filter((p): p is string => typeof p === 'string' && HEX64.test(p.toLowerCase())).map(p => p.toLowerCase()))];
}

export function useChildActivity(opts: UseChildActivityOpts): ChildActivity {
  const cd = opts.dependant?.childDevice?.mode === 'heartwood-direct' ? opts.dependant.childDevice : null;
  const railPriv = opts.dependant?.bunkerEndpoint?.privateKey ?? '';
  const clientPub = cd?.clientPubkey?.toLowerCase() ?? '';
  const relay = cd?.railRelay ?? opts.relays[0] ?? '';
  const pairedAtS = cd ? Math.floor(cd.pairedAt / 1000) : 0;
  const enabled = !!cd && !!opts.encryptionKey && HEX64.test(railPriv) && HEX64.test(clientPub) && isValidRelayUrl(relay);
  const key = enabled ? `${clientPub}:${relay}` : '';

  const transportRef = useRef(opts.transport ?? defaultTransport);
  transportRef.current = opts.transport ?? defaultTransport;
  const nowRef = useRef(opts.now ?? (() => Date.now()));
  nowRef.current = opts.now ?? (() => Date.now());
  const railPrivRef = useRef(railPriv);
  railPrivRef.current = railPriv;

  const [entries, setEntries] = useState<ChildActivityEntry[]>([]);
  const [apps, setApps] = useState<ConnectedChildApp[]>([]);

  useEffect(() => {
    setEntries([]);
    setApps([]);
    if (!key) return;
    let railPub: string;
    const sk = hexToBytes(railPrivRef.current);
    try { railPub = getPublicKey(sk); } catch { return; } finally { sk.fill(0); }
    let cancelled = false;
    const seen = new Set<string>();
    let newestApps = -1;
    const unsub = transportRef.current.subscribe(
      [
        { kinds: [1059], '#p': [railPub], since: Math.max(0, pairedAtS - WRAP_JITTER_S), limit: 500 } as NostrFilter,
        { kinds: [30078], authors: [clientPub], '#d': [CHILD_CONNECTED_APPS_D_TAG], '#p': [railPub] },
      ],
      [relay],
      (ev) => {
        if (cancelled || !ev || typeof ev.id !== 'string' || seen.has(ev.id)) return;
        seen.add(ev.id);
        if (ev.kind === 1059) {
          void unwrapChildActivity(ev, railPrivRef.current, clientPub).then((e) => {
            if (cancelled || !e) return;
            setEntries(prev => [e, ...prev].sort((a, b) => b.at - a.at).slice(0, CHILD_ACTIVITY_KEEP));
          });
        } else if (ev.kind === 30078) {
          if (ev.created_at <= newestApps) return;
          void openConnectedAppsEvent(ev, railPrivRef.current, clientPub).then((list) => {
            if (cancelled || !list || ev.created_at <= newestApps) return;
            newestApps = ev.created_at;
            setApps(list);
          });
        }
      },
    );
    return () => { cancelled = true; unsub(); };
  }, [key, clientPub, relay, pairedAtS]);

  const [tick, setTick] = useState(0);
  // A48: re-read on every tick and on every refresh of the device records, so
  // a signing this phone just made as the child shows up straight away.
  const [guardianRows, setGuardianRows] = useState<GuardianActingEntry[]>([]);
  const loadGuardianRef = useRef(opts.loadGuardianActing ?? dbLoadGuardianActing);
  loadGuardianRef.current = opts.loadGuardianActing ?? dbLoadGuardianActing;
  const key2 = key ? opts.encryptionKey : null;
  // A value, not the array: a caller may pass a fresh (equal) array each render.
  const deviceSig = `${opts.deviceEntries.length}:${opts.deviceEntries[0]?.id ?? ''}:${opts.deviceEntries[opts.deviceEntries.length - 1]?.id ?? ''}`;
  useEffect(() => {
    if (!key2) { setGuardianRows([]); return; }
    let cancelled = false;
    loadGuardianRef.current(key2).then((rows) => { if (!cancelled) setGuardianRows(rows); }).catch(() => { /* none shown */ });
    return () => { cancelled = true; };
  }, [key2, tick, deviceSig]);
  useEffect(() => {
    if (!key) return;
    const t = setInterval(() => setTick(n => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, [key]);

  const rows = useMemo(() => {
    if (!cd) return [];
    const mine = new Set(opts.dependant ? dependantPersonaPubkeys(opts.dependant) : []);
    const device = opts.deviceEntries.filter(d => d.createdAt >= pairedAtS && mine.has(d.dependantPubkey));
    const mineGuardian = guardianRows.filter(g => g.at >= pairedAtS && mine.has(g.persona));
    return mergeActivity(entries, device, Math.floor(nowRef.current() / 1000), mineGuardian);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` re-ages the mismatch flag
  }, [cd, entries, opts.deviceEntries, opts.dependant, pairedAtS, tick, guardianRows]);

  return { apps, rows };
}
