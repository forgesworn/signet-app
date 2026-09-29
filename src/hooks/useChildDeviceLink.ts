/**
 * Child side of a child-direct Heartwood pairing, after the handshake
 * (spec §4 step 6, §5.2; amendment A18).
 *
 *   rules     the guardian → child rules payload. The encrypted cache is read
 *             first, then the rules rail on the rail relay (authored by the
 *             rail key, `#p` = our client key). The newest `updatedAt` wins;
 *             an older event is ignored. No cache and no live payload ⇒ null,
 *             which the gate treats as "ask for everything" (fail closed).
 *   personas  the identity-approvals ceremony: for every persona other than
 *             the bound one, `nip44_encrypt` AS that persona (to itself, a
 *             fixed plaintext) so the Heartwood shows ALLOW AS once. Runs one
 *             at a time, once per persona that has no recorded state, after
 *             the router is up — and again when a new persona appears.
 *             A failed persona waits for `retryApproval`.
 *
 * A legacy phone pairing (`mode` absent / 'phone') does nothing here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NostrEvent, NostrFilter } from 'signet-protocol';
import type { PairedChildRecord } from '../types';
import type { BunkerBackendRouter } from '../lib/bunker-router';
import { CHILD_RULES_WIRE_D_TAG, newerRulesPayload, openChildRulesEvent, type ChildRulesPayload } from '../lib/child-rules-wire';
import { loadChildRulesCache, saveChildRulesCache } from '../lib/db';
import { subscribeEvents } from '../lib/relay-service';

export const APPROVE_IDENTITY_PLAINTEXT = 'signet:approve-identity:v1';

type Approval = 'approved' | 'waiting' | 'failed';

export interface ChildLinkTransport {
  subscribe(filters: NostrFilter[], relays: string[], onEvent: (ev: NostrEvent) => void): () => void;
}
const defaultTransport: ChildLinkTransport = {
  subscribe: (filters, relays, onEvent) => subscribeEvents(filters, relays, onEvent),
};

export interface UseChildDeviceLinkOpts {
  record: PairedChildRecord | null;
  encryptionKey: string | null;
  router: BunkerBackendRouter | null;
  onRecordUpdated(r: PairedChildRecord): Promise<void>;
  /** Non-dormant personas from the persona inventory (bound persona included or not). */
  inventoryPersonas?: { pubkey: string; name: string }[];
  /** A26: slots never addressed on this install (the dormant real identity). */
  withheldSlots?: string[];
  transport?: ChildLinkTransport;
}

