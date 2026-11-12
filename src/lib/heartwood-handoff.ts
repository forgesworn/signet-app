/**
 * Hand a Nostr Connect pairing to the Heartwood that holds the persona's key,
 * so the app signs with the device directly and My Signet can be closed.
 *
 * My Signet approves the request as usual, then asks the device over its
 * operator channel (`nostrconnect_v2`) to accept the app's invitation for that
 * persona. The device mints an exact-policy slot for the app's client key,
 * publishes the connect ACK to the app's relay itself (joining that relay and
 * keeping it), and from then on answers the app with no phone in the loop.
 *
 * A persona can live on any Heartwood this phone holds an operator key for,
 * as a master (an identity of its own, e.g. an imported nsec) or as a persona
 * derived under one. The operator request is addressed to that master.
 */
import {
  listClients,
  listDeviceIdentities,
  nostrconnectV2,
  type DeviceIdentity,
  type HeartwoodMgmtClient,
  type NostrconnectMintResult,
} from './heartwood-mgmt';
import type { DeviceClientSlot, SlotPolicyUpdate } from './heartwood-mgmt-types';
import { clientKeyInUse, isNoSuchSlotError, isStaleClientSlotMessage } from './child-device-pairing';
import { HeartwoodCopyError, MGMT_GENERIC_COPY, heartwoodMgmtErrorCopy, isDeviceAnswerOrUnreachable } from './heartwood-mgmt-error-copy';
import type { NostrConnectRequest } from './nip46';
import type { HeartwoodHandoffRecord } from './db';

/** What a handed-off app may ask the device for. Every kind; no button. */
export const HANDOFF_METHODS: readonly string[] = ['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt'];

/**
 * Kinds this phone asks about every time, even for an app allowed to sign
 * automatically (`useBunkerServer` `sensitiveForAllowAlways`,
 * `scope-inference.ts`): 0 and 31000 (profile and name changes), 5
 * (deletions, for a scoped app), 24133 (pairing devices), 30420 (standing app
 * permissions) and Kinterest family authorisations
 * (`kinterest-authority.ts`). Those are matched by their `d` tag, which the
 * device can't see, and `parseKinterestRequest` only accepts kind 30078, so
 * any 30078 grant covers them. A hand-off's device grant can only list
 * allowed kinds (an empty list is every kind), and the device then signs
 * them with no press.
 */
export const HANDOFF_ALWAYS_ASK_KINDS: readonly number[] = [0, 5, 24133, 30078, 30420, 31000];

/**
 * How far a hand-off reaches past what this phone would ask about. 'safe':
 * the app sent a permission list, without plain `sign_event`, naming none of
 * the always-ask kinds. Otherwise 'wide': every kind when it sent no list or
 * plain `sign_event`, else the always-ask kinds it listed.
 */
export type HandoffReach = { kind: 'safe' } | { kind: 'wide'; covers: 'everything' | number[] };

export function handoffReach(permissions: readonly string[] | undefined): HandoffReach {
  if (permissions === undefined || permissions.includes('sign_event')) return { kind: 'wide', covers: 'everything' };
  const listed = HANDOFF_ALWAYS_ASK_KINDS.filter(k => permissions.includes(`sign_event:${k}`));
  return listed.length === 0 ? { kind: 'safe' } : { kind: 'wide', covers: listed };
}

const ALWAYS_ASK_WORDS: ReadonlyArray<readonly [number, string]> = [
  [0, 'profile changes'],
  [31000, 'name changes'],
  [5, 'deletions'],
  [24133, 'pairing other devices'],
  [30420, 'standing app permissions'],
  // Plain NIP-78 app data (app settings, mostly): named as such, with
  // Kinterest's use of it said after the list so it doesn't garble it.
  [30078, 'app data'],
];

const APP_DATA_NOTE = ' Kinterest also uses app data for family permissions.';

