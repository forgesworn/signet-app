import type { SignetIdentity } from '../types/identity';
import type { DependantIdentity } from '../types/dependants';
import { decodeNpub } from './signet';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * Pure-logic core of the "migrate family to Heartwood" wizard
 * (family-bunker migration §11.1.3). Two responsibilities live here:
 *
 * 1. `buildEnrolmentPlan` — walks the owner identity + dependants and
 *    decides which keypair slots can be re-derived on the Heartwood
 *    device (tree-derived slots) versus which must stay local
 *    (imported / mirrored / missing-key slots).
 * 2. `enrolSlot` (Task 2) — drives `heartwood_derive_persona` for a
 *    single slot and verifies the device derived the SAME pubkey the
 *    app already has on file.
 */

export interface EnrolmentSlot {
  /** Bare derivation token passed to heartwood_derive_persona, e.g. 'natural-person', 'persona-2', 'dependant-0-np' */
  token: string;
  /** Locally stored pubkey the device's derived npub must match (lowercase hex) */
  expectedPubkeyHex: string;
  /** Display label for the wizard row, e.g. 'Alex (you)', 'Anon persona', 'Robin — anonymous persona' */
  label: string;
  kind: 'owner-np' | 'owner-persona' | 'owner-pro' | 'owner-extra' | 'dep-np' | 'dep-persona' | 'dep-extra';
  /** Present for dep-* kinds */
  depId?: string;
}

export interface SkippedSlot {
  label: string;
  reason: 'imported-persona' | 'imported-dependant' | 'mirror-persona' | 'missing-pubkey';
}

export interface EnrolmentPlan {
  slots: EnrolmentSlot[];
  skipped: SkippedSlot[];
}

const DEPENDANT_PATH_RE = /^dependant-\d+$/;

function pushOrSkip(
  slots: EnrolmentSlot[],
  skipped: SkippedSlot[],
  slot: Omit<EnrolmentSlot, 'expectedPubkeyHex'>,
  publicKey: string,
): void {
  if (!publicKey) {
    skipped.push({ label: slot.label, reason: 'missing-pubkey' });
    return;
  }
  slots.push({ ...slot, expectedPubkeyHex: publicKey.toLowerCase() });
}

/** True when an extra-persona-shaped slot (owner or dep) came from the mnemonic tree. */
function isTreeDerivedExtra(derivationName: string): boolean {
  return derivationName !== '';
}

export function buildEnrolmentPlan(
  identity: Pick<SignetIdentity, 'naturalPerson' | 'persona' | 'professionalPersona' | 'extraPersonas'>,
  dependants: DependantIdentity[],
): EnrolmentPlan {
  const slots: EnrolmentSlot[] = [];
  const skipped: SkippedSlot[] = [];

  pushOrSkip(
    slots,
    skipped,
    {
      token: 'natural-person',
      kind: 'owner-np',
      label: `${identity.naturalPerson.displayName} (you)`,
    },
    identity.naturalPerson.publicKey,
  );

  pushOrSkip(
    slots,
    skipped,
    {
      token: 'persona',
      kind: 'owner-persona',
      label: identity.persona.displayName,
    },
    identity.persona.publicKey,
  );

  if (identity.professionalPersona) {
    // Present-but-empty-pubkey pro is reported as a skip (missing-pubkey),
    // not silently omitted — buildEnrolmentPlan is the only place that
    // knows a pro slot exists at all, so the intro "stays on this phone"
    // list would otherwise never mention it.
    pushOrSkip(
      slots,
      skipped,
      {
        token: 'professional',
        kind: 'owner-pro',
        label: identity.professionalPersona.displayName,
      },
      identity.professionalPersona.publicKey,
    );
  }

  for (const extra of identity.extraPersonas ?? []) {
    if (!isTreeDerivedExtra(extra.derivationName)) {
      skipped.push({
        label: extra.displayName,
        reason: extra.imported === true ? 'imported-persona' : 'mirror-persona',
      });
      continue;
    }
    pushOrSkip(
      slots,
      skipped,
      {
        token: extra.derivationName,
        kind: 'owner-extra',
        label: extra.displayName,
      },
      extra.publicKey,
    );
  }

  for (const dep of dependants) {
    if (!DEPENDANT_PATH_RE.test(dep.derivationPath)) {
      skipped.push({ label: dep.displayName, reason: 'imported-dependant' });
      continue;
    }

    pushOrSkip(
      slots,
      skipped,
      {
        token: `${dep.derivationPath}-np`,
        kind: 'dep-np',
        depId: dep.id,
        label: `${dep.displayName} — natural person`,
      },
      dep.naturalPerson.publicKey,
    );

    pushOrSkip(
      slots,
      skipped,
      {
        token: `${dep.derivationPath}-persona`,
        kind: 'dep-persona',
        depId: dep.id,
        label: `${dep.displayName} — anonymous persona`,
      },
      dep.persona.publicKey,
    );

    for (const extra of dep.extraPersonas ?? []) {
      if (!isTreeDerivedExtra(extra.derivationName)) {
        skipped.push({
          label: `${dep.displayName} — ${extra.displayName}`,
          reason: extra.imported === true ? 'imported-persona' : 'mirror-persona',
        });
        continue;
      }
      pushOrSkip(
        slots,
        skipped,
        {
          token: extra.derivationName,
          kind: 'dep-extra',
          depId: dep.id,
          label: `${dep.displayName} — ${extra.displayName}`,
        },
        extra.publicKey,
      );
    }
  }

  return { slots, skipped };
}

