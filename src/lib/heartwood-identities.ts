/**
 * `heartwood_list_identities` — the identities a Heartwood master serves
 * (itself plus its registry personas). NIP-46 extension, always
 * auto-approved, pre-slot-binding. Firmware shape (`identity_cache.rs`
 * `list_json`): `[{ npub, pubkey, purpose, index, personaName? }]`, purpose
 * strings like `nostr:persona:natural-person`, `nostr:persona:persona`,
 * `nostr:persona:dependant-0-np`.
 *
 * Why the app reads it at Heartwood onboarding: on a family bunker the
 * primary pairing is bound to the MASTER (an earlier hardware finding), so
 * `get_public_key` on that pairing returns the master pubkey — but the
 * guardian's Natural Person is the derived `natural-person` persona, and
 * that is the pubkey the firmware addresses every C4/C5 gift-wrap to
 * (`guardian_np()`). An identity created with NP = master would subscribe
 * for notices on the wrong key. `pickOwnerIdentities` picks the NP (and
 * default Persona) pubkeys off the list; callers fall back to the master
 * only when the list has no `natural-person` entry (generic bunkers).
 */

const HEX64 = /^[0-9a-f]{64}$/i;

export interface HeartwoodIdentity {
  pubkey: string;      // lowercase hex64
  purpose: string;
  index: number;
  personaName?: string;
}

/** Parse the raw `heartwood_list_identities` result. Malformed rows are dropped. */
export function parseHeartwoodIdentities(raw: string): HeartwoodIdentity[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const rows = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { identities?: unknown }).identities))
      ? (parsed as { identities: unknown[] }).identities
      : [];
  const out: HeartwoodIdentity[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.pubkey !== 'string' || !HEX64.test(o.pubkey)) continue;
    if (typeof o.purpose !== 'string' || o.purpose.length === 0 || o.purpose.length > 128) continue;
    const index = typeof o.index === 'number' && Number.isInteger(o.index) && o.index >= 0 ? o.index : 0;
    const row: HeartwoodIdentity = { pubkey: o.pubkey.toLowerCase(), purpose: o.purpose, index };
    if (typeof o.personaName === 'string' && o.personaName.length <= 100) row.personaName = o.personaName;
    out.push(row);
  }
  return out;
}

/** True when a purpose string names the given nsec-tree persona (`natural-person`, `persona`, `dependant-0-np`, …). */
export function purposeIs(purpose: string, name: string): boolean {
  return purpose === name || purpose.endsWith(`:${name}`);
}

/**
 * The owner's NP / default-Persona pubkeys as served by the device (index 0
 * of each purpose). Either may be absent — a freshly-provisioned or generic
 * bunker serves neither, and the caller keeps the master as NP.
 */
export function pickOwnerIdentities(list: HeartwoodIdentity[]): { naturalPerson?: string; persona?: string } {
  const first = (name: string) => list
    .filter(i => purposeIs(i.purpose, name))
    .sort((a, b) => a.index - b.index)[0]?.pubkey;
  const out: { naturalPerson?: string; persona?: string } = {};
  const np = first('natural-person');
  const persona = first('persona');
  if (np) out.naturalPerson = np;
  if (persona) out.persona = persona;
  return out;
}