export interface ChildDeviceLink {
  rules: ChildRulesPayload | null;
  personas: { pubkey: string; name: string; approval: Approval }[];
  retryApproval(persona: string): Promise<void>;
  /** Set by the unpaired signal (Task 12). */
  unpaired: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function useChildDeviceLink(opts: UseChildDeviceLinkOpts): ChildDeviceLink {
  const { encryptionKey, router, onRecordUpdated } = opts;
  const transport = opts.transport ?? defaultTransport;
  const direct = opts.record?.mode === 'heartwood-direct' ? opts.record : null;
  const depId = direct?.dependantPubkey ?? null;
  const clientPub = direct?.clientKeypair.publicKey ?? null;
  const clientPriv = direct?.clientKeypair.privateKey ?? null;
  const railPub = direct?.railPubkey ?? null;
  const railRelay = direct?.railRelay ?? null;
  const bound = direct?.personaPubkey ?? null;

  const recordRef = useRef(direct);
  recordRef.current = direct;
  const onUpdatedRef = useRef(onRecordUpdated);
  onUpdatedRef.current = onRecordUpdated;
  const transportRef = useRef(transport);
  transportRef.current = transport;

  // ── Rules ────────────────────────────────────────────────────────────────
  const [rules, setRules] = useState<ChildRulesPayload | null>(null);
  const rulesRef = useRef<ChildRulesPayload | null>(null);

  useEffect(() => {
    rulesRef.current = null;
    setRules(null);
    if (!depId || !clientPub || !clientPriv || !railPub || !railRelay || !encryptionKey) return;
    let cancelled = false;
    const apply = (incoming: ChildRulesPayload | null): boolean => {
      if (cancelled || !incoming) return false;
      const next = newerRulesPayload(rulesRef.current, incoming);
      if (next === rulesRef.current) return false;
      rulesRef.current = next;
      setRules(next);
      return true;
    };
    void loadChildRulesCache(depId, encryptionKey).then(apply).catch(() => { /* no cache ⇒ fail closed */ });
    const unsubscribe = transportRef.current.subscribe(
      [{ kinds: [30078], authors: [railPub], '#d': [CHILD_RULES_WIRE_D_TAG], '#p': [clientPub] }],
      [railRelay],
      (ev) => {
        void openChildRulesEvent(ev, clientPriv, { railPubkey: railPub, dependantId: depId }).then((p) => {
          if (p && apply(p)) void saveChildRulesCache(depId, p, encryptionKey).catch(() => { /* next event retries */ });
        });
      },
    );
    return () => { cancelled = true; unsubscribe(); };
  }, [depId, clientPub, clientPriv, railPub, railRelay, encryptionKey]);

  // ── Identity approvals ceremony ──────────────────────────────────────────
  const [approvals, setApprovals] = useState<Record<string, Approval>>({});
  const approvalsRef = useRef<Record<string, Approval>>({});
  const attempted = useRef(new Set<string>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const recordKey = direct ? `${direct.id}:${clientPub}` : '';

  useEffect(() => {
    const initial = { ...(recordRef.current?.identityApprovals ?? {}) };
    approvalsRef.current = initial;
    setApprovals(initial);
    attempted.current = new Set();
  }, [recordKey]);

  const invKey = (opts.inventoryPersonas ?? []).map(p => `${p.pubkey}:${p.name}`).join(',');
  const withheldKey = (opts.withheldSlots ?? []).map(w => w.toLowerCase()).join(',');
  const candidates = useMemo(() => {
    if (!direct) return [];
    const out = new Map<string, string>();
    for (const p of direct.personas ?? []) if (HEX64.test(p.pubkey)) out.set(p.pubkey, p.name);
    for (const p of opts.inventoryPersonas ?? []) if (HEX64.test(p.pubkey)) out.set(p.pubkey, p.name);
    if (bound && !out.has(bound)) out.set(bound, direct.dependantName);
    for (const w of withheldKey ? withheldKey.split(',') : []) if (w !== bound) out.delete(w);
    return [...out].map(([pubkey, name]) => ({ pubkey, name }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content, not identity
  }, [recordKey, bound, invKey, direct?.personas, withheldKey]);

  const setApproval = useCallback((persona: string, state: Approval) => {
    const next = { ...approvalsRef.current, [persona]: state };
    approvalsRef.current = next;
    setApprovals(next);
    const rec = recordRef.current;
    if (rec && state !== 'waiting') void onUpdatedRef.current({ ...rec, identityApprovals: next }).catch(() => { /* re-run next start */ });
  }, []);

  const routerRef = useRef(router);
  routerRef.current = router;

  const approve = useCallback((persona: string): Promise<void> => {
    const run = queue.current.then(async () => {
      const r = routerRef.current;
      const current = !!r && r.primaryClientPubkeyHex === recordRef.current?.clientKeypair.publicKey;
      const backend = current ? r.backendFor(persona) : null;
      if (!backend) { setApproval(persona, 'failed'); return; }
      setApproval(persona, 'waiting');
      try {
        await backend.nip44Encrypt(persona, APPROVE_IDENTITY_PLAINTEXT);
        setApproval(persona, 'approved');
      } catch {
        setApproval(persona, 'failed');
      }
    });
    queue.current = run.catch(() => { /* keep the chain alive */ });
    return run;
  }, [setApproval]);

  // A27: after a re-pair the previous router may still be up for a render or
  // two; only a router riding THIS record's client key may run the ceremony.
  const routerCurrent = !!router && !!clientPub && router.primaryClientPubkeyHex === clientPub;

  useEffect(() => {
    if (!router || !bound || !routerCurrent) return;
    for (const { pubkey } of candidates) {
      if (pubkey === bound || attempted.current.has(pubkey)) continue;
      const state = approvalsRef.current[pubkey];
      if (state === 'approved' || state === 'failed') continue;
      attempted.current.add(pubkey);
      void approve(pubkey);
    }
  }, [router, routerCurrent, bound, candidates, approve]);

  const retryApproval = useCallback(async (persona: string) => {
    if (!HEX64.test(persona) || persona === bound) return;
    attempted.current.add(persona);
    await approve(persona);
  }, [approve, bound]);

  const personas = useMemo(() => candidates.map(({ pubkey, name }) => ({
    pubkey, name, approval: (pubkey === bound ? 'approved' : approvals[pubkey] ?? 'waiting') as Approval,
  })), [candidates, approvals, bound]);

  return { rules, personas, retryApproval, unpaired: false };
}
