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
import type { ChildPairOffer, ChildPairReply } from './child-pair-wire';
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
  record: { mode?: 'phone' | 'heartwood-direct'; personaPubkey?: string } | null | undefined;
  identity: Pick<SignetIdentity, 'primaryKeypair' | 'naturalPerson' | 'naturalPersonActive' | 'persona'> | null | undefined;
}): string[] {
  const { identity } = input;
  if (!identity || !isDirectChildInstall(input)) return [];
  if (identity.naturalPersonActive === true) return [];
  const np = (identity.naturalPerson.publicKey || '').trim().toLowerCase();
  // A50: the bound persona is the phone's own slot — never withheld, even
  // when a stub (or a new-model dependant, whose id IS its persona) put the
  // same key in the real-identity slot.
  const bound = new Set([input.record?.personaPubkey, identity.persona?.publicKey]
    .map(k => (k || '').trim().toLowerCase()).filter(Boolean));
  return np && !bound.has(np) ? [np] : [];
}

/**
 * A50: the child's stub identity after a direct pairing. No signing material.
 * `id` stays the dependant pubkey (the row key every paired-child rail uses);
 * the PRIMARY is the bound persona. The real-identity slot is the reply's
 * `natural-person` entry (the guardian sends it only when activated), else
 * empty — never the dependant id, which for a new-model dependant IS the
 * bound persona.
 */
export function childDirectStubIdentity(
  offer: Pick<ChildPairOffer, 'dependant' | 'persona' | 'name'>,
  personas: ChildPairReply['personas'],
  nowS: number,
): SignetIdentity {
  const personaName = personas.find(p => p.pubkey === offer.persona)?.name || offer.name;
  const np = personas.find(p => p.role === 'natural-person' && p.pubkey !== offer.persona);
  return {
    id: offer.dependant,
    mnemonic: '',
    naturalPerson: { publicKey: np?.pubkey ?? '', privateKey: '', displayName: np?.name || offer.name },
    persona: { publicKey: offer.persona, privateKey: '', displayName: personaName },
    primaryKeypair: 'persona',
    naturalPersonActive: !!np,
    isChild: true,
    createdAt: nowS,
    encrypted: true,
    backedUp: true,
  } as SignetIdentity;
}

/**
 * A51: the personas this phone may use. The guardian's rules payload lists
 * them (`personas`, minus those removed from the phone); absent — an older
 * payload, or none yet — means every inventory persona. The bound persona is
 * always kept: unpair, not removal, is how it goes.
 */
