/**
 * Guardian side of the child-direct Heartwood pairing (spec §4 steps 1, 3, 4;
 * re-pair; §9.4 unpair; amendments A2-A4, A9).
 *
 *   start()  preconditions → ensure the rail key (`dep.bunkerEndpoint`) →
 *            one-time code → QR offer → listen on the rail relay for the
 *            child's pairing request (hashed d-tag, A2).
 *   request  first valid request (right code, unexpired, author == clientPubkey)
 *            → `confirm`: both phones show `pairCheckWords(code, clientPubkey)`.
 *            A second, DIFFERENT author for the same code aborts; the code is burned.
 *   confirmMatch()  code marked used BEFORE minting, expiry re-checked against
 *            our own offer time, legacy grants seeded into rules BEFORE compiling,
 *            then `nostrconnect_v2` with the compiled child-direct policy →
 *            `list_clients` verification → save `childDevice` +
 *            `authorizedClientPubkey` → revoke the previous phone's slot →
 *            reply on the rail.
 *   A4       any mint error (incl. the operator client's 35 s timeout) →
 *            `list_clients` reconcile, revoking a slot of ours we never confirmed.
 *   unpair() operator `revoke_client`, then clear `childDevice` + `authorizedClientPubkey`.
 *
 * Nothing here throws out of an effect; `unpair` rejects with copy.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent, NostrFilter } from 'signet-protocol';
import type { DependantIdentity } from '../types';
import type { RememberedGrant } from '../types/grants';
import type { DeviceStatus } from '../lib/heartwood-mgmt-types';
import { listClients, nostrconnectV2, revokeClient, type HeartwoodMgmtClient } from '../lib/heartwood-mgmt';
import { publishEvent, subscribeEvents } from '../lib/relay-service';
import {
  buildChildPairUri, buildChildPairReplyEvent, CHILD_PAIR_TTL_S, newPairCode,
  openChildPairRequestEvent, pairCheckWords, pairRequestDTag, type ChildPairRequest,
} from '../lib/child-pair-wire';
import { parseNostrConnectURI } from '../lib/nip46';
import { isValidRelayUrl } from '../lib/relay-url';
import { childDirectSlotLabel, compileChildDirectPolicy } from '../lib/policy-compiler';
import { resolveAuditVisibility } from '../lib/audit-visibility';
import { listChildRules, saveChildRule } from '../lib/db';
import { rulesFromLegacyGrants } from '../lib/child-rules';
import {
  childDirectPersona, MAX_CONNECT_SLOTS, replyPersonas, revokeChildDeviceSlot, staticPairBlock,
  supersededSlots, unconfirmedMintSlots, verifyMintedSlot, type PairBlockReason,
} from '../lib/child-device-pairing';
import { CHILD_DEVICE_COPY as COPY } from '../lib/child-device-copy';

export type ChildPairingState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'blocked'; reason: PairBlockReason; labels?: string[] }
  | { phase: 'offer'; uri: string; expiresAt: number }
  | { phase: 'confirm'; words: string[]; clientPubkey: string; expiresAt: number }
  | { phase: 'minting' }
  | { phase: 'paired'; clientPubkey: string; warning?: string }
  | { phase: 'aborted'; reason: 'mismatch' | 'two-requests' }
  | { phase: 'expired' }
  | { phase: 'error'; message: string };

/** Relay seam; tests inject a fake. */
export interface PairingTransport {
  publish(event: NostrEvent, relays: string[]): Promise<{ ok: boolean; message: string }>;
  subscribe(filters: NostrFilter[], relays: string[], onEvent: (ev: NostrEvent) => void): () => void;
}
const defaultTransport: PairingTransport = {
  publish: (event, relays) => publishEvent(event, { relays }),
  subscribe: (filters, relays, onEvent) => subscribeEvents(filters, relays, onEvent),
};

export interface UseChildDevicePairingOpts {
  dependant: DependantIdentity | null;
  operator: HeartwoodMgmtClient | null;
  operatorStatus: DeviceStatus | null;
  guardianNpPubkey: string;
  /** Rail relay (the guardian's relay); carries the pairing request/reply. */
  railRelay: string;
  /** The Heartwood's relays; the child's nostrconnect listens there. */
  hwRelays: string[];
  encryptionKey: string | null;
  /** Remembered grants (for the one-off legacy seed); null while loading. */
  grants: RememberedGrant[] | null;
  /** Persist `bunkerEndpoint` + `childDevice` from `dep` (caller merges onto a fresh read). */
  onDependantUpdated(dep: DependantIdentity): Promise<void>;
  /** Rules were seeded from legacy grants; the caller reloads its rule state. */
  onRulesChanged?(): void;
  transport?: PairingTransport;
  now?: () => number;
}

