/**
 * The answer seal pass (app-permission design §8.1, D7). On a direct-paired
 * child, an approved answer to an app costs three persona operations: the
 * approved signature itself, then the NIP-44 encrypt and the kind-13 seal of
 * the gift wrap that carries it back. The guardian decides the signature; the
 * pass lets the encrypt and seal of THAT answer through without two more
 * cards — and nothing else.
 *
 * `answerSealingBackend` wraps the persona's Heartwood route for ONE request.
 * It is My Signet's own act (appId `mysignet`), built by the code that builds
 * the answer, so it knows every byte in advance:
 *
 *   mint     its `signEvent` of `eligibleKind` by the persona, through the
 *            ordinary gate, records the signed event's id (one mint per
 *            wrapper; 60 s; memory only)
 *   encrypt  passes only while the pass is live and unused, to the session
 *            key, when the plaintext is the answer rumor — kind 29999 by the
 *            persona, `status` approved, a `session` tag, and content whose
 *            `[responseField].id` is the minted id. The ciphertext that comes
 *            back is recorded (a re-encrypt replaces it, so a retried wrap
 *            still works).
 *   seal     passes only when kind 13, no tags, by the persona, and content
 *            EXACTLY the recorded ciphertext; the pass is then used up.
 *
 * Anything else — another peer, other plaintext, other content, a second
 * use, an expired pass, no mint — takes the ordinary gated path (a card when
 * the stage asks). The wrapper never refuses on a mismatch and never signs
 * without the gate: a passed operation still goes through the gate's
 * `forwardPassed` (preflight, probe, stamp, activity record), which skips
 * only the decision.
 *
 * There is no shared pass store: the pass lives in this closure. The NIP-46
 * and NIP-55 server paths are handed the gate's `authorise` alone and never
 * reach `forwardPassed`.
 */
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import type { DecryptingSigningBackend } from './signing-backend';
import { CHILD_OWN_APP_ID, gatedSigningBackend, markGated, ungatedInner, type ChildGateMethod, type ChildGateOutcome } from './child-bunker';
import type { AppPermissionClaim } from './app-permission';
import type { ChildGateRequest } from '../hooks/useChildGate';

/** A pass lives this long from its mint (ms). */
export const ANSWER_SEAL_PASS_LIFETIME_MS = 60_000;

const ANSWER_RUMOR_KIND = 29999;
const SEAL_KIND = 13;
const HEX64 = /^[0-9a-f]{64}$/;

/** The two gate entries the wrapper uses. */
export interface AnswerSealGate {
  authorise(req: ChildGateRequest): Promise<ChildGateOutcome>;
  forwardPassed(req: ChildGateRequest): Promise<ChildGateOutcome>;
}

export interface AnswerSealingInput {
  /** The persona's Heartwood route (unwrapped if it is already gated). */
  inner: DecryptingSigningBackend;
  gate: AnswerSealGate;
  /** The persona every operation is for; must be `inner`'s key. */
  persona: string;
  /** The app's name, as the gate labels the request. */
  appLabel: string;
  /**
   * The app's origin: the gate decides as that site (as for Sign in with
   * Signet). With `appPermission` it must be the claim's origin (it defaults
   * to it): the guardian's "Always deny this" is a rule on that site.
   */
  siteOrigin?: string;
  /** D6: the app's claim, sent with the `eligibleKind` signature only. */
  appPermission?: AppPermissionClaim;
  /** The key the answer is gift-wrapped to. */
  sessionPubkey: string;
  /** The approved signature that mints the pass (30420; Part B: 21236). */
  eligibleKind: number;
  /** Where the answer's content carries the signed event (`event`; Part B: `authEvent`). */
  responseField: string;
  /** Unix ms clock (test seam). */
  now?: () => number;
}

