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
  listDeviceIdentities,
  nostrconnectV2,
  type DeviceIdentity,
  type HeartwoodMgmtClient,
  type NostrconnectMintResult,
} from './heartwood-mgmt';
import type { SlotPolicyUpdate } from './heartwood-mgmt-types';
import type { NostrConnectRequest } from './nip46';

/** What a handed-off app may ask the device for. Every kind; no button. */
export const HANDOFF_METHODS: readonly string[] = ['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt'];

/**
 * Whether an invitation can go straight to the Heartwood. One whose scope asks
 * to sign deletions (kind 5) cannot: this phone asks before every deletion for
 * a scoped app, and the device would sign them without asking.
 */
export function handoffAllowedFor(permissions: readonly string[] | undefined): boolean {
  return !permissions?.includes('sign_event:5');
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
  for (const client of clients) {
    let ids = cache.get(client);
    // One retry: the device answers one management request at a time, so a
    // lookup that lands during a rules push can time out once.
    for (let attempt = 0; !ids && attempt < 2; attempt++) {
      try {
        ids = await listDeviceIdentities(client);
        cache.set(client, ids);
      } catch { /* try again, then move on */ }
    }
    if (!ids) { unanswered++; continue; }
    const target = holderTarget(ids, pubkey);
    if (target) return { client, targetHex: target };
  }
  if (unanswered > 0) throw new HandoffNoAnswerError();
  return null;
}

export class HandoffNoAnswerError extends Error {
  constructor() {
    super("Your Heartwood didn't answer. Check it's on and online, then try again, or choose Through My Signet.");
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

export class HandoffUnavailableError extends Error {
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

/** Ask the device holding `personaHex` to accept `request` directly. */
export async function handOffNostrConnect(params: {
  request: NostrConnectRequest;
  personaHex: string;
  clients: readonly HeartwoodMgmtClient[];
  cache?: Map<HeartwoodMgmtClient, DeviceIdentity[]>;
  now?: () => number;
  /** Serialises with other operator work on the same client (the family policy push). */
  withLock?: <T>(client: object, task: () => Promise<T>) => Promise<T>;
}): Promise<HandoffResult> {
  const persona = params.personaHex.toLowerCase();
  if (!handoffAllowedFor(params.request.permissions)) throw new Error('This app asks to sign deletions, so My Signet asks you each time. Choose Through My Signet.');
  const holder = await findHeartwoodHolder(params.clients, persona, params.cache);
  if (!holder) throw new HandoffUnavailableError();
  const appRelays = params.request.relayUrls?.length ? params.request.relayUrls : [params.request.relayUrl];
  const relay = pickHandoffRelay(appRelays, holder.client.relays);
  if (!relay) throw new Error('The app gave no wss:// relay to answer on.');
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
  }, { targetHex: holder.targetHex }));
  return { ...minted, deviceHex: holder.client.deviceHex, targetHex: holder.targetHex, relay };
}

export class HandoffNotSavedError extends Error {
  constructor() {
    super("This phone couldn't save the pairing, so it was undone on your Heartwood. Try again.");
    this.name = 'HandoffNotSavedError';
  }
}

export class HandoffStrandedError extends Error {
  constructor() {
    super("This phone couldn't save the pairing, and your Heartwood didn't confirm undoing it. Remove the app from your Heartwood in Sapwood.");
    this.name = 'HandoffStrandedError';
  }
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
