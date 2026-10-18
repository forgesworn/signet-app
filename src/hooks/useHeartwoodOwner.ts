/**
 * One-hold pairing, Settings side (spec A1b, A8, A9, A10, A11).
 *
 * Owns the three questions the Settings → Heartwood card asks of the device:
 * is this phone's pairing marked as an owner pairing (and in which style),
 * can it be given full access, and can it be taken back. All device calls go
 * over the PRIMARY NIP-46 pairing, except "Turn off full access" which uses
 * the operator channel when an operator key is imported.
 *
 * Gated on the capability: nothing is sent unless the router's
 * `heartwood_capabilities` list names `heartwood_approve_bundle`, so older
 * firmware sees no new request at all. Never on a paired-child install and
 * never off bunker mode.
 *
 * `heartwood_owner_status` is checked once per router (so once per unlock, and
 * again on a reconnect) and again on `refresh()`. The answer `null` means
 * "could not tell", which is never treated as "off".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BunkerSigningBackend } from '../lib/signing-backend';
import type { BunkerBackendRouter } from '../lib/bunker-router';
import type { HeartwoodMgmtClient } from '../lib/heartwood-mgmt';
import { listClients, clearClientIdentities } from '../lib/heartwood-mgmt';
import { withOperatorLock } from '../lib/operator-lock';
import {
  CAP_OWNER_NARROW, fetchOwnerStatus, narrowToCareful, pairWordsForClient, runApproveBundle, supportsApproveBundle,
  type BundleRunResult, type NarrowResult, type OwnerStatus, type OwnerStyle,
} from '../lib/heartwood-one-hold';
import { ownSlotLabel, turnOffFullAccess, type TurnOffResult } from '../lib/heartwood-owner-ops';

export interface UseHeartwoodOwnerArgs {
  /** Bunker mode, unlocked, not a paired-child install. */
  enabled: boolean;
  bunker: BunkerSigningBackend | null;
  router: BunkerBackendRouter | null;
  /** The primary pairing is connected (its pubkey is only known after `connect`). */
  connected: boolean;
  /** The operator-channel client, when an operator key is imported. */
  operatorClient: HeartwoodMgmtClient | null;
  /** The pubkeys this install already has on file (the hold never adds a different key). */
  naturalPersonPubkey: string;
  personaPubkey: string;
  /** `act_as` includes the real identity (it is in use, or legacy rails still sign as it). */
  includeRealName: boolean;
  /** The style on file (`AppPreferences.heartwoodOwnerStyle`); undefined = never ran the hold here. */
  storedStyle: OwnerStyle | undefined;
  onStyleChange: (style: OwnerStyle | undefined) => void | Promise<void>;
}

export interface UseHeartwoodOwnerReturn {
  /** The Heartwood lists the bundle method and this install has the keys the hold needs. */
  supported: boolean;
  /** `null` = unknown (not asked yet, or no answer). */
  status: OwnerStatus | null;
  checking: boolean;
  /** This install has run the hold before (style on file). */
  everHadFullAccess: boolean;
  /** The pairing's label, when an operator key lets us read it. */
  label: string | null;
  hasOperatorKey: boolean;
  /** A bundle is in flight (the vault poller must not queue cards beside it). */
  busy: boolean;
  words: [string, string, string] | null;
  includeRealName: boolean;
  /** Everyday -> Extra careful is one tap and needs the narrow method. */
  canNarrow: boolean;
  /** Run ONE bundle (`create: false`, `expect` = the pubkeys on file). Called from a tap only. */
  run: (style: OwnerStyle) => Promise<BundleRunResult>;
  narrow: () => Promise<NarrowResult>;
  turnOff: () => Promise<TurnOffResult>;
  refresh: () => void;
}

