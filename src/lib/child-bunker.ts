/**
 * The child's bunker (child-direct Heartwood pairing, spec §8): the pure
 * pieces App.tsx composes on a dependant's own phone.
 *
 *   isDirectChildInstall      is this a paired-child install bound straight
 *                             to the family Heartwood?
 *   childDirectWithheldSlots  slot pubkeys nothing may address there (A26:
 *                             the dependant's dormant real identity)
 *   legacyRailIdentity        the five guardian-self sync rails are off on
 *                             EVERY paired-child install (§8)
 *   buildChildDirectRoutes    one NIP-46 server route per persona: a LOCAL
 *                             transport key (no Heartwood round trip for the
 *                             envelope), signing through the persona's
 *                             Heartwood route, every request through the gate
 */
import type { UnsignedEvent } from 'signet-protocol';
import type { SignetIdentity } from '../types';
import type { BunkerRoute } from '../hooks/useBunkerServer';
import { withRequestCreatedAt, type DecryptingSigningBackend } from './signing-backend';

/** What the child's gate answers. `requestCreatedAt` is the forced NIP-46
 *  request `created_at` the caller stamps on the forwarded request;
 *  `template` is the exact template to forward (sign_event only). */
export type ChildGateOutcome =
  | { ok: true; requestCreatedAt: number; template?: UnsignedEvent }
  | { ok: false; error: ChildGateError };

/** `asked`: an ask was raised but the caller could not wait (NIP-55 content provider). */
export type ChildGateError = 'denied' | 'blocked' | 'expired' | 'unpaired' | 'busy' | 'asked';

export type ChildGateMethod = 'sign_event' | 'nip44_encrypt' | 'nip44_decrypt';

/** The gate as a NIP-46 server route sees it (one per persona route). */
export interface ChildRouteGate {
  authorise(req: { clientPubkey: string; method: ChildGateMethod; template?: UnsignedEvent; peer?: string }): Promise<ChildGateOutcome>;
  /** A client sent `connect` (label/url from its metadata). */
  onConnect?(clientPubkey: string, meta: { label: string; url?: string }): void;
}

type Mode = string | undefined | null;

/**
 * A paired-child install whose record says `heartwood-direct`. Before the
 * record has loaded, the stub identity tells: a direct stub's primary is the
 * bound persona; a legacy phone-paired stub's primary is the dependant NP.
 */
export function isDirectChildInstall(input: {
  signingMode: Mode;
  record: { mode?: 'phone' | 'heartwood-direct' } | null | undefined;
  identity: Pick<SignetIdentity, 'primaryKeypair'> | null | undefined;
}): boolean {
  if (input.signingMode !== 'paired-child') return false;
  if (input.record) return input.record.mode === 'heartwood-direct';
  return input.identity?.primaryKeypair === 'persona';
}

/**
 * A26: on a direct child install the dependant's real-identity slot is
 * dormant unless the guardian activated it — nothing may address it, so it
 * is withheld from every slot resolver (no router route is ever requested).
 */
export function childDirectWithheldSlots(input: {
  signingMode: Mode;
  record: { mode?: 'phone' | 'heartwood-direct' } | null | undefined;
  identity: Pick<SignetIdentity, 'primaryKeypair' | 'naturalPerson' | 'naturalPersonActive'> | null | undefined;
}): string[] {
  const { identity } = input;
  if (!identity || !isDirectChildInstall(input)) return [];
  if (identity.naturalPersonActive === true) return [];
  const np = (identity.naturalPerson.publicKey || '').trim().toLowerCase();
  return np ? [np] : [];
}

/**
 * The five legacy guardian-self sync rails (contacts, kens, dependants,
 * credentials, grants) decrypt as the identity they sync. On a paired child
 * that is the dependant — on a direct install it would hit the Heartwood — so
 * they get `identity: null` on every paired-child install.
 */
export function legacyRailIdentity<T>(signingMode: Mode, identity: T | null): T | null {
  return signingMode === 'paired-child' ? null : identity;
}

