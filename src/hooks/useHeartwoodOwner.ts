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
  CAP_OWNER_NARROW, FULL_ACCESS_COPY, fetchOwnerStatus, narrowToCareful, pairWordsForClient, runApproveBundle, supportsApproveBundle,
  type BundleRunResult, type NarrowResult, type OwnerStatus, type OwnerStyle, type PairWords, type StatusStyle,
} from '../lib/heartwood-one-hold';
import { ownSlotInfo, turnOffFullAccess, type TurnOffResult } from '../lib/heartwood-owner-ops';

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
  storedStyle: StatusStyle | undefined;
  /**
   * Keep the style (and, when given, the `act_as` the device echoed) on file;
   * `undefined` clears both. An omitted `actAs` leaves the one on file alone.
   */
  onStyleChange: (style: StatusStyle | undefined, actAs?: readonly string[]) => void | Promise<void>;
}

export interface UseHeartwoodOwnerReturn {
  /** The Heartwood lists the bundle method and this install has the keys the hold needs. */
  supported: boolean;
  /** `null` = unknown (not asked yet, or no answer). */
  status: OwnerStatus | null;
  checking: boolean;
  /**
   * No answer yet to the FIRST status check on this router (derived, so it is
   * true in the very render that `supported` turns true). Backups wait on it.
   */
  awaitingFirstStatus: boolean;
  /** This install has run the hold before (style on file). */
  everHadFullAccess: boolean;
  /** The pairing's label, when an operator key lets us read it. */
  label: string | null;
  /**
   * The methods the device lists for this phone's own pairing, when an operator
   * key lets us read them (`null` = unknown). Decision 11: a pairing that lists
   * `heartwood_derive_persona` makes new keys with no card.
   */
  ownSlotMethods: string[] | null;
  hasOperatorKey: boolean;
  /** A bundle is in flight (the vault poller must not queue cards beside it). */
  busy: boolean;
  words: PairWords | null;
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
  // Which (router, refresh) pair the last status answer belongs to. `checking`
  // is derived from it, never set from an effect, so there is no render where
  // `supported` is true and the answer is wrongly taken as "not pending".
  const [settled, setSettled] = useState<{ router: BunkerBackendRouter | null; tick: number } | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [ownSlotMethods, setOwnSlotMethods] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const busyRef = useRef(false);
  const checking = supported && !(settled !== null && settled.router === router && settled.tick === refreshTick);
  const awaitingFirstStatus = supported && !(settled !== null && settled.router === router);

  const clientPubkey = bunker?.transportClientPubkeyHex ?? '';
  const words = useMemo<PairWords | null>(() => {
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
    if (!supported) { setStatus(null); return; }
    let cancelled = false;
    void fetchOwnerStatus(request).then((s) => {
      if (cancelled) return;
      setStatus(s);
      setSettled({ router, tick: refreshTick });
      // The Heartwood is the authority on the style; keep the copy on file in step.
      if (s?.owner && s.style !== storedStyle) void onStyleChange(s.style);
    });
    return () => { cancelled = true; };
    // storedStyle/onStyleChange deliberately omitted: a style write must not re-ask the device.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, router, request, refreshTick]);

  // A9: the pairing's label, and decision 11: whether it lists derive. Only when
  // an operator key lets us read the slot list. Not gated on the bundle method:
  // a D4 install on older firmware has the same "no card" case.
  const canReadSlots = enabled && connected && !!bunker;
  useEffect(() => {
    if (!canReadSlots || !operatorClient || !operatorClient.isOpen || !clientPubkey) { setLabel(null); setOwnSlotMethods(null); return; }
    let cancelled = false;
    void ownSlotInfo(
      { listClients: () => withOperatorLock(operatorClient, () => listClients(operatorClient)) },
      clientPubkey,
    ).then((info) => {
      if (cancelled) return;
      setLabel(info?.label ?? null);
      setOwnSlotMethods(info?.allowedMethods ?? null);
    });
    return () => { cancelled = true; };
  }, [canReadSlots, operatorClient, clientPubkey, refreshTick]);

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
        // Existing install: never add a key. A different key is refused before the card (pubkey mismatch).
        create: false,
        actAsNaturalPerson: includeRealName,
        style,
        expect: { naturalPerson: naturalPersonPubkey, persona: personaPubkey },
        masterPubkey: bunker.activePublicKeyHex,
      });
      if (out.ok) {
        setStatus({ owner: true, style: out.reply.style });
        // The device's own echo of what it granted, not what was asked.
        await onStyleChange(out.reply.style, out.reply.actAs);
      } else if (out.failure.code === 'no-answer' || out.failure.code === 'bad-reply') {
        // The press may have landed after we stopped listening (m3): ask the
        // device again rather than leave the status line saying "off".
        setRefreshTick((t) => t + 1);
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
    } else if (out.style === 'custom') {
      // W4: the slot's list is custom; nothing changed. Show it as it is.
      setStatus({ owner: true, style: 'custom' });
      await onStyleChange('custom');
    }
    return out;
  }, [request, onStyleChange]);

  const turnOff = useCallback(async (): Promise<TurnOffResult> => {
    if (!operatorClient || !operatorClient.isOpen || !clientPubkey) {
      // No operator key: Sapwood does the withdrawing. The owner has said they
      // want full access off, so drop the style on file now; otherwise the
      // "approve again" offer would return on every start (M2). If they do not
      // follow through, the next status check puts the style back.
      await onStyleChange(undefined);
      return { ok: false, message: FULL_ACCESS_COPY.sapwoodForget };
    }
    const out = await withOperatorLock(operatorClient, () => turnOffFullAccess(
      {
        listClients: () => listClients(operatorClient),
        clearClientIdentities: (slot, client) => clearClientIdentities(operatorClient, slot, client),
        // "Off" is believed only from the device itself, over the phone's own pairing.
        readOwnerStatus: () => fetchOwnerStatus(request),
      },
      clientPubkey,
    ));
    if (out.ok) {
      // The re-read said `owner:false`. A deliberate turn-off: this is no
      // longer "lost", so the offer goes back to the first-time wording.
      setStatus({ owner: false, style: 'everyday' });
      await onStyleChange(undefined);
      setRefreshTick((t) => t + 1);
    } else if (out.status) {
      // The device still says owner: keep the line on what it said.
      setStatus(out.status);
    }
    return out;
  }, [operatorClient, clientPubkey, onStyleChange, request]);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  return {
    supported, status, checking, awaitingFirstStatus, everHadFullAccess: storedStyle !== undefined, label, ownSlotMethods,
    hasOperatorKey: !!operatorClient, busy, words, includeRealName, canNarrow, run, narrow, turnOff, refresh,
  };
}