export function childAllowedPersonas<T extends { pubkey: string }>(
  list: T[],
  rules: { personas?: string[] } | null | undefined,
  bound: string | null | undefined,
): T[] {
  if (!rules?.personas) return list;
  const allowed = new Set(rules.personas.map(p => p.toLowerCase()));
  const b = (bound || '').toLowerCase();
  return list.filter(p => { const k = p.pubkey.toLowerCase(); return k === b || allowed.has(k); });
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

/**
 * A41: the "Family asks" inbox is a guardian surface — a Heartwood-connected
 * guardian (mnemonic gone, signer connected, unlocked, not viewing as a
 * dependant) and NEVER a paired-child install, whose signer is the
 * dependant's own slot.
 */
export function escalationsAvailable(input: {
  signingMode: Mode;
  hasMnemonic: boolean;
  bunkerConnected: boolean;
  unlocked: boolean;
  viewingDependant: boolean;
}): boolean {
  if (input.signingMode === 'paired-child') return false;
  return !input.hasMnemonic && input.bunkerConnected && input.unlocked && !input.viewingDependant;
}

/** A41: `?action=add-dependant` makes the signer a guardian — never on a child's phone. */
export function addDependantRequestAllowed(signingMode: Mode): boolean {
  return signingMode !== 'paired-child';
}

/**
 * A44: the bunker handed to a signing-in site. A direct child hands none —
 * its NIP-46 server serves only the gated per-persona transport routes, so a
 * `bunker://` pointing at the persona or an in-page pairing would reach
 * nothing (or, worse, an ungated path).
 */
export function signInBunkerHandoff(input: {
  childDirect: boolean;
  remoteBunkerUri?: string;
  inPageServer: boolean;
}): { kind: 'remote'; uri: string } | { kind: 'in-page' } | { kind: 'none' } {
  if (input.childDirect) return { kind: 'none' };
  if (input.remoteBunkerUri) return { kind: 'remote', uri: input.remoteBunkerUri };
  return input.inPageServer ? { kind: 'in-page' } : { kind: 'none' };
}

/** The connected-app id a signed-in site is listed under (A45). */
export function childSiteAppId(origin: string): string {
  return `site:${origin}`;
}

/**
 * Sign in with Signet on a direct child (spec §8.1): the gate decides as the
 * site (`siteOrigin`, appId `mysignet`), and the site's own connected-app
 * entry (`site:<origin>`) is touched when the request starts and again on
 * every forwarded request (A45).
 */
export function childSignInBackend(input: {
  inner: DecryptingSigningBackend;
  origin: string;
  siteLabel: string;
  authorise: (req: { persona: string; appId: string; appLabel: string; siteOrigin: string; method: ChildGateMethod; template?: UnsignedEvent; peer?: string }) => Promise<ChildGateOutcome>;
  touch: (appId: string) => void;
}): DecryptingSigningBackend {
  const inner = ungatedInner(input.inner);
  const persona = inner.activePublicKeyHex;
  const appId = childSiteAppId(input.origin);
  const touch = () => { try { input.touch(appId); } catch { /* bookkeeping only */ } };
  touch();
  return gatedSigningBackend(inner, async (req) => {
    const outcome = await input.authorise({
      persona, appId: CHILD_OWN_APP_ID, appLabel: input.siteLabel, siteOrigin: input.origin, method: req.method,
      ...(req.template ? { template: req.template } : {}), ...(req.peer ? { peer: req.peer } : {}),
    });
    if (outcome.ok) touch();
    return outcome;
  });
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
const GATED_INNER = Symbol('childGatedInner');

/** The backend a gated wrapper forwards to (itself when not gated). */
export function ungatedInner<T extends object | null>(backend: T): T {
  if (!backend) return backend;
  return ((backend as Record<symbol, unknown>)[GATED_INNER] as T | undefined) ?? backend;
}

/** The child's own app id on the gate (spec §8.4). */
export const CHILD_OWN_APP_ID = 'mysignet';
export const CHILD_OWN_APP_LABEL = 'My Signet';

/**
 * A41: an NP (or any persona) seam on a direct child — the app's own acts
 * (Venue Entry, Blossom uploads, audit publishing, …) — signs through the
 * gate as appId `mysignet`. Off a direct child, or with no backend, the
 * backend is returned unchanged.
 */
export function childOwnActsBackend<T extends DecryptingSigningBackend | null | undefined>(input: {
  childDirect: boolean;
  backend: T;
  authorise: (req: { persona: string; appId: string; appLabel: string; method: ChildGateMethod; template?: UnsignedEvent; peer?: string }) => Promise<ChildGateOutcome>;
}): T {
  const { backend } = input;
  if (!input.childDirect || !backend) return backend;
  const inner = ungatedInner(backend) as DecryptingSigningBackend;
  return gatedSigningBackend(inner, (req) => input.authorise({
    persona: inner.activePublicKeyHex, appId: CHILD_OWN_APP_ID, appLabel: CHILD_OWN_APP_LABEL, method: req.method,
    ...(req.template ? { template: req.template } : {}), ...(req.peer ? { peer: req.peer } : {}),
  })) as T;
}

export function gatedSigningBackend(
  inner: DecryptingSigningBackend,
  authorise: (req: { method: ChildGateMethod; template?: UnsignedEvent; peer?: string }) => Promise<ChildGateOutcome>,
): DecryptingSigningBackend {
  // Never gate twice: wrapping an already-gated backend (e.g. the NP seam
  // under a sign-in's site gate) replaces the outer decision, one ask only.
  inner = ungatedInner(inner);
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
    [GATED_INNER]: inner,
  } as DecryptingSigningBackend;
}
