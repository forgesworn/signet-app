/**
 * signet.json template generation, fetch, and validation.
 * Spec: the internal Pro-surface architecture design doc, §6.5, §6.7
 */

import type { ProfessionKind, IdentifierKind } from './types';

/** Schema of the /.well-known/signet.json file published by a regulated entity. */
export interface SignetJsonPayload {
  schemaVersion: number;
  kind: string;
  entityName: string;
  identifier: { kind: string; value: string };
  /**
   * Singular lead pubkey (npub). Present in sole-lead signet.json.
   * Spec §6.5 — backward-compatible single-lead form.
   */
  headPubkey?: string;
  /**
   * Co-lead pubkeys (npub[]). Present in multi-lead signet.json.
   * Spec §3.5.2 — two or more co-equal leads.
   * Verifiers normalise both forms via normaliseLeadPubkeys().
   */
  headPubkeys?: string[];
  relays: string[];
  canonicalPage: string;
  publishedAt: string;
}

export interface GenerateSignetJsonOptions {
  professionKind: ProfessionKind;
  entityName: string;
  identifier: string;
  identifierKind: IdentifierKind;
  /** Pro persona npub(s) of the lead(s). 1 entry → emit headPubkey; 2+ → emit headPubkeys. */
  leadPubkeyNpubs: string[];
  canonicalDomain: string;
  relays: string[];
  publishedAt: string;
}

/**
 * Normalise a host for domain comparison.
 * Strips leading `www.`, lowercases, strips trailing slash.
 * Spec §12 Q1 default: strict host match after www. strip; case-insensitive.
 */
export function normaliseHost(host: string): string {
  let h = host.trim().toLowerCase();
  // Strip trailing slash if someone passed a full origin
  if (h.endsWith('/')) h = h.slice(0, -1);
  if (h.startsWith('www.')) h = h.slice(4);
  return h;
}

/**
 * Canonical normaliser for signet.json lead pubkey field(s).
 * Accepts either `headPubkey` (string), `headPubkeys` (string[]),
 * or both (union is returned, deduplicated).
 * Throws if the result is empty or exceeds 10 leads (sanity cap — spec §3.5.2).
 * Spec: the internal Pro-surface architecture design doc, §3.5.2
 */
export function normaliseLeadPubkeys(
  payload: { headPubkey?: string; headPubkeys?: string[] },
): string[] {
  const singular = payload.headPubkey ? [payload.headPubkey] : [];
  const plural = payload.headPubkeys ?? [];
  const combined = Array.from(new Set([...singular, ...plural]));
  if (combined.length === 0) {
    throw new Error('signet.json: at least one lead pubkey is required (headPubkey or headPubkeys)');
  }
  if (combined.length > 10) {
    throw new Error(`signet.json: at most 10 lead pubkeys are supported; found ${combined.length}`);
  }
  return combined;
}

/**
 * Generate a signet.json template string for the given entity.
 * Returns pretty-printed JSON ready to copy to the webmaster.
 * Emits headPubkey (singular string) when leadPubkeyNpubs has 1 entry,
 * or headPubkeys (array) when there are 2+ entries. Spec §6.5.
 */
export function generateSignetJson(opts: GenerateSignetJsonOptions): string {
  const base = {
    schemaVersion: 1,
    kind: opts.professionKind,
    entityName: opts.entityName,
    identifier: { kind: opts.identifierKind, value: opts.identifier },
    relays: opts.relays,
    canonicalPage: `https://${normaliseHost(opts.canonicalDomain)}/`,
    publishedAt: opts.publishedAt,
  };
  if (opts.leadPubkeyNpubs.length === 1) {
    return JSON.stringify({ ...base, headPubkey: opts.leadPubkeyNpubs[0] }, null, 2);
  }
  return JSON.stringify({ ...base, headPubkeys: opts.leadPubkeyNpubs }, null, 2);
}

const MAX_FETCH_BYTES = 8192; // 8KB cap per spec §6.7

/**
 * Validate a parsed signet.json payload.
 * Throws a descriptive Error on any validation failure.
 * Accepts both headPubkey (singular) and headPubkeys (array) forms.
 * The expectedPubkeys array must contain at least the device's own Pro persona npub.
 */