export function useHeartwoodOwner(args: UseHeartwoodOwnerArgs): UseHeartwoodOwnerReturn {
  const {
    enabled, bunker, router, connected, operatorClient, naturalPersonPubkey, personaPubkey, includeRealName,
    storedStyle, onStyleChange,
  } = args;
  const methods = router?.capabilities.methods ?? null;
  const supported = enabled && connected && !!bunker && supportsApproveBundle(methods)
    && /^[0-9a-f]{64}$/.test(naturalPersonPubkey) && /^[0-9a-f]{64}$/.test(personaPubkey);
  const canNarrow = supported && !!methods && methods.includes(CAP_OWNER_NARROW);

  const [status, setStatus] = useState<OwnerStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [label, setLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const busyRef = useRef(false);

  const clientPubkey = bunker?.transportClientPubkeyHex ?? '';
  const words = useMemo<[string, string, string] | null>(() => {
    if (!supported || !clientPubkey) return null;
    try { return pairWordsForClient(clientPubkey); } catch { return null; }
  }, [supported, clientPubkey]);

  const request = useCallback(
    (method: string, params: string[], timeoutMs?: number) => {
      if (!bunker) return Promise.reject(new Error('Not connected to bunker'));
      return bunker.request(method, params, timeoutMs);
    },
    [bunker],
  );

  // Once per router (= once per unlock / reconnect), and on refresh().
  useEffect(() => {
    if (!supported) { setStatus(null); setChecking(false); return; }
    let cancelled = false;
    setChecking(true);
    void fetchOwnerStatus(request).then((s) => {
      if (cancelled) return;
      setStatus(s);
      setChecking(false);
      // The Heartwood is the authority on the style; keep the copy on file in step.
      if (s?.owner && s.style !== storedStyle) void onStyleChange(s.style);
    });
    return () => { cancelled = true; };
    // storedStyle/onStyleChange deliberately omitted: a style write must not re-ask the device.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, router, request, refreshTick]);

  // A9: the pairing's label, only when an operator key lets us read the slot list.
  useEffect(() => {
    if (!supported || !operatorClient || !operatorClient.isOpen || !clientPubkey) { setLabel(null); return; }
    let cancelled = false;
    void ownSlotLabel(
      { listClients: () => withOperatorLock(operatorClient, () => listClients(operatorClient)) },
      clientPubkey,
    ).then((l) => { if (!cancelled) setLabel(l); });
    return () => { cancelled = true; };
  }, [supported, operatorClient, clientPubkey, refreshTick]);

  const run = useCallback(async (style: OwnerStyle): Promise<BundleRunResult> => {
    if (!supported || !bunker) {
      return { ok: false, failure: { action: 'continue', code: 'other', message: 'Your Heartwood isn\'t reachable right now. Try again in a moment.' } };
    }
    if (busyRef.current) {
      return { ok: false, failure: { action: 'retry', code: 'other', message: 'Your Heartwood is already waiting for you. Hold its button, or wait a moment.' } };
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const out = await runApproveBundle(request, {
        // Existing install: never add a key. A different key is refused before the card (-3 pubkey mismatch).
        create: false,
        actAsNaturalPerson: includeRealName,
        style,
        expect: { naturalPerson: naturalPersonPubkey, persona: personaPubkey },
        masterPubkey: bunker.activePublicKeyHex,
      });
      if (out.ok) {
        setStatus({ owner: true, style: out.reply.style });
        await onStyleChange(out.reply.style);
      }
      return out;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [supported, bunker, request, includeRealName, naturalPersonPubkey, personaPubkey, onStyleChange]);

  const narrow = useCallback(async (): Promise<NarrowResult> => {
    const out = await narrowToCareful(request);
    if (out.ok) {
      setStatus({ owner: true, style: 'careful' });
      await onStyleChange('careful');
    }
    return out;
  }, [request, onStyleChange]);

  const turnOff = useCallback(async (): Promise<TurnOffResult> => {
    if (!operatorClient || !operatorClient.isOpen || !clientPubkey) {
      return { ok: false, message: 'Choose Forget approvals for this phone in Sapwood.' };
    }
    const out = await withOperatorLock(operatorClient, () => turnOffFullAccess(
      {
        listClients: () => listClients(operatorClient),
        clearClientIdentities: (slot) => clearClientIdentities(operatorClient, slot),
      },
      clientPubkey,
    ));
    if (out.ok) {
      // A deliberate turn-off: this is no longer "lost", so the offer goes back to the first-time wording.
      await onStyleChange(undefined);
      setRefreshTick((t) => t + 1);
    }
    return out;
  }, [operatorClient, clientPubkey, onStyleChange]);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  return {
    supported, status, checking, everHadFullAccess: storedStyle !== undefined, label,
    hasOperatorKey: !!operatorClient, busy, words, includeRealName, canNarrow, run, narrow, turnOff, refresh,
  };
}
