/**
 * Heartwood operator-key custody (family-bunker §11.1.4/9, C3 design §5).
 *
 * The operator key authorises relay-mediated device management (kind 24134 —
 * policy push, `resolve_approval` verdicts). It is NOT the device master seed
 * and never signs the owner's events. Sapwood hands it to this app either as a
 * deep link (`#/import?op=…` plain, or `#/import?eop=ncryptsec1…` PIN-protected)
 * or as the operator recovery phrase, which re-derives the same key at the
 * NIP-06 path `m/44'/1237'/0'/0/0` (the master seed lives on a different path,
 * so the two authorities never collide).
 *
 * This module is pure — no storage, no relay. Persistence lives in `db.ts`
 * (`saveHeartwoodOperator` / `loadHeartwoodOperator` / `deleteHeartwoodOperator`)
 * as one encrypted `identity`-store row, the same pattern as `bunkerSecret`.
 *
 * Port of `sapwood/src/lib/import-link.svelte.ts` (`parseImportLink`) and
 * `sapwood/src/lib/operator-key.ts`.
 */

import { getPublicKey } from 'nostr-tools/pure';
import { decrypt as nip49Decrypt } from 'nostr-tools/nip49';
import { privateKeyFromSeedWords, validateWords } from 'nostr-tools/nip06';
import * as nip19 from 'nostr-tools/nip19';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/** Minimum PIN length accepted for a PIN-protected (`eop=`) handoff link. */
export const HEARTWOOD_OPERATOR_PIN_MIN = 6;

/** Cap on relays carried over from a handoff link. */
export const HEARTWOOD_HANDOFF_RELAY_CAP = 8;

/** Max length of a single relay URL in a handoff link. */
const HANDOFF_RELAY_MAX_LEN = 512;

const HEX64_RE = /^[0-9a-f]{64}$/;
const NCRYPTSEC_RE = /^ncryptsec1[02-9ac-hj-np-z]+$/;

/** Parsed contents of a Sapwood `#/import?…` handoff link. */
export interface HeartwoodHandoffLink {
  /** Plain 64-hex operator secret. */
  op?: string;
  /** PIN-protected operator secret (NIP-49 `ncryptsec1…`). */
  eop?: string;
  /** Device MASTER pubkey (x-only hex) — its kind-24134 management address. */
  deviceHex?: string;
  /** Relays the device listens on (`wss://` only). */
  relays?: string[];
}

/** The persisted operator credential (encrypted at rest — see `db.ts`). */
export interface HeartwoodOperatorCredential {
  /** 64-hex operator secret (never persisted in clear). */
  skHex: string;
  /** x-only pubkey of skHex — the device's `op_mgmt`. */
  pubHex: string;
  /** Device MASTER pubkey (kind-24134 address). */
  deviceHex: string;
  /** Proven relays from the handoff link (wss://). */
  relays: string[];
  /** Unix seconds. */
  importedAt: number;
}

/** A relay carried in a handoff link is only trusted when it's `wss:`, has a
 *  hostname, carries no credentials, and is a sane length. */
export function isSafeHandoffRelay(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > HANDOFF_RELAY_MAX_LEN) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'wss:'
      && url.hostname.length > 0
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