/** What a wide hand-off lets the Heartwood sign with no press, in plain words. Null when safe. */
export function handoffWarning(reach: HandoffReach): string | null {
  if (reach.kind === 'safe') return null;
  if (reach.covers === 'everything') {
    return 'Your Heartwood will sign anything this app asks, without a press, including profile changes, deletions and pairing other devices.';
  }
  const covers = reach.covers;
  const words = ALWAYS_ASK_WORDS.filter(([k]) => covers.includes(k)).map(([, w]) => w);
  const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0];
  return `Your Heartwood will sign ${list} for this app, without a press.${covers.includes(30078) ? APP_DATA_NOTE : ''}`;
}

/**
 * The device grant for an invitation: everything in HANDOFF_METHODS when the
 * app asked for no scope, else only what it asked for (never more). An empty
 * `kinds` means any kind, so it is empty only when plain `sign_event` was asked.
 */
export function handoffScope(permissions: readonly string[] | undefined): { methods: string[]; kinds: number[] } {
  if (permissions === undefined) return { methods: [...HANDOFF_METHODS], kinds: [] };
  const methods = ['get_public_key'];
  for (const m of ['nip44_encrypt', 'nip44_decrypt']) if (permissions.includes(m)) methods.push(m);
  const anyKind = permissions.includes('sign_event');
  const kinds = anyKind ? [] : [...new Set(permissions
    .filter(p => p.startsWith('sign_event:'))
    .map(p => Number(p.slice('sign_event:'.length))))].sort((a, b) => a - b);
  if (anyKind || kinds.length > 0) methods.splice(1, 0, 'sign_event');
  return { methods, kinds };
}

export function handoffPolicy(identityHex: string, permissions?: readonly string[]): SlotPolicyUpdate {
  const scope = handoffScope(permissions);
  return {
    allowedMethods: scope.methods,
    allowedKinds: scope.kinds,
    autoApprove: true,
    escalate: false,
    petitionOnDeny: false,
    auditChildWrap: false,
    boundIdentity: identityHex.toLowerCase(),
  };
}

export interface HandoffHolder {
  client: HeartwoodMgmtClient;
  /** The master the operator request is addressed to. */
  targetHex: string;
}

/** The master pubkey that serves `pubkey`: itself when it is a master, else its parent's. */
export function holderTarget(identities: readonly DeviceIdentity[], pubkey: string): string | null {
  const pk = pubkey.toLowerCase();
  const hit = identities.find(i => i.pubkeyHex === pk);
  if (!hit) return null;
  if (hit.kind === 'master') return hit.pubkeyHex;
  return identities.find(i => i.kind === 'master' && i.slot === hit.slot)?.pubkeyHex ?? null;
}

/**
 * Find which Heartwood holds `pubkey`. Asks each operator client in turn
 * (cached per client for the session by the caller's `cache`). Null when none
 * of them does: its operator key isn't on this phone, or the device is offline.
 */
export async function findHeartwoodHolder(
  clients: readonly HeartwoodMgmtClient[],
  pubkey: string,
  cache: Map<HeartwoodMgmtClient, DeviceIdentity[]> = new Map(),
): Promise<HandoffHolder | null> {
  let unanswered = 0;
  // What the failed lookups said: a device that answered with an error (or a
  // relay that took nothing) is reported as that, not as "didn't answer".
  let telling: unknown = null;
  for (const client of clients) {
    let ids = cache.get(client);
    // One retry: the device answers one management request at a time, so a
    // lookup that lands during a rules push can time out once.
    for (let attempt = 0; !ids && attempt < 2; attempt++) {
      try {
        ids = await listDeviceIdentities(client);
        cache.set(client, ids);
      } catch (e) {
        if (isDeviceAnswerOrUnreachable(e)) telling = e;
      }
    }
    if (!ids) { unanswered++; continue; }
    const target = holderTarget(ids, pubkey);
    if (target) return { client, targetHex: target };
  }
  if (unanswered > 0) throw new HandoffNoAnswerError(telling);
  return null;
}