export interface UseChildDevicePairing {
  state: ChildPairingState;
  start(): void;
  cancel(): void;
  confirmMatch(): Promise<void>;
  rejectMatch(): void;
  unpair(): Promise<void>;
}

interface Session {
  gen: number;
  code: string;
  expiresAtMs: number;
  railPub: string;
  railPriv: string;
  persona: string;
  label: string;
  dep: DependantIdentity;
  hwRelays: string[];
  railRelay: string;
  request: ChildPairRequest | null;
  authors: Set<string>;
  used: boolean;
  unsub: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function useChildDevicePairing(opts: UseChildDevicePairingOpts): UseChildDevicePairing {
  const [state, setStateRaw] = useState<ChildPairingState>({ phase: 'idle' });
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const genRef = useRef(0);
  const sessionRef = useRef<Session | null>(null);
  const mountedRef = useRef(true);

  const setState = useCallback((gen: number, s: ChildPairingState) => {
    if (!mountedRef.current || genRef.current !== gen) return;
    setStateRaw(s);
  }, []);

  const now = () => (optsRef.current.now ?? Date.now)();
  const transport = () => optsRef.current.transport ?? defaultTransport;

  const stopListening = (s: Session | null) => {
    if (!s) return;
    if (s.unsub) { try { s.unsub(); } catch { /* already closed */ } s.unsub = null; }
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  };

  const teardown = useCallback(() => {
    stopListening(sessionRef.current);
    sessionRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; teardown(); };
  }, [teardown]);

  /** Best-effort failure reply so an honest child stops waiting. */
  const replyFailure = async (s: Session, clientPubkeys: string[], reason: string) => {
    for (const client of clientPubkeys) {
      try {
        const ev = await buildChildPairReplyEvent({ v: 1, code: s.code, ok: false, reason, personas: [], stage: s.dep.autonomyStage }, s.railPriv, client);
        await transport().publish(ev, [s.railRelay]);
      } catch { /* best effort */ }
    }
  };

  const onRequestEvent = async (gen: number, ev: NostrEvent) => {
    const s = sessionRef.current;
    if (!s || s.gen !== gen || s.used) return;
    if (now() > s.expiresAtMs) return;
    const req = await openChildPairRequestEvent(ev, s.railPriv, { code: s.code, nowS: Math.floor(now() / 1000) });
    if (!req || sessionRef.current !== s || s.used) return;
    if (!s.request) {
      s.request = req;
      s.authors.add(req.clientPubkey);
      setState(gen, { phase: 'confirm', words: pairCheckWords(s.code, req.clientPubkey), clientPubkey: req.clientPubkey, expiresAt: s.expiresAtMs });
      return;
    }
    if (req.clientPubkey === s.request.clientPubkey) return; // the same phone again
    // A3: a second, different author answered the same code — burn it.
    s.authors.add(req.clientPubkey);
    s.used = true;
    stopListening(s);
    sessionRef.current = null;
    setState(gen, { phase: 'aborted', reason: 'two-requests' });
    await replyFailure(s, [...s.authors], 'two-requests');
  };

