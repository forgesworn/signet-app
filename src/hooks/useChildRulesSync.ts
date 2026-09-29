import { useEffect, useMemo, useRef, useState } from 'react';
import type { SignetIdentity } from '../types';
import type { ChildRule } from '../types/child-rules';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import { guardedSigningBackend } from '../lib/guarded-signing-backend';
import {
  publishChildRulesSync,
  fetchChildRulesSync,
  mergeChildRules,
  isRulesRicherThan,
  CHILD_RULES_SYNC_D_TAG,
} from '../lib/child-rules-sync';
import { createSyncDecryptCache } from '../lib/sync-decrypt-cache';
import { resolveHookRelays } from '../lib/sync-relays';
import { getSyncSeen, setSyncSeen, classifyFetchOutcome, type SyncRemoteState } from '../lib/sync-seen';
import { schedulePublish, type PendingPublish } from '../lib/pending-publish';
import { useSyncReadRetry } from './useSyncReadRetry';

const PUBLISH_DEBOUNCE_MS = 2000;

/** Stable hash for publish idempotency. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)]));
  }
  return v;
}
/** `lastUsedAt` is device-local usage metadata: it must never trigger a publish. */
function hashRules(rules: ChildRule[]): string {
  return JSON.stringify(canon([...rules].map(({ lastUsedAt: _u, ...r }) => { void _u; return r; }).sort((a, b) => a.id.localeCompare(b.id))));
}

interface Options {
  publishEnabled?: boolean;
  identity: SignetIdentity | null;
  npBackend: DecryptingSigningBackend | null;
  relays?: { read: string[]; write: string[] };
  /** @deprecated Use `relays`. */
  relayUrl?: string;
  encryptionKey: string | null;
  /** Live view of all rules INCLUDING tombstones. */
  rules: ChildRule[] | null;
  /** Fires with the merged set after an inbound fetch changed it; the caller persists it. */
  onMerged: (rules: ChildRule[]) => void;
}