export const HANDOFF_NO_ANSWER_COPY = "Your Heartwood didn't answer. Check it's on and online, then try again, or choose Through My Signet.";

/** No Heartwood could say whether it holds the persona. Says why when the device or relay did. */
export class HandoffNoAnswerError extends HeartwoodCopyError {
  constructor(cause?: unknown) {
    super(cause ? `${heartwoodMgmtErrorCopy(cause)} Or choose Through My Signet.` : HANDOFF_NO_ANSWER_COPY);
    this.name = 'HandoffNoAnswerError';
  }
}

/** The app relay the device should answer on: one it already serves, else the app's first. */
export function pickHandoffRelay(appRelays: readonly string[], deviceRelays: readonly string[]): string | null {
  const norm = (u: string) => u.trim().toLowerCase().replace(/\/+$/, '');
  const served = new Set(deviceRelays.map(norm));
  const usable = appRelays.filter(r => /^wss:\/\//i.test(r.trim()));
  return usable.find(r => served.has(norm(r))) ?? usable[0] ?? null;
}

export class HandoffUnavailableError extends HeartwoodCopyError {
  constructor() {
    super("None of the Heartwoods this phone manages holds this persona. Add that Heartwood's operator key in Advanced settings, or choose Through My Signet.");
    this.name = 'HandoffUnavailableError';
  }
}

export interface HandoffResult extends NostrconnectMintResult {
  deviceHex: string;
  targetHex: string;
  relay: string;
}

/** Where a hand-off will go, worked out before anything changes. */
export interface HandoffPlan {
  holder: HandoffHolder;
  relay: string;
  persona: string;
}

/**
 * The read-only half of a hand-off: which Heartwood holds the persona, and
 * which of the app's relays it answers on. Changes nothing anywhere, so it runs
 * before an earlier hand-off of the app is revoked.
 */
export async function prepareHandoff(params: {
  request: NostrConnectRequest;
  personaHex: string;
  clients: readonly HeartwoodMgmtClient[];
  cache?: Map<HeartwoodMgmtClient, DeviceIdentity[]>;
}): Promise<HandoffPlan> {
  const persona = params.personaHex.toLowerCase();
  const holder = await findHeartwoodHolder(params.clients, persona, params.cache);
  if (!holder) throw new HandoffUnavailableError();
  const appRelays = params.request.relayUrls?.length ? params.request.relayUrls : [params.request.relayUrl];
  const relay = pickHandoffRelay(appRelays, holder.client.relays);
  if (!relay) throw new Error('The app gave no wss:// relay to answer on.');
  return { holder, relay, persona };
}

/** Ask the planned Heartwood to accept `request` directly. */
export async function mintHandoff(plan: HandoffPlan, params: {
  request: NostrConnectRequest;
  now?: () => number;
  /** Serialises with other operator work on the same client (the family policy push). */
  withLock?: <T>(client: object, task: () => Promise<T>) => Promise<T>;
}): Promise<HandoffResult> {
  const { holder, relay, persona } = plan;
  const label = `mysignet:${(params.request.appName || 'app').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40) || 'app'}`;
  const lock = params.withLock ?? (<T,>(_c: object, task: () => Promise<T>) => task());
  const minted = await lock(holder.client, () => nostrconnectV2(holder.client, {
    clientPubkey: params.request.clientPubkey,
    secret: params.request.secret,
    createdAt: Math.floor((params.now?.() ?? Date.now()) / 1000),
    relay,
    identity: persona,
    label,
    policy: handoffPolicy(persona, params.request.permissions),
  }, { targetHex: holder.targetHex })).catch(async (e: unknown) => {
    const where = { deviceHex: holder.client.deviceHex, targetHex: holder.targetHex, relay };
    const left = e as { message?: unknown; slotIndex?: unknown; secretFingerprint?: unknown };
    // The device minted a slot (and told the app) with rules it wasn't asked
    // for, and didn't confirm removing it: keep a record so it can be reached.
    if (left?.message === 'heartwood-mint-mismatch-unrevoked' && typeof left.slotIndex === 'number') {
      const secretFingerprint = typeof left.secretFingerprint === 'string' ? left.secretFingerprint : '';
      throw new HandoffKeptError({ slotIndex: left.slotIndex, secretFingerprint, ...where }, HANDOFF_MISMATCH_KEPT_COPY);
    }
    const said = typeof left?.message === 'string' ? left.message : '';
    // This client was stopped (the phone locked, or the link restarted) after
    // the mint was sent and before the device answered, so nothing can be
    // listed on it now. The device may have minted the slot and told the app:
    // keep a record with no slot, which Disconnect (or the app's next pairing)
    // finds by the app's key, and drops when the device lists none. A stop
    // before the mint was sent (still queued, or during its challenge) says so
    // by its message, and is given back below like any other failure.
    if (said === 'transport closed (nostrconnect_v2)') {
      throw new HandoffKeptError({ secretFingerprint: '', ...where }, HANDOFF_LINK_DROPPED_KEPT_COPY);
    }
    // No answer to the mint itself: the device may still have minted the slot
    // and told the app. Look before the request is given back; a slot carrying
    // the app's key is kept. (No answer to the challenge before it means
    // nothing was sent, so there is nothing to look for.)
    if (said === 'timeout waiting for device (nostrconnect_v2)') {
      let found: DeviceClientSlot | undefined;
      try {
        const slots = await lock(holder.client, () => listClients(holder.client, { targetHex: holder.targetHex, strict: true }));
        found = slots.find(s => clientKeyInUse([s], params.request.clientPubkey));
      } catch { /* can't tell: reported as the failure it was */ }
      if (found) {
        const slot = { slotIndex: found.slotIndex, secretFingerprint: found.secretFingerprint, ...where };
        // A slot serving this persona is most likely the one just asked for.
        // One serving another identity, or saying none, may be an earlier
        // pairing of the app (the mint may never have arrived): it is kept
        // under its own identity, and called what it may be.
        if (found.boundIdentity === persona.toLowerCase()) throw new HandoffKeptError(slot, HANDOFF_UNCERTAIN_KEPT_COPY);
        throw new HandoffKeptError({ ...slot, ...(found.boundIdentity ? { persona: found.boundIdentity } : {}) }, HANDOFF_EARLIER_KEPT_COPY);
      }
    }
    throw new HeartwoodCopyError(heartwoodMgmtErrorCopy(e));
  });
  return { ...minted, deviceHex: holder.client.deviceHex, targetHex: holder.targetHex, relay };
}

/** Ask the device holding `personaHex` to accept `request` directly. */
export async function handOffNostrConnect(params: {
  request: NostrConnectRequest;
  personaHex: string;
  clients: readonly HeartwoodMgmtClient[];
  cache?: Map<HeartwoodMgmtClient, DeviceIdentity[]>;
  now?: () => number;
  withLock?: <T>(client: object, task: () => Promise<T>) => Promise<T>;
}): Promise<HandoffResult> {
  return mintHandoff(await prepareHandoff(params), params);
}

/** Shown while the request is still open, so Try again pairs it. */
export const HANDOFF_PRIOR_REMOVED_COPY = "This app's earlier pairing was removed from your Heartwood. Try again to pair it.";

/** A pairing that failed after the app's earlier hand-off was revoked: say the app is on neither signer now. */
export function priorRemovedMessage(e: unknown): string {
  return `${e instanceof Error ? e.message : MGMT_GENERIC_COPY} ${HANDOFF_PRIOR_REMOVED_COPY}`;
}

/**
 * A hand-off approval, in an order that never leaves the app worse off for a
 * check that could have failed first. Finding the Heartwood and the relay,
 * then the claim on the request (which a Cancel takes from it), all run before
 * an earlier hand-off of the app is revoked; nothing awaits between the claim
 * and the revoke starting, and a revoke once started is not abandoned. A
 * Cancel that lands during the revoke stops it there: nothing is minted, and
 * the request ends as cancelled (`endCancelled`, which still owes the app its
 * "denied"). A failed revoke mints nothing and gives the claim back. A mint
 * that fails after a revoke leaves the app on neither signer, and the error
 * says so.
 */
export async function runHandoffApproval(io: {
  /** Earlier hand-offs of this app, from the store. */
  priors: readonly HeartwoodHandoffRecord[];
  prepare: () => Promise<HandoffPlan>;
  /** False when the request was cancelled or replaced: nothing is changed. */
  claim: () => boolean;
  unclaim: () => void;
  /** A Cancel landed after the claim (so it sent nothing itself). Only looks. */
  cancelRequested: () => boolean;
  /** End the claimed request as a Cancel would have: it stays answered. */
  endCancelled: () => void;
  revokePrior: (rec: HeartwoodHandoffRecord) => Promise<void>;
  mint: (plan: HandoffPlan) => Promise<HandoffResult>;
}): Promise<{ status: 'withdrawn' } | { status: 'minted'; handed: HandoffResult }> {
  const plan = await io.prepare();
  if (!io.claim()) return { status: 'withdrawn' };
  const cancelledMeanwhile = () => {
    if (!io.cancelRequested()) return false;
    io.endCancelled();
    return true;
  };
  try {
    for (const prior of io.priors) await io.revokePrior(prior);
  } catch (e) {
    // Cancelled while the revoke ran: nothing more is tried, and the request
    // ends as the Cancel asked (nobody is left to read the error).
    if (cancelledMeanwhile()) return { status: 'withdrawn' };
    io.unclaim();
    throw e;
  }
  if (cancelledMeanwhile()) return { status: 'withdrawn' };
  try {
    return { status: 'minted', handed: await io.mint(plan) };
  } catch (e) {
    // The device may already have told the app it is paired: the request stays answered.
    if (e instanceof HandoffKeptError) throw e;
    io.unclaim();
    if (io.priors.length === 0) throw e;
    throw new HeartwoodCopyError(priorRemovedMessage(e));
  }
}

/**
 * An error after which this connect request is answered and can't be tried
 * again: the device already told the app something. The screen offers only
 * Close, and the copy says what to do instead.
 */
export function endsConnectRequest(e: unknown): boolean {
  return e instanceof HandoffNotSavedError || e instanceof HandoffStrandedError || e instanceof HandoffKeptError;
}

export class HandoffNotSavedError extends HeartwoodCopyError {
  constructor() {
    super("This phone couldn't save the pairing, so it was undone on your Heartwood. Scan the app's code again to pair it.");
    this.name = 'HandoffNotSavedError';
  }
}

export class HandoffStrandedError extends HeartwoodCopyError {
  constructor() {
    super("This phone couldn't save the pairing, and your Heartwood didn't confirm undoing it. Remove the app from your Heartwood in Sapwood, then scan the app's code again.");
    this.name = 'HandoffStrandedError';
  }
}

export const HANDOFF_STILL_CONNECTING_COPY = 'This phone is still connecting to that Heartwood. Try again in a moment.';

/**
 * The Heartwood an app was handed to is one this phone holds no operator key
 * for (forgotten, signer disconnected, device reset). Its record can't be
 * revoked from here, so the app's row offers Forget on this phone.
 */
export class HandoffUnmanagedError extends HeartwoodCopyError {
  readonly unmanaged = true;
  constructor() {
    super("This phone no longer has the operator key for the Heartwood this app was handed to. Add it in Advanced settings. Or, on the app's row in Where you're known, choose Disconnect and then Forget on this phone, and remove the app in Sapwood.");
    this.name = 'HandoffUnmanagedError';
  }
}

/**
 * Why there is no operator client for a hand-off's Heartwood. Only the stored
 * keys can say it is unmanaged: with no client yet the keys may still be
 * loading, or the link still opening. `stored` is null when they can't be read.
 */
export function missingOperatorError(stored: readonly string[] | null, deviceHex: string): HeartwoodCopyError {
  const d = deviceHex.toLowerCase();
  if (stored && !stored.some(s => s.toLowerCase() === d)) return new HandoffUnmanagedError();
  return new HeartwoodCopyError(HANDOFF_STILL_CONNECTING_COPY);
}

export const HANDOFF_LINK_DROPPED_KEPT_COPY = "The link to your Heartwood dropped before it answered. The app may be paired: check the app, or scan its code again.";

export const HANDOFF_UNCERTAIN_KEPT_COPY = "Your Heartwood didn't confirm, but it now lists this app, so it may be paired. It's in Where you're known, where you can disconnect it.";

export const HANDOFF_EARLIER_KEPT_COPY = "Your Heartwood didn't confirm this pairing, but an earlier pairing of this app is on it. It's in Where you're known, where you can disconnect it.";

export const HANDOFF_MISMATCH_KEPT_COPY = "Your Heartwood paired the app with rules this phone didn't ask for, and didn't confirm removing it. The app may still be on your Heartwood: disconnect it in Where you're known, or remove it in Sapwood.";

/** Where a slot the device may still hold sits, so a record of it can be kept. */
export interface KeptHandoffSlot {
  /** Unknown when the device never answered and nothing could be listed. */
  slotIndex?: number;
  /** Empty when the device didn't give one; the revoke then finds the slot by the app's key. */
  secretFingerprint: string;
  deviceHex: string;
  targetHex: string;
  relay: string;
  /** The identity the slot serves, when it isn't the persona just chosen (an earlier pairing). */
  persona?: string;
}

/** The device may hold a slot for the app (and may have told the app): keep a record of it so Disconnect can reach it. */
export class HandoffKeptError extends HeartwoodCopyError {
  readonly slot: KeptHandoffSlot;
  constructor(slot: KeptHandoffSlot, message: string) {
    super(message);
    this.name = 'HandoffKeptError';
    this.slot = slot;
  }
}

export const HANDOFF_ELSEWHERE_KEPT_COPY = "Your Heartwood didn't confirm this pairing. The app may be on your Heartwood under another identity: remove it there in Sapwood, or scan the app's code again.";

/** Kept copies that point to the app's row in Where you're known. */
const ROW_KEPT_COPIES: ReadonlySet<string> = new Set([HANDOFF_UNCERTAIN_KEPT_COPY, HANDOFF_EARLIER_KEPT_COPY, HANDOFF_MISMATCH_KEPT_COPY]);

/**
 * The copy for a kept record filed under `identity`. Where you're known lists
 * places on this phone's identity cards only (not a dependant's, a dormant or
 * hidden identity's, or one this phone doesn't hold), so a copy pointing there
 * is swapped for one that points to Sapwood when `identity` has no card.
 */
export function keptHandoffCopy(message: string, identity: string, cards: ReadonlySet<string>): string {
  if (cards.has(identity.toLowerCase()) || !ROW_KEPT_COPIES.has(message)) return message;
  return HANDOFF_ELSEWHERE_KEPT_COPY;
}

/**
 * Revoke a handed-off app's slot on its Heartwood. Resolves once the app is
 * gone from the device; throws (so the caller keeps the record) otherwise.
 *
 * The device's `no such slot: <n>` or `stale_client_slot` is not proof the
 * app is gone: its slot may sit under another index. The device's client list
 * decides. No slot carries the app's key ⇒ gone. One does ⇒ that slot is
 * revoked, once. A listing that fails or can't be fully read throws. A record
 * with no fingerprint (or no slot index) goes straight to the listing.
 */
export async function revokeHandoffSlot(p: {
  clientPubkey: string;
  slot: { slotIndex?: number; secretFingerprint: string };
  revoke: (slot: { slotIndex: number; secretFingerprint: string }) => Promise<void>;
  /** The holding master's slots; must throw rather than return a partial list. */
  listClients: () => Promise<DeviceClientSlot[]>;
}): Promise<void> {
  if (p.slot.secretFingerprint && p.slot.slotIndex !== undefined) {
    try {
      await p.revoke({ slotIndex: p.slot.slotIndex, secretFingerprint: p.slot.secretFingerprint });
      return;
    } catch (e) {
      if (!isNoSuchSlotError(e) && !isStaleClientSlotMessage(e)) throw e;
    }
  }
  const holding = (await p.listClients()).filter(s => clientKeyInUse([s], p.clientPubkey));
  for (const s of holding) await p.revoke({ slotIndex: s.slotIndex, secretFingerprint: s.secretFingerprint });
}

/**
 * Disconnect every record of one app, carrying on past one that fails (each
 * `revoke` drops its own record once it is gone). Throws the first failure
 * once all were tried: the app's row then offers Forget on this phone.
 */
export async function revokeEveryHandoff(
  records: readonly HeartwoodHandoffRecord[],
  revoke: (rec: HeartwoodHandoffRecord) => Promise<void>,
): Promise<void> {
  let failure: { error: unknown } | null = null;
  for (const rec of records) {
    try {
      await revoke(rec);
    } catch (e) {
      failure ??= { error: e };
    }
  }
  if (failure) throw failure.error;
}

type HandoffRef = Pick<HeartwoodHandoffRecord, 'clientPubkey' | 'deviceHex' | 'targetHex' | 'slotIndex' | 'secretFingerprint'>;

/** The same slot on the same Heartwood for the same app. */
export function sameHandoff(a: HandoffRef, b: HandoffRef): boolean {
  return a.clientPubkey === b.clientPubkey && a.deviceHex === b.deviceHex && a.targetHex === b.targetHex
    && a.slotIndex === b.slotIndex && a.secretFingerprint.toLowerCase() === b.secretFingerprint.toLowerCase();
}

/**
 * What the phone holds: the stored records plus those tracked but not saved
 * (still being saved, or held for this session after a save failed). A
 * refresh from the store must not drop those, or this phone would start
 * answering an app the Heartwood answers.
 */
export function mergeHandoffs(stored: readonly HeartwoodHandoffRecord[], unsaved: readonly HeartwoodHandoffRecord[]): HeartwoodHandoffRecord[] {
  return [...stored, ...unsaved.filter(u => !stored.some(s => sameHandoff(s, u)))];
}

/** Every record for one app (normally one). */
export function handoffsForClient(records: readonly HeartwoodHandoffRecord[], clientPubkey: string): HeartwoodHandoffRecord[] {
  const c = clientPubkey.toLowerCase();
  return records.filter(h => h.clientPubkey === c);
}

/**
 * After the device has minted the app's slot (and already told the app):
 * - cancelled meanwhile ⇒ undo it on the device ('undone');
 * - otherwise the record is saved before anything relies on it; a slot that
 *   can't be saved is undone ({@link HandoffNotSavedError}).
 * A slot the device didn't confirm undoing stays tracked: saved when it can be
 * ('cancelled-kept', so Disconnect can reach it later), else held in memory for
 * this session only ({@link HandoffStrandedError}).
 *
 * `track` runs first, so this phone ignores the app's requests from the moment
 * the device holds it; `untrack` runs once the slot is gone again.
 */
export async function settleHandoff(p: {
  cancelled: boolean;
  track: () => void;
  untrack: () => void;
  persist: () => Promise<void>;
  undo: () => Promise<void>;
}): Promise<'kept' | 'undone' | 'cancelled-kept'> {
  p.track();
  if (p.cancelled) {
    try {
      await p.undo();
      p.untrack();
      return 'undone';
    } catch { /* the device still holds it: keep it tracked, below */ }
  }
  try {
    await p.persist();
  } catch {
    try {
      await p.undo();
    } catch {
      throw new HandoffStrandedError();
    }
    p.untrack();
    throw new HandoffNotSavedError();
  }
  return p.cancelled ? 'cancelled-kept' : 'kept';
}