function assertValidSignetJson(
  raw: unknown,
  expectedIdentifier: string,
  expectedPubkeys: string[]
): asserts raw is SignetJsonPayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('signet.json: not a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj['schemaVersion'] !== 'number') {
    throw new Error('signet.json: missing or invalid schemaVersion');
  }
  if (typeof obj['kind'] !== 'string' || obj['kind'] === '') {
    throw new Error('signet.json: missing or invalid kind');
  }
  if (typeof obj['entityName'] !== 'string' || obj['entityName'] === '') {
    throw new Error('signet.json: missing or invalid entityName');
  }
  if (
    typeof obj['identifier'] !== 'object' ||
    obj['identifier'] === null ||
    typeof (obj['identifier'] as Record<string, unknown>)['value'] !== 'string'
  ) {
    throw new Error('signet.json: missing or invalid identifier object');
  }
  const identifierValue = (obj['identifier'] as Record<string, unknown>)['value'] as string;
  if (identifierValue !== expectedIdentifier) {
    throw new Error(
      `signet.json: identifier.value "${identifierValue}" does not match registry identifier "${expectedIdentifier}"`
    );
  }

  // Accept both headPubkey (singular) and headPubkeys (array) forms.
  let leadPubkeys: string[];
  try {
    leadPubkeys = normaliseLeadPubkeys({
      headPubkey: typeof obj['headPubkey'] === 'string' ? obj['headPubkey'] : undefined,
      headPubkeys: Array.isArray(obj['headPubkeys']) ? obj['headPubkeys'] as string[] : undefined,
    });
  } catch (e) {
    throw new Error(`signet.json: missing or invalid headPubkey — ${(e as Error).message}`);
  }

  // Verify the device's own pubkey is in the declared lead pubkeys.
  const devicePubkey = expectedPubkeys[0];
  if (devicePubkey && !leadPubkeys.includes(devicePubkey)) {
    throw new Error(
      `signet.json: headPubkey "${leadPubkeys.join(', ')}" does not match this device's pubkey "${devicePubkey}"`
    );
  }

  if (!Array.isArray(obj['relays'])) {
    throw new Error('signet.json: relays must be an array');
  }
  if (typeof obj['canonicalPage'] !== 'string' || obj['canonicalPage'] === '') {
    throw new Error('signet.json: missing or invalid canonicalPage');
  }
  if (typeof obj['publishedAt'] !== 'string' || obj['publishedAt'] === '') {
    throw new Error('signet.json: missing or invalid publishedAt');
  }
}

/**
 * Fetch and validate `/.well-known/signet.json` from the given domain origin.
 *
 * @param domainOrigin - Must be an `https://` origin, e.g. `https://springfield-school.example`.
 * @param expectedIdentifier - The registry identifier the JSON must declare.
 * @param expectedPubkeys - The device lead's npub(s) that must appear in headPubkey or headPubkeys.
 *   Pass a 1-element array `[npub]` for the single-lead (legacy) path.
 * @returns Parsed, validated payload.
 * @throws Error with a user-facing message on any validation or fetch failure.
 */