export function useChildRulesSync({ publishEnabled = true, identity, npBackend, relays, relayUrl, encryptionKey, rules, onMerged }: Options): { remoteState: SyncRemoteState | null } {
  const effectiveRelays = resolveHookRelays(relays, relayUrl);
  const readRelaysKey = effectiveRelays.read.join('|');
  const writeRelaysKey = effectiveRelays.write.join('|');

  const decryptCache = useMemo(
    () => (identity?.naturalPerson.publicKey && encryptionKey)
      ? createSyncDecryptCache({ dTag: CHILD_RULES_SYNC_D_TAG, authorPubkey: identity.naturalPerson.publicKey, encryptionKey })
      : undefined,
    [identity?.naturalPerson.publicKey, encryptionKey],
  );

  const rulesRef = useRef<ChildRule[] | null>(rules);
  rulesRef.current = rules;
  const onMergedRef = useRef(onMerged);
  onMergedRef.current = onMerged;

  const syncAuthorRef = useRef<string | undefined>(undefined);
  const hydratedAuthorRef = useRef<string | null>(null);
  const lastPublishedHashRef = useRef<string>('');
  const lastRemoteCreatedAtRef = useRef<number>(0);
  const publishTimerRef = useRef<PendingPublish | null>(null);
  /** The remote rules as last known (fetched or published); null = no remote record. */
  const remoteRulesRef = useRef<ChildRule[] | null>(null);
  /** The remote record exists but was unreadable / partly unparsed: never publish over it. */
  const remoteBlockedRef = useRef(false);
  const rulesLoaded = rules !== null;
  const [hydrated, setHydrated] = useState(false);
  const [remoteState, setRemoteState] = useState<SyncRemoteState | null>(null);
  const readRetry = useSyncReadRetry(remoteState === 'unreachable');

  useEffect(() => {
    const author = identity?.naturalPerson.publicKey;
    if (syncAuthorRef.current !== author) {
      syncAuthorRef.current = author;
      hydratedAuthorRef.current = null;
      lastRemoteCreatedAtRef.current = 0;
      lastPublishedHashRef.current = '';
      remoteRulesRef.current = null;
      remoteBlockedRef.current = false;
      setRemoteState(null);
    }
    if (!identity || !npBackend || effectiveRelays.read.length === 0 || !encryptionKey || !rulesLoaded) return;
    let cancelled = false;
    setHydrated(false);
    remoteBlockedRef.current = false;

    (async () => {
      try {
        const authorPubkey = identity.naturalPerson.publicKey;
        if (!authorPubkey) return;
        const remote = await fetchChildRulesSync(authorPubkey, npBackend, effectiveRelays.read, lastRemoteCreatedAtRef.current || undefined, decryptCache);
        if (cancelled) return;
        if (remote === 'unreachable') { setRemoteState('unreachable'); return; }
        if (remote === 'unusable') { remoteBlockedRef.current = true; setRemoteState('present'); return; }
        if (remote === null) {
          if (lastRemoteCreatedAtRef.current > 0) {
            setRemoteState('present');
          } else {
            const seenBefore = !!(await getSyncSeen(authorPubkey, CHILD_RULES_SYNC_D_TAG));
            if (cancelled) return;
            setRemoteState(classifyFetchOutcome({ found: false, reachableRelays: 1, seenBefore }));
          }
          return;
        }
        const local = rulesRef.current ?? [];
        const { merged, changed } = mergeChildRules(local, remote.rules);
        if (cancelled) return;
        lastRemoteCreatedAtRef.current = remote.createdAt;
        remoteRulesRef.current = remote.rules;
        remoteBlockedRef.current = remote.partial === true;
        await setSyncSeen(authorPubkey, CHILD_RULES_SYNC_D_TAG, { eventId: remote.eventId, createdAt: remote.createdAt });
        if (cancelled) return;
        setRemoteState('present');
        // Reseed so we don't republish what we just pulled, but only when the
        // merged set IS the remote's: a local side that won (richer) must be
        // pushed by the publish effect.
        lastPublishedHashRef.current = hashRules(merged) === hashRules(remote.rules) ? hashRules(merged) : '';
        if (changed) onMergedRef.current(merged);
      } finally {
        if (!cancelled) {
          hydratedAuthorRef.current = identity.naturalPerson.publicKey;
          setHydrated(true);
        }
      }
    })().catch(() => { /* non-fatal — next unlock retries */ });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readRetry, identity, npBackend, readRelaysKey, encryptionKey, decryptCache, rulesLoaded]);

  useEffect(() => {
    if (!publishEnabled) return;
    if (!identity || !npBackend || effectiveRelays.write.length === 0 || !encryptionKey) return;
    if (!hydrated || hydratedAuthorRef.current !== identity.naturalPerson.publicKey) return;
    if (remoteState === 'unreachable') return;
    if (!rules) return;

    let cancelled = false;
    const publishingBackend = guardedSigningBackend(npBackend, () => !cancelled);
    if (publishTimerRef.current) publishTimerRef.current.cancel();
    publishTimerRef.current = schedulePublish(async () => {
      publishTimerRef.current = null;
      try {
        if (remoteBlockedRef.current) return;
        const hash = hashRules(rules);
        if (hash === lastPublishedHashRef.current) return;
        // Only push what the remote lacks or loses to.
        const remoteRules = remoteRulesRef.current;
        if (remoteRules !== null && !isRulesRicherThan(rules, remoteRules)) return;
        const ok = await publishChildRulesSync(rules, publishingBackend, effectiveRelays.write);
        if (ok && syncAuthorRef.current === identity.naturalPerson.publicKey) {
          lastPublishedHashRef.current = hash;
          remoteRulesRef.current = rules;
        }
      } catch { /* next debounce cycle retries */ }
    }, PUBLISH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (publishTimerRef.current) { publishTimerRef.current.cancel(); publishTimerRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishEnabled, rules, identity, npBackend, writeRelaysKey, encryptionKey, hydrated, remoteState]);

  return { remoteState };
}