interface Pass { eventId: string; mintedAt: number; ciphertext?: string; used: boolean }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function answerSealingBackend(input: AnswerSealingInput): DecryptingSigningBackend {
  const inner = ungatedInner(input.inner);
  const persona = input.persona.toLowerCase();
  if (!HEX64.test(persona) || inner.activePublicKeyHex.toLowerCase() !== persona) {
    throw new Error('answerSealingBackend: the backend is not the persona\'s');
  }
  const siteOrigin = input.siteOrigin ?? input.appPermission?.origin;
  if (input.appPermission && siteOrigin !== input.appPermission.origin) {
    throw new Error('answerSealingBackend: siteOrigin must be the claimed origin');
  }
  const session = input.sessionPubkey.toLowerCase();
  const now = input.now ?? (() => Date.now());
  const { gate, eligibleKind, responseField } = input;
  const base = {
    persona, appId: CHILD_OWN_APP_ID, appLabel: input.appLabel,
    ...(siteOrigin ? { siteOrigin } : {}),
  };
  const request = (req: { method: ChildGateMethod; template?: UnsignedEvent; peer?: string }): ChildGateRequest => ({
    ...base, method: req.method,
    ...(req.template ? { template: req.template } : {}), ...(req.peer ? { peer: req.peer } : {}),
  });
  const ordinary = gatedSigningBackend(inner, (req) => gate.authorise({
    ...request(req),
    ...(input.appPermission && req.template?.kind === eligibleKind ? { appPermission: input.appPermission } : {}),
  }));
  const passed = gatedSigningBackend(inner, (req) => gate.forwardPassed(request(req)));

  let pass: Pass | null = null;
  let minted = false;
  const livePass = (): Pass | null =>
    pass && !pass.used && now() - pass.mintedAt <= ANSWER_SEAL_PASS_LIFETIME_MS ? pass : null;

  /** The plaintext is THE answer rumor for the minted event. */
  const isAnswerRumor = (plaintext: string, eventId: string): boolean => {
    try {
      const r: unknown = JSON.parse(plaintext);
      if (!isObject(r) || r.kind !== ANSWER_RUMOR_KIND || r.pubkey !== persona || !Array.isArray(r.tags) || typeof r.content !== 'string') return false;
      const tags = r.tags as unknown[];
      const pair = (t: unknown, name: string) => Array.isArray(t) && t.length === 2 && t[0] === name && typeof t[1] === 'string';
      const statuses = tags.filter(t => Array.isArray(t) && t[0] === 'status');
      if (statuses.length !== 1 || !pair(statuses[0], 'status') || (statuses[0] as string[])[1] !== 'approved') return false;
      if (!tags.some(t => pair(t, 'session'))) return false;
      const content: unknown = JSON.parse(r.content);
      if (!isObject(content)) return false;
      const event = content[responseField];
      return isObject(event) && event.id === eventId;
    } catch { return false; }
  };

  const wrapper: DecryptingSigningBackend = {
    type: inner.type,
    get activePublicKeyHex() { return inner.activePublicKeyHex; },
    ...(inner.transportClientPubkeyHex ? { transportClientPubkeyHex: inner.transportClientPubkeyHex } : {}),

    async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
      const p = livePass();
      if (p && p.ciphertext !== undefined && event.kind === SEAL_KIND && Array.isArray(event.tags) && event.tags.length === 0
        && event.pubkey === persona && event.content === p.ciphertext) {
        p.used = true; // used up before the call: a failed seal does not leave it open
        return passed.signEvent(event);
      }
      const signed = await ordinary.signEvent(event);
      if (!minted && signed.kind === eligibleKind && signed.pubkey === persona && typeof signed.id === 'string' && HEX64.test(signed.id)) {
        minted = true;
        pass = { eventId: signed.id, mintedAt: now(), used: false };
      }
      return signed;
    },

    async nip44Encrypt(peer: string, plaintext: string): Promise<string> {
      const p = livePass();
      if (p && typeof peer === 'string' && peer.toLowerCase() === session && isAnswerRumor(plaintext, p.eventId)) {
        const ciphertext = await passed.nip44Encrypt(peer, plaintext);
        if (!p.used) p.ciphertext = ciphertext;
        return ciphertext;
      }
      return ordinary.nip44Encrypt(peer, plaintext);
    },

    async nip44Decrypt(peer: string, ciphertext: string): Promise<string> {
      return ordinary.nip44Decrypt(peer, ciphertext);
    },

    destroy() { /* the inner route is shared */ },
  };
  return markGated(wrapper, inner);
}