export async function fetchAndValidateSignetJson(
  domainOrigin: string,
  expectedIdentifier: string,
  expectedPubkeys: string | string[]
): Promise<SignetJsonPayload> {
  const pubkeysArray = Array.isArray(expectedPubkeys) ? expectedPubkeys : [expectedPubkeys];
  if (!domainOrigin.toLowerCase().startsWith('https://')) {
    throw new Error('signet.json must be served over HTTPS. HTTP is not accepted.');
  }

  const url = `${domainOrigin.replace(/\/$/, '')}/.well-known/signet.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`signet.json fetch failed: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  if (text.length > MAX_FETCH_BYTES) {
    throw new Error(
      `signet.json exceeds 8KB limit (${text.length} bytes). The file may be corrupt or served from the wrong path.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('signet.json: file is not valid JSON');
  }

  assertValidSignetJson(parsed, expectedIdentifier, pubkeysArray);
  return parsed;
}

// ── Verification-side types ───────────────────────────────────────────────────

/**
 * Minimal shape of a signet.json as used by the verify-chain module.
 * The `leadPubkey` field accepts both `headPubkey` (our published schema) and
 * the `leadPubkey` field name used in older references.
 * The `_fetchedFromHost` field is injected by `fetchProSignetJson` so the
 * caller can verify the fetch origin without trusting the JSON content.
 */
export interface ProSignetJson {
  schemaVersion: number;
  kind: string;
  name: string;
  identifier: { kind: string; value: string };
  jurisdiction: string;
  /**
   * Normalised leads array — populated by fetchProSignetJson from either
   * headPubkey (singular) or headPubkeys (array) or both.
   * Always length >= 1 after normalisation.
   * Spec §3.5.2.
   */
  leadPubkeys: string[];
  /** hex pubkey of the lead (kept for single-lead backward compat). First entry in leadPubkeys. */
  leadPubkey: string;
  relays: string[];
  /** Spec §12 Q5: optional array of additional entity identifiers. */
  entities: Array<{ kind: string; value: string }> | null;
  /** ISO-8601 fetch timestamp — injected by the fetcher, not from file. */
  fetchedAt: string;
  /** Hostname the file was actually fetched from — for domain-mismatch detection. */
  _fetchedFromHost?: string;
}

/**
 * Fetch a signet.json for third-party verification.
 * Unlike `fetchAndValidateSignetJson`, this does not require knowing the
 * expected identifier or pubkey in advance — those are validated by the
 * verify-chain after fetching.
 *
 * Returns null (not throws) on fetch or parse failure so the caller can
 * fail-closed gracefully.
 */
export async function fetchProSignetJson(domain: string): Promise<ProSignetJson | null> {
  const normalised = normaliseHost(domain);
  const origin = `https://${normalised}`;
  const url = `${origin}/.well-known/signet.json`;

  let text: string;
  // Track the response URL so a cross-origin redirect can't impersonate the
  // requested host. Without this, _fetchedFromHost would record the
  // caller-supplied host even when the response was actually served from
  // an attacker-controlled domain after a redirect. Audit pass 4.
  let fetchedFromHost = normalised;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    try {
      fetchedFromHost = normaliseHost(new URL(resp.url).host);
    } catch {
      // resp.url should always parse; if it somehow doesn't, fail closed
      // by leaving fetchedFromHost as the requested host — domain-mismatch
      // detection downstream will surface the discrepancy.
    }
    text = await resp.text();
  } catch {
    return null;
  }

  if (text.length > MAX_FETCH_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // Accept both `headPubkey`/`headPubkeys` (our schema) and `leadPubkey` (plan alias).
  // Use normaliseLeadPubkeys to handle both singular and array forms.
  let leadPubkeys: string[];
  try {
    leadPubkeys = normaliseLeadPubkeys({
      headPubkey: typeof obj['headPubkey'] === 'string' ? obj['headPubkey'] as string
        : typeof obj['leadPubkey'] === 'string' ? obj['leadPubkey'] as string
        : undefined,
      headPubkeys: Array.isArray(obj['headPubkeys']) ? obj['headPubkeys'] as string[] : undefined,
    });
  } catch {
    return null;
  }
  const leadPubkey = leadPubkeys[0];

  const identifier = obj['identifier'];
  if (
    typeof identifier !== 'object' ||
    identifier === null ||
    typeof (identifier as Record<string, unknown>)['value'] !== 'string'
  ) return null;

  const schemaVersion = typeof obj['schemaVersion'] === 'number' ? obj['schemaVersion'] : 1;
  const kind = typeof obj['kind'] === 'string' ? obj['kind'] : '';
  const name = typeof (obj['entityName'] ?? obj['name']) === 'string' ? (obj['entityName'] ?? obj['name']) as string : '';
  const jurisdiction = typeof obj['jurisdiction'] === 'string' ? obj['jurisdiction'] as string : '';
  const relays = Array.isArray(obj['relays']) ? obj['relays'] as string[] : [];
  const entities = Array.isArray(obj['entities']) ? obj['entities'] as Array<{ kind: string; value: string }> : null;

  return {
    schemaVersion,
    kind,
    name,
    identifier: identifier as { kind: string; value: string },
    jurisdiction,
    leadPubkeys,
    leadPubkey,
    relays,
    entities,
    fetchedAt: new Date().toISOString(),
    _fetchedFromHost: fetchedFromHost,
  };
}