  const start = useCallback(() => {
    const gen = ++genRef.current;
    teardown();
    setState(gen, { phase: 'checking' });
    void (async () => {
      const o = optsRef.current;
      const dep = o.dependant;
      if (!dep) { setState(gen, { phase: 'error', message: COPY.errors.noDependant }); return; }
      const block = staticPairBlock({ dependant: dep, hasOperator: !!o.operator, status: o.operatorStatus });
      if (block) { setState(gen, { phase: 'blocked', reason: block }); return; }
      const persona = childDirectPersona(dep)!;
      const hwRelays = [...new Set(o.hwRelays)];
      if (!isValidRelayUrl(o.railRelay) || hwRelays.length === 0 || hwRelays.length > 8
        || !hwRelays.every(r => isValidRelayUrl(r)) || !HEX64.test(o.guardianNpPubkey)) {
        setState(gen, { phase: 'error', message: COPY.errors.badRelay });
        return;
      }
      let slots;
      try { slots = await listClients(o.operator!); } catch { setState(gen, { phase: 'blocked', reason: 'offline' }); return; }
      if (genRef.current !== gen) return;
      if (slots.length >= MAX_CONNECT_SLOTS) {
        setState(gen, { phase: 'blocked', reason: 'slots-full', labels: slots.map(sl => sl.label || `#${sl.slotIndex}`) });
        return;
      }
      // Rail key: fresh randomness, never tree-derived, never stripped.
      let working = dep;
      const ep = dep.bunkerEndpoint;
      if (!ep?.privateKey || !HEX64.test(ep.publicKey ?? '')) {
        const sk = generateSecretKey();
        const endpoint = { publicKey: getPublicKey(sk), privateKey: bytesToHex(sk), createdAt: Math.floor(now() / 1000) };
        sk.fill(0);
        working = { ...dep, bunkerEndpoint: endpoint };
        try { await o.onDependantUpdated(working); } catch { setState(gen, { phase: 'error', message: COPY.errors.generic }); return; }
        if (genRef.current !== gen) return;
      }
      const code = newPairCode();
      const offerMs = now();
      const t = Math.floor(offerMs / 1000);
      const expiresAtMs = offerMs + CHILD_PAIR_TTL_S * 1000;
      let uri: string;
      try {
        uri = buildChildPairUri({ v: 2, rail: working.bunkerEndpoint!.publicKey, guardian: o.guardianNpPubkey, dependant: dep.id,
          persona, name: dep.displayName, relay: o.railRelay, hwRelays, code, t });
      } catch { setState(gen, { phase: 'error', message: COPY.errors.generic }); return; }
      const session: Session = {
        gen, code, expiresAtMs, railPub: working.bunkerEndpoint!.publicKey, railPriv: working.bunkerEndpoint!.privateKey,
        persona, label: childDirectSlotLabel(dep.id.toLowerCase()), dep: working, hwRelays, railRelay: o.railRelay,
        request: null, authors: new Set(), used: false, unsub: null, timer: null,
      };
      sessionRef.current = session;
      session.unsub = transport().subscribe(
        [{ kinds: [30078], '#p': [session.railPub], '#d': [pairRequestDTag(code)], since: t - 60 }],
        [o.railRelay],
        (ev) => { void onRequestEvent(gen, ev); },
      );
      session.timer = setTimeout(() => {
        if (sessionRef.current !== session || session.used) return;
        stopListening(session);
        sessionRef.current = null;
        setState(gen, { phase: 'expired' });
      }, expiresAtMs - offerMs);
      setState(gen, { phase: 'offer', uri, expiresAt: expiresAtMs });
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teardown, setState]);

  const cancel = useCallback(() => {
    const gen = ++genRef.current;
    teardown();
    setState(gen, { phase: 'idle' });
  }, [teardown, setState]);

  const rejectMatch = useCallback(() => {
    const s = sessionRef.current;
    if (!s || !s.request || s.used) return;
    s.used = true;
    stopListening(s);
    sessionRef.current = null;
    setState(s.gen, { phase: 'aborted', reason: 'mismatch' });
    void replyFailure(s, [...s.authors], 'check-mismatch');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setState]);

  const confirmMatch = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || !s.request || s.used) return;
    const gen = s.gen;
    // A9: burn the code BEFORE anything is minted; expiry is our own offer time.
    s.used = true;
    stopListening(s);
    sessionRef.current = null;
    if (now() > s.expiresAtMs) { setState(gen, { phase: 'expired' }); return; }
    const o = optsRef.current;
    const op = o.operator;
    const req = s.request;
    const nc = parseNostrConnectURI(req.nostrconnect);
    if (!op || !o.encryptionKey || !nc || nc.clientPubkey.toLowerCase() !== req.clientPubkey) {
      setState(gen, { phase: 'error', message: op ? COPY.errors.generic : COPY.blocked['no-operator-key'].body });
      return;
    }
    setState(gen, { phase: 'minting' });
    const dep = s.dep;
    const nowMs = now();

    // A9: seed the rules from legacy grants BEFORE compiling the mint policy.
    let rules;
    try {
      rules = await listChildRules(dep.id, o.encryptionKey);
      if (rules.length === 0 && o.grants) {
        const seeded = rulesFromLegacyGrants(dep.id, o.grants, nowMs);
        for (const r of seeded) await saveChildRule(r, o.encryptionKey);
        rules = seeded;
        if (seeded.length > 0) o.onRulesChanged?.();
      }
    } catch { setState(gen, { phase: 'error', message: COPY.errors.generic }); return; }

    const policy = compileChildDirectPolicy({
      stage: dep.autonomyStage,
      paused: dep.defaultSchedule?.paused === true,
      rules,
      approvedOnceKinds: [],
      boundPersona: s.persona,
      auditVisible: resolveAuditVisibility(dep.autonomyStage, dep.auditVisibility),
      nowSeconds: Math.floor(nowMs / 1000),
    });

    let minted;
    try {
      minted = await nostrconnectV2(op, {
        clientPubkey: req.clientPubkey, secret: nc.secret, createdAt: req.createdAt,
        relay: s.hwRelays[0], identity: s.persona, label: s.label, policy,
      });
    } catch (e) {
      // A4: the device may have created the slot before the reply was lost.
      const errIndex = (e as { slotIndex?: unknown })?.slotIndex;
      let clean = true;
      try {
        const slots = await listClients(op);
        for (const stray of unconfirmedMintSlots(slots, { label: s.label, clientPubkey: req.clientPubkey,
          slotIndex: typeof errIndex === 'number' ? errIndex : undefined })) {
          try { await revokeClient(op, { slotIndex: stray.slotIndex, secretFingerprint: stray.secretFingerprint }); } catch { clean = false; }
        }
      } catch { clean = false; }
      setState(gen, { phase: 'error', message: clean ? COPY.errors.mint : COPY.errors.mintUnconfirmed });
      void replyFailure(s, [req.clientPubkey], 'mint-failed');
      return;
    }

    const revokeMinted = async () => {
      try { await revokeClient(op, { slotIndex: minted.slotIndex, secretFingerprint: minted.secretFingerprint }); return true; } catch { return false; }
    };

    // A9: the slot must now list exactly what we asked for.
    let slots;
    try { slots = await listClients(op); } catch { slots = null; }
    const verified = slots ? verifyMintedSlot(slots, { slotIndex: minted.slotIndex, secretFingerprint: minted.secretFingerprint,
      label: s.label, persona: s.persona, clientPubkey: req.clientPubkey, policy }) : null;
    if (!slots || !verified) {
      const ok = await revokeMinted();
      setState(gen, { phase: 'error', message: ok ? COPY.errors.verify : COPY.errors.mintUnconfirmed });
      void replyFailure(s, [req.clientPubkey], 'verify-failed');
      return;
    }

    const updated: DependantIdentity = {
      ...dep,
      bunkerEndpoint: { ...dep.bunkerEndpoint!, authorizedClientPubkey: req.clientPubkey, pairingSecret: undefined },
      childDevice: {
        mode: 'heartwood-direct', slotLabel: s.label, secretFingerprint: minted.secretFingerprint,
        slotIndex: minted.slotIndex, clientPubkey: req.clientPubkey, boundPersona: s.persona, pairedAt: now(),
      },
    };
    try {
      await o.onDependantUpdated(updated);
    } catch {
      const ok = await revokeMinted();
      setState(gen, { phase: 'error', message: ok ? COPY.errors.save : COPY.errors.mintUnconfirmed });
      void replyFailure(s, [req.clientPubkey], 'save-failed');
      return;
    }

    // Re-pair: the old phone's slot goes only now the new one has answered.
    let warning: string | undefined;
    for (const old of supersededSlots(slots, s.label, minted)) {
      try { await revokeClient(op, { slotIndex: old.slotIndex, secretFingerprint: old.secretFingerprint }); }
      catch { warning = COPY.pairedOldSlotWarning; }
    }

    try {
      const reply = await buildChildPairReplyEvent({ v: 1, code: s.code, ok: true, personas: replyPersonas(dep), stage: dep.autonomyStage },
        s.railPriv, req.clientPubkey);
      await transport().publish(reply, [s.railRelay]);
    } catch { /* the child retries its fetch; the slot is live either way */ }

    setState(gen, { phase: 'paired', clientPubkey: req.clientPubkey, ...(warning ? { warning } : {}) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setState]);

  const unpair = useCallback(async () => {
    const o = optsRef.current;
    const dep = o.dependant;
    if (!dep?.childDevice) return;
    if (!o.operator) throw new Error(COPY.blocked['no-operator-key'].body);
    try { await revokeChildDeviceSlot(o.operator, dep); } catch { throw new Error(COPY.errors.unpair); }
    await o.onDependantUpdated({
      ...dep,
      childDevice: undefined,
      bunkerEndpoint: dep.bunkerEndpoint ? { ...dep.bunkerEndpoint, authorizedClientPubkey: undefined } : undefined,
    });
    const gen = ++genRef.current;
    teardown();
    setState(gen, { phase: 'idle' });
  }, [teardown, setState]);

  return { state, start, cancel, confirmMatch, rejectMatch, unpair };
}