/** Parsed `heartwood_derive_persona` result payload. */
export interface DeriveResult {
  npub: string;
  purpose: string;
  index: number;
  personaName: string;
}

/** Parse a heartwood_derive_persona result payload (string-wrapped JSON). */
export function parseDerivePersonaResult(raw: string): DeriveResult | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as { npub?: unknown; purpose?: unknown; index?: unknown; personaName?: unknown };
    if (typeof obj.npub !== 'string' || typeof obj.purpose !== 'string') return null;
    if (typeof obj.index !== 'number' || typeof obj.personaName !== 'string') return null;
    return { npub: obj.npub, purpose: obj.purpose, index: obj.index, personaName: obj.personaName };
  } catch {
    return null;
  }
}

export type EnrolOutcome =
  | { status: 'verified'; pubkeyHex: string }
  | { status: 'mismatch'; gotPubkeyHex: string }
  | { status: 'storage-full'; message: string }
  | { status: 'error'; message: string };

const DEFAULT_ENROL_TIMEOUT_MS = 120_000;
const STORAGE_FULL_MARKER = 'identity storage full';
const TIMEOUT_MESSAGE = 'Timed out waiting for the signer — check the device and try again';
const UNEXPECTED_RESPONSE_MESSAGE = 'Unexpected response from signer';

const isStorageFull = (message: string): boolean => message.includes(STORAGE_FULL_MARKER);

export type DeriveTokenOutcome =
  | { status: 'ok'; pubkeyHex: string; index: number; purpose: string }
  | { status: 'storage-full'; message: string }
  | { status: 'error'; message: string };

/**
 * One `heartwood_derive_persona` round-trip for a single derivation token,
 * with the wizard-owned timeout and the -4 storage-full mapping. Shared by
 * the migration wizard (verify against a stored pubkey) and bunker-mode
 * dependant creation (accept the device's pubkey as the new identity).
 */
export function derivePersonaToken(
  requestFn: (method: string, params: string[]) => Promise<string>,
  token: string,
  timeoutMs: number = DEFAULT_ENROL_TIMEOUT_MS,
): Promise<DeriveTokenOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (o: DeriveTokenOutcome) => { if (!settled) { settled = true; clearTimeout(timer); resolve(o); } };
    const timer = setTimeout(() => finish({ status: 'error', message: TIMEOUT_MESSAGE }), timeoutMs);
    (async () => {
      let raw: string;
      try {
        raw = await requestFn('heartwood_derive_persona', [token]);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        finish(isStorageFull(message) ? { status: 'storage-full', message } : { status: 'error', message });
        return;
      }
      const parsed = parseDerivePersonaResult(raw);
      if (!parsed) { finish({ status: 'error', message: UNEXPECTED_RESPONSE_MESSAGE }); return; }
      let pubkeyHex: string;
      try { pubkeyHex = bytesToHex(decodeNpub(parsed.npub)).toLowerCase(); }
      catch { finish({ status: 'error', message: UNEXPECTED_RESPONSE_MESSAGE }); return; }
      finish({ status: 'ok', pubkeyHex, index: parsed.index, purpose: parsed.purpose });
    })();
  });
}

/**
 * Derive a single slot's keypair on the Heartwood device and verify it
 * matches the pubkey the app already has on file. requestFn is
 * BunkerSigningBackend.request-shaped: rejects with the NIP-46 error
 * message on error responses.
 */
export async function enrolSlot(
  requestFn: (method: string, params: string[]) => Promise<string>,
  slot: EnrolmentSlot,
  timeoutMs: number = DEFAULT_ENROL_TIMEOUT_MS,
): Promise<EnrolOutcome> {
  const out = await derivePersonaToken(requestFn, slot.token, timeoutMs);
  if (out.status !== 'ok') return out; // storage-full / error pass through unchanged
  return out.pubkeyHex === slot.expectedPubkeyHex
    ? { status: 'verified', pubkeyHex: out.pubkeyHex }
    : { status: 'mismatch', gotPubkeyHex: out.pubkeyHex };
}
