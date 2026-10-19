/**
 * The decision half of `handleConnectHeartwood` (One-hold A1, A10): offer the
 * hold, take the keys from the device's reply or from today's flow, and work
 * out what to keep on file. Pulled out of App.tsx so it can be tested with a
 * fake signer; App keeps the bunker, the retry slot and the saving.
 */
import {
  negotiateFullAccess,
  type FullAccessDecision,
  type HeartwoodConnectUi,
  type OwnerStyle,
} from './heartwood-one-hold';
import { resolveOnboardingKeys, type OnboardingKeys } from './heartwood-onboarding';

/** What is kept on file after a hold: the device's answer, not the tap. */
export interface OwnerGrantOnFile {
  style: OwnerStyle;
  actAs: string[];
}

export interface HeartwoodConnectOutcome {
  fullAccess: FullAccessDecision;
  keys: OnboardingKeys;
  /** Present only when a bundle worked. */
  ownerGrant?: OwnerGrantOnFile;
}

/** The owner backed out of the choice screen. */
export class HeartwoodConnectCancelled extends Error {
  constructor() {
    super('Cancelled. Nothing was changed.');
    this.name = 'HeartwoodConnectCancelled';
  }
}

/**
 * Key resolution failed after the owner had already decided. The decision is
 * carried so a retry does not ask for a second hold.
 */
export class HeartwoodConnectFailed extends Error {
  readonly fullAccess: FullAccessDecision;
  readonly original: unknown;
  constructor(original: unknown, fullAccess: FullAccessDecision) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'HeartwoodConnectFailed';
    this.original = original;
    this.fullAccess = fullAccess;
  }
}

export interface HeartwoodConnectSigner {
  /** This install's NIP-46 client key: the words and the request both come from it. */
  transportClientPubkeyHex: string;
  activePublicKeyHex: string;
  request: (method: string, params: string[], timeoutMs?: number) => Promise<string>;
}

export function ownerGrantFromDecision(decision: FullAccessDecision | undefined): OwnerGrantOnFile | undefined {
  if (decision?.mode !== 'bundle') return undefined;
  // The device's answer: its style and the identities it granted.
  return { style: decision.reply.style, actAs: decision.reply.actAs };
}

export async function resolveHeartwoodConnect(args: {
  signer: HeartwoodConnectSigner;
  ui: HeartwoodConnectUi | undefined;
  /** One capabilities attempt: the method list, or null for any failure. */
  probe: () => Promise<readonly string[] | null>;
  /** A decision from an earlier failed attempt on the same pairing. */
  held?: FullAccessDecision;
}): Promise<HeartwoodConnectOutcome> {
  const { signer } = args;
  let fullAccess = args.held;
  if (!fullAccess) {
    fullAccess = await negotiateFullAccess({
      ui: args.ui,
      probe: args.probe,
      clientPubkeyHex: signer.transportClientPubkeyHex,
      masterPubkey: signer.activePublicKeyHex,
      request: (method, params, timeoutMs) => signer.request(method, params, timeoutMs),
    });
    if (fullAccess.mode === 'cancel') throw new HeartwoodConnectCancelled();
  }
  try {
    const keys: OnboardingKeys = fullAccess.mode === 'bundle'
      // The reply is already validated (hex64, not the master, real identity
      // differs from the persona) by `parseBundleReply`.
      ? { kind: 'heartwood', naturalPerson: fullAccess.reply.naturalPerson, persona: fullAccess.reply.persona }
      : await resolveOnboardingKeys((method, params) => signer.request(method, params), signer.activePublicKeyHex);
    return { fullAccess, keys, ownerGrant: ownerGrantFromDecision(fullAccess) };
  } catch (err) {
    throw new HeartwoodConnectFailed(err, fullAccess);
  }
}