export interface ChildDirectRouteInputs {
  /** Non-dormant personas, in order. */
  personas: string[];
  /** Local transport keypair per persona (`child-transport-keys.ts`). */
  transportKeys: Record<string, { publicKey: string; privateKey: string }>;
  /** The persona's Heartwood route (`router.backendFor(persona)`), or null. */
  signingBackendFor(persona: string): DecryptingSigningBackend | null;
  gateFor(persona: string): ChildRouteGate;
}

/**
 * One gated route per persona. The route pubkey is the LOCAL transport key
 * (what apps pair with, `bunker://<transport>`); `get_public_key` answers the
 * persona. A persona with no transport key or no Heartwood route yet gets no
 * route; a malformed transport key skips that persona only.
 */
export function buildChildDirectRoutes(
  inputs: ChildDirectRouteInputs,
  makeLocalBackend: (privateKeyHex: string) => DecryptingSigningBackend,
): BunkerRoute[] {
  const routes: BunkerRoute[] = [];
  for (const raw of inputs.personas) {
    const persona = raw.toLowerCase();
    const t = inputs.transportKeys[persona];
    if (!t || t.publicKey.toLowerCase() === persona) continue;
    if (routes.some(r => r.pubkey === t.publicKey)) continue;
    const signing = inputs.signingBackendFor(persona);
    if (!signing) continue;
    try {
      routes.push({
        pubkey: t.publicKey,
        backend: makeLocalBackend(t.privateKey),
        signingBackend: signing,
        childGate: inputs.gateFor(persona),
      });
    } catch {
      // Malformed transport key — skip this persona, keep the others.
    }
  }
  return routes;
}

/** Plain-English error for a refused gate outcome (thrown by the gated backend). */
export class ChildGateRefusedError extends Error {
  constructor(readonly code: ChildGateError) {
    super(code === 'blocked' ? 'Not allowed right now.'
      : code === 'expired' ? 'Your guardian did not answer in time.'
      : code === 'unpaired' ? 'This phone is no longer paired.'
      : code === 'busy' ? 'Too many requests are waiting for your guardian.'
      : code === 'asked' ? 'Your guardian has been asked.'
      : 'Your guardian has not allowed this.');
    this.name = 'ChildGateRefusedError';
  }
}

/**
 * A backend that asks the child's gate before every sign / NIP-44 call and
 * forwards the gate's exact template, stamped with its request created_at.
 * Used for the child's own acts (appId `mysignet`) and Sign in with Signet
 * (with `siteOrigin`). NIP-04 is not offered. `destroy` is a no-op: the inner
 * backend is a shared, cached router route.
 */
export function gatedSigningBackend(
  inner: DecryptingSigningBackend,
  authorise: (req: { method: ChildGateMethod; template?: UnsignedEvent; peer?: string }) => Promise<ChildGateOutcome>,
): DecryptingSigningBackend {
  const pass = async (req: { method: ChildGateMethod; template?: UnsignedEvent; peer?: string }) => {
    const outcome = await authorise(req);
    if (!outcome.ok) throw new ChildGateRefusedError(outcome.error);
    return outcome;
  };
  return {
    type: inner.type,
    get activePublicKeyHex() { return inner.activePublicKeyHex; },
    ...(inner.transportClientPubkeyHex ? { transportClientPubkeyHex: inner.transportClientPubkeyHex } : {}),
    async signEvent(event: UnsignedEvent) {
      const o = await pass({ method: 'sign_event', template: event });
      if (!o.ok) throw new ChildGateRefusedError('denied');
      return withRequestCreatedAt(inner, o.requestCreatedAt).signEvent(o.template ?? event);
    },
    async nip44Encrypt(peer: string, plaintext: string) {
      const o = await pass({ method: 'nip44_encrypt', peer });
      if (!o.ok) throw new ChildGateRefusedError('denied');
      return withRequestCreatedAt(inner, o.requestCreatedAt).nip44Encrypt(peer, plaintext);
    },
    async nip44Decrypt(peer: string, ciphertext: string) {
      const o = await pass({ method: 'nip44_decrypt', peer });
      if (!o.ok) throw new ChildGateRefusedError('denied');
      return withRequestCreatedAt(inner, o.requestCreatedAt).nip44Decrypt(peer, ciphertext);
    },
    destroy() { /* the inner route is shared */ },
  } as DecryptingSigningBackend;
}