/** Accept an npub or 64-char hex; return x-only lowercase hex, or null. */
function toDeviceHex(input: string): string | null {
  const s = input.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  try {
    const d = nip19.decode(s);
    if (d.type === 'npub' && typeof d.data === 'string' && HEX64_RE.test(d.data)) return d.data;
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Reduce whatever the user pasted (full URL, bare `#/import?…` fragment, or the
 * naked query string) to the fragment we match on. Returns null when there's no
 * `#/import` route to be found.
 */
function extractImportFragment(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const hashIdx = s.indexOf('#');
  if (hashIdx !== -1) return s.slice(hashIdx);
  // No hash at all — accept a bare `/import?…` or a bare query.
  if (/^\/import\b/.test(s)) return `#${s}`;
  if (s.startsWith('?')) return `#/import${s}`;
  if (/^(op|eop|dev|relays)=/.test(s)) return `#/import?${s}`;
  return null;
}

/**
 * Parse a Sapwood handoff link into its parts, or null if it isn't an import
 * link / carries no usable operator secret (neither a valid `op` hex nor an
 * `eop` ncryptsec). If both are present `op` wins.
 */
export function parseHeartwoodImportLink(input: string): HeartwoodHandoffLink | null {
  if (typeof input !== 'string') return null;
  const hash = extractImportFragment(input);
  if (!hash || !/^#\/import\b/.test(hash)) return null;
  const qi = hash.indexOf('?');
  if (qi === -1) return null;
  const params = new URLSearchParams(hash.slice(qi + 1));
  const op = (params.get('op') ?? '').trim().toLowerCase();
  const eop = (params.get('eop') ?? '').trim();
  const hasOp = HEX64_RE.test(op);
  const hasEop = NCRYPTSEC_RE.test(eop);
  if (!hasOp && !hasEop) return null;

  const out: HeartwoodHandoffLink = {};
  if (hasOp) out.op = op;
  else out.eop = eop;

  const dev = params.get('dev');
  if (dev) {
    const hex = toDeviceHex(dev);
    if (hex) out.deviceHex = hex;
  }

  const relays = params.get('relays');
  if (relays) {
    const list = relays
      .split(',')
      .map((r) => r.trim())
      .filter(isSafeHandoffRelay)
      .slice(0, HEARTWOOD_HANDOFF_RELAY_CAP);
    if (list.length) out.relays = list;
  }
  return out;
}

/**
 * Decrypt a PIN-protected (`eop=`) operator secret. Returns the hex secret;
 * throws on a wrong PIN or malformed ncryptsec. Key bytes are zeroized.
 */
export function decryptOperatorLink(eop: string, pin: string): string {
  const bytes = nip49Decrypt(eop.trim(), pin);
  try {
    return bytesToHex(bytes);
  } finally {
    bytes.fill(0);
  }
}

/** Collapse whitespace and lower-case a phrase to its canonical BIP-39 form. */
export function normaliseOperatorPhrase(words: string): string {
  return words.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Derive the operator secret (hex) from its BIP-39 recovery phrase at the
 * NIP-06 path `m/44'/1237'/0'/0/0` (`privateKeyFromSeedWords`, account 0).
 * Throws `'Not a valid recovery phrase'` when the phrase fails BIP-39 checks.
 */
export function operatorFromPhrase(words: string): string {
  const phrase = normaliseOperatorPhrase(typeof words === 'string' ? words : '');
  if (!phrase || !validateWords(phrase)) throw new Error('Not a valid recovery phrase');
  const bytes = privateKeyFromSeedWords(phrase);
  try {
    return bytesToHex(bytes);
  } finally {
    bytes.fill(0);
  }
}

/** The x-only (schnorr) public key hex for an operator secret. Throws if the
 *  secret isn't a usable scalar. */
export function operatorPubkeyFromSecret(skHex: string): string {
  if (!HEX64_RE.test(skHex)) throw new Error('Operator secret must be 64 hex characters');
  const bytes = hexToBytes(skHex);
  try {
    return getPublicKey(bytes);
  } finally {
    bytes.fill(0);
  }
}

/**
 * Assemble the credential we persist from a parsed link plus the (resolved)
 * operator secret. Throws when the link is missing the pieces the management
 * channel can't work without.
 */
export function buildOperatorCredential(
  link: HeartwoodHandoffLink,
  skHex: string,
  now: number,
): HeartwoodOperatorCredential {
  if (!link.deviceHex || !HEX64_RE.test(link.deviceHex)) throw new Error('Link is missing the device address');
  if (!link.relays || link.relays.length === 0) throw new Error('Link carries no relays');
  const sk = skHex.trim().toLowerCase();
  const pubHex = operatorPubkeyFromSecret(sk);
  return {
    skHex: sk,
    pubHex,
    deviceHex: link.deviceHex,
    relays: [...link.relays],
    importedAt: Math.floor(now),
  };
}

/** Runtime guard for a decrypted credential row (defensive against a
 *  tampered/foreign IDB record). */
export function isHeartwoodOperatorCredential(v: unknown): v is HeartwoodOperatorCredential {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.skHex === 'string' && HEX64_RE.test(o.skHex)
    && typeof o.pubHex === 'string' && HEX64_RE.test(o.pubHex)
    && typeof o.deviceHex === 'string' && HEX64_RE.test(o.deviceHex)
    && Array.isArray(o.relays) && o.relays.every((r) => typeof r === 'string')
    && typeof o.importedAt === 'number' && Number.isFinite(o.importedAt);
}
