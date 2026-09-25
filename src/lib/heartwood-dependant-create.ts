/**
 * Bunker-mode dependant creation (family-bunker §11.1.8, decision D4).
 *
 * After migration the phone holds no mnemonic, so "Add dependant" cannot
 * derive keys locally. Instead the device derives the dependant's NP and
 * persona from ITS copy of the tree via `heartwood_derive_persona` (C2), and
 * the phone records only the returned public keys — `privateKey: ''` on
 * every slot, exactly the shape the migration strip leaves behind. Tokens
 * follow the same contract the wizard enrols with (`dependant-N-np`,
 * `dependant-N-persona`, `dependant-N-persona-K`), so a later re-enrol is
 * an idempotent no-op on the device.
 *
 * Pure: takes a request function; App.tsx supplies the master pairing.
 */
import { derivePersonaToken } from './heartwood-enrolment';

export type HeartwoodRequestFn = (method: string, params: string[]) => Promise<string>;
export interface DerivedKeypair { publicKey: string; privateKey: '' }

/**
 * Derive ONE extra-persona slot on the device, by its raw derivation token
 * (owner: `persona-N`; dependant: `dependant-N-persona-K`). Supplied by
 * App.tsx from the master Heartwood pairing; when absent, callers fall back
 * to their local mnemonic path. Lives here rather than in a hook so both
 * `useDependants` and `useIdentity` can import it without hook-to-hook
 * coupling (`useDependants` re-exports it for existing call sites).
 */
export type ExtraPersonaDeviceDerive = (derivationName: string) => Promise<DerivedKeypair>;

export class HeartwoodDeriveError extends Error {
  readonly code: 'storage-full' | 'timeout' | 'error';
  readonly token: string;
  constructor(code: HeartwoodDeriveError['code'], token: string, message: string) {
    super(message);
    this.name = 'HeartwoodDeriveError';
    this.code = code;
    this.token = token;
  }
}

const DEPENDANT_PATH_RE = /^dependant-(0|[1-9]\d*)$/;

/** Next free `dependant-N` index — max(existing derived index)+1, never reusing a removed index. */
export function nextDependantIndex(dependants: ReadonlyArray<{ derivationPath: string }>): number {
  let max = -1;
  for (const d of dependants) {
    const m = DEPENDANT_PATH_RE.exec(d.derivationPath);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

async function deriveToken(requestFn: HeartwoodRequestFn, token: string, timeoutMs?: number): Promise<DerivedKeypair> {
  const out = await derivePersonaToken(requestFn, token, timeoutMs);
  if (out.status === 'ok') return { publicKey: out.pubkeyHex, privateKey: '' };
  const code = out.status === 'storage-full' ? 'storage-full' : /timed out/i.test(out.message) ? 'timeout' : 'error';
  throw new HeartwoodDeriveError(code, token, friendlyMessage(code, out.message));
}

function friendlyMessage(code: HeartwoodDeriveError['code'], raw: string): string {
  switch (code) {
    case 'storage-full': return 'Your Heartwood signer has no room for another identity. Remove one on the device, then try again.';
    case 'timeout': return 'Timed out waiting for your Heartwood signer — check it is on and connected, then try again.';
    default: return raw || 'Your Heartwood signer could not create this identity.';
  }
}

/** Derive a dependant's NP + persona on the device. Sequential (the device is single-threaded); a partial failure is safe to retry — re-derives are idempotent. */
export async function deriveDependantOnDevice(
  requestFn: HeartwoodRequestFn,
  derivationPath: string,
  timeoutMs?: number,
): Promise<{ naturalPerson: DerivedKeypair; persona: DerivedKeypair }> {
  if (!DEPENDANT_PATH_RE.test(derivationPath)) throw new Error('Invalid dependant derivation path');
  const naturalPerson = await deriveToken(requestFn, `${derivationPath}-np`, timeoutMs);
  const persona = await deriveToken(requestFn, `${derivationPath}-persona`, timeoutMs);
  return { naturalPerson, persona };
}

/** Derive one extra persona (raw derivationName token, e.g. `dependant-1-persona-2`). */
export function deriveExtraPersonaOnDevice(
  requestFn: HeartwoodRequestFn,
  derivationName: string,
  timeoutMs?: number,
): Promise<DerivedKeypair> {
  if (!derivationName) throw new Error('Invalid derivation name');
  return deriveToken(requestFn, derivationName, timeoutMs);
}
