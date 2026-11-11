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

export function handoffPolicy(identityHex: string): SlotPolicyUpdate {
  return {
    allowedMethods: [...HANDOFF_METHODS],
    allowedKinds: [],
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
    policy: handoffPolicy(persona),
  }, { targetHex: holder.targetHex }));
  return { ...minted, deviceHex: holder.client.deviceHex, targetHex: holder.targetHex, relay };
}
