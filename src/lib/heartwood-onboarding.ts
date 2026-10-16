/**
 * Heartwood onboarding: decide which keys a freshly-paired signing device
 * hands the new install. A family Heartwood pairs against its MASTER pubkey,
 * which must never become the user's identity. A device that answers
 * `heartwood_list_identities` is a Heartwood, and its natural-person /
 * persona keys are listed or derived (a derive may need a button press).
 * Any failure on that path THROWS rather than falling back to the master. A
 * device that rejects the list call is a generic NIP-46 signer and keeps
 * its single key.
 */
import { parseHeartwoodIdentities, pickOwnerIdentities } from './heartwood-identities';
import { derivePersonaToken } from './heartwood-enrolment';

export type OnboardingKeys =
  | { kind: 'heartwood'; naturalPerson: string; persona: string }
  | { kind: 'generic' };

export type OnboardingFailure = 'unreachable' | 'not-approved' | 'storage-full' | 'bad-key';

export class HeartwoodOnboardingError extends Error {
  readonly reason: OnboardingFailure;
  constructor(reason: OnboardingFailure) {
    super(HEARTWOOD_ONBOARDING_COPY[reason]);
    this.name = 'HeartwoodOnboardingError';
    this.reason = reason;
  }
}

export const HEARTWOOD_ONBOARDING_COPY: Record<OnboardingFailure, string> = {
  'unreachable': "Couldn't reach your Heartwood. Check it's switched on and online, then try again.",
  'not-approved': "Your Heartwood didn't approve in time. Tap Try again, then press the button on your Heartwood when it asks.",
  'storage-full': 'Your Heartwood has no room for another identity.',
  'bad-key': 'Your Heartwood returned an unexpected key. Nothing was saved.',
};

// Longer than the firmware's 30 s LIST IDS card, so an unpressed card comes
// back as the device's own "timeout" reply (not-approved), and only a silent
// device trips this one (unreachable).
const DEFAULT_LIST_TIMEOUT_MS = 60_000;
const DEFAULT_DERIVE_TIMEOUT_MS = 120_000;
const UNKNOWN_METHOD = /unknown method|method not (supported|found)|unsupported method|not implemented/i;
const HEX64_LOWER = /^[0-9a-f]{64}$/;

type ListOutcome = { ok: true; raw: string } | { ok: false; kind: 'transport' } | { ok: false; kind: 'remote'; message: string };

function listIdentities(
  requestFn: (method: string, params: string[]) => Promise<string>,
  timeoutMs: number,
): Promise<ListOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (o: ListOutcome) => { if (!settled) { settled = true; clearTimeout(timer); resolve(o); } };
    const timer = setTimeout(() => finish({ ok: false, kind: 'transport' }), timeoutMs);
    requestFn('heartwood_list_identities', []).then(
      (raw) => finish({ ok: true, raw }),
      // nostr-tools rejects a remote NIP-46 error reply with the raw string;
      // transport failures reject with Error instances.
      (e: unknown) => finish(e instanceof Error ? { ok: false, kind: 'transport' } : { ok: false, kind: 'remote', message: String(e) }),
    );
  });
}

export async function resolveOnboardingKeys(
  requestFn: (method: string, params: string[]) => Promise<string>,
  masterPubkey: string,
  opts: { listTimeoutMs?: number; deriveTimeoutMs?: number } = {},
): Promise<OnboardingKeys> {
  const listTimeoutMs = opts.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  const deriveTimeoutMs = opts.deriveTimeoutMs ?? DEFAULT_DERIVE_TIMEOUT_MS;

  const listed = await listIdentities(requestFn, listTimeoutMs);
  if (!listed.ok) {
    // Timeouts and transport failures (Error instances) mean we do not know
    // what the device is: never adopt the master from silence.
    if (listed.kind === 'transport') throw new HeartwoodOnboardingError('unreachable');
    // A string is a remote NIP-46 error reply. Only "unknown method" means a
    // generic signer; a Heartwood also refuses with "user denied", "timeout",
    // "unauthorised" and similar, which must not fall back to the master.
    if (UNKNOWN_METHOD.test(listed.message)) return { kind: 'generic' };
    throw new HeartwoodOnboardingError('not-approved');
  }

  const owner = pickOwnerIdentities(parseHeartwoodIdentities(listed.raw));
  let naturalPerson = owner.naturalPerson ?? '';
  let persona = owner.persona ?? '';

  const derive = async (token: string): Promise<string> => {
    const d = await derivePersonaToken(requestFn, token, deriveTimeoutMs);
    if (d.status === 'ok') return d.pubkeyHex;
    throw new HeartwoodOnboardingError(d.status === 'storage-full' ? 'storage-full' : 'not-approved');
  };

  if (!naturalPerson) naturalPerson = await derive('natural-person');
  if (!persona) persona = await derive('persona');

  const master = masterPubkey.toLowerCase();
  const valid = (k: string) => HEX64_LOWER.test(k) && k !== master;
  if (!valid(naturalPerson) || !valid(persona) || naturalPerson === persona) {
    throw new HeartwoodOnboardingError('bad-key');
  }
  return { kind: 'heartwood', naturalPerson, persona };
}
