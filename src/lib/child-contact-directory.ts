import { verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'signet-protocol';
import type { ChildSettings, ContactRecord, ContactTier } from '../types';
import type { DecryptingSigningBackend } from './signing-backend';
import { resolveEffective } from './contacts-v2-effective';
import { contactBelongsToList } from './contacts-v2-membership';
import { sanitizeDisplayName } from './text-sanitize';

export const CHILD_CONTACT_DIRECTORY_TAG = 'signet:child-contact-directory:v1';
const HEX = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{32}$/;
const TTL = 900;
const MAX_BYTES = 48_000; // Fits one NIP-44 plaintext; no silent truncation.
const time = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 253402300799;
const keys = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max
  && v.every(k => typeof k === 'string' && HEX.test(k)) && new Set(v).size === v.length;
/** Read-only projection, deliberately not a ContactRecord or mutation input.
 * A displayed tier is the guardian's current effective view, not child evidence. */
export interface ChildDirectoryEntry {
  id: string;
  name: string;
  tier: ContactTier;
  identities: string[];
  lists: string[];
}
export interface ChildContactDirectory {
  v: 1;
  guardian: string;
  recipient: string;
  revision: number;
  issuedAt: number;
  expiresAt: number;
  conflicted: boolean;
  personas: string[];
  entries: ChildDirectoryEntry[];
}
export function parseChildContactDirectory(raw: string): ChildContactDirectory | null {
  if (new TextEncoder().encode(raw).length > MAX_BYTES) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || v.v !== 1 || typeof v.guardian !== 'string' || !HEX.test(v.guardian)
      || typeof v.recipient !== 'string' || !HEX.test(v.recipient) || !time(v.revision)
      || !time(v.issuedAt) || !time(v.expiresAt) || v.expiresAt <= v.issuedAt || v.expiresAt - v.issuedAt > TTL
      || typeof v.conflicted !== 'boolean' || !keys(v.personas, 32) || !Array.isArray(v.entries) || v.entries.length > 256) return null;
    const entries: ChildDirectoryEntry[] = [], ids = new Set<string>();
    for (const e of v.entries) {
      if (!e || typeof e.id !== 'string' || !ID.test(e.id) || ids.has(e.id) || typeof e.name !== 'string'
        || e.name !== sanitizeDisplayName(e.name, 200) || !['ken', 'kith', 'kin'].includes(e.tier)
        || !keys(e.identities, 32) || !e.identities.length || !keys(e.lists, 32) || !e.lists.length
        || e.lists.some((p: string) => !v.personas.includes(p))) return null;
      ids.add(e.id);
      entries.push({ id: e.id, name: e.name, tier: e.tier, identities: [...e.identities].sort(), lists: [...e.lists].sort() });
    }
    if (v.conflicted && entries.length) return null;
    return { v: 1, guardian: v.guardian, recipient: v.recipient, revision: v.revision, issuedAt: v.issuedAt,
      expiresAt: v.expiresAt, conflicted: v.conflicted, personas: [...v.personas].sort(), entries: entries.sort((a, b) => a.id.localeCompare(b.id)) };
  } catch { return null; }
}
export function projectChildContactDirectory(options: {
  child: string; guardian: string; recipient: string; availablePersonas: string[];
  settings?: ChildSettings; records: ContactRecord[]; revision: number; now: number;
}): ChildContactDirectory {
  const { child, guardian, recipient, availablePersonas, settings, records, revision, now } = options;
  if (!HEX.test(child) || !HEX.test(guardian) || !HEX.test(recipient) || !keys(availablePersonas, 32)
    || !time(now) || !time(revision)) throw new Error('Invalid child directory scope');
  if (settings && (settings.childPubkey !== child || settings.guardianPubkey !== guardian)) throw new Error('Foreign child settings');
  if (records.some(r => r.directoryId !== `dependant:${child}`)) throw new Error('Foreign contact directory');
  const entries: ChildDirectoryEntry[] = [];
  const context = { directoryIsDependant: true, activeGuardianPubkeys: [guardian], defaultChildCeiling: settings?.defaultChildCeiling ?? 'ken' as const };
  // A blocked peer must not reappear through a duplicate contact record.
  const effective = records.map(r => resolveEffective(r, context));
  const blockedPeers = new Set(effective.filter(r => r.blocked).flatMap(r => r.identities.map(i => i.pubkey)));
  if (!settings?.contactPolicyConflicted) for (const record of effective) {
    if (record.blocked || record.effectiveTier === 'none' || record.lifecycle !== 'active' || record.archived || record.removedAt !== undefined) continue;
    const lists = availablePersonas.filter(p => contactBelongsToList(record, p));
    const identities = [...new Set(record.identities.map(i => i.pubkey))].filter(p => !blockedPeers.has(p));
    if (!lists.length || !identities.length) continue;
    entries.push({ id: record.contactId, name: sanitizeDisplayName(record.displayName, 200), tier: record.effectiveTier, identities, lists });
  }
  const view = parseChildContactDirectory(JSON.stringify({ v: 1, guardian, recipient, revision, issuedAt: now,
    expiresAt: now + TTL, conflicted: !!settings?.contactPolicyConflicted, personas: availablePersonas, entries }));
  if (!view) throw new Error('Child directory exceeds bounds or contains invalid records');
  return view;
}
export function mergeChildContactDirectory(previous: ChildContactDirectory | null, incoming: ChildContactDirectory): ChildContactDirectory {
  const next = parseChildContactDirectory(JSON.stringify(incoming));
  if (!next) throw new Error('Invalid child directory');
  if (!previous) return next;
  const old = parseChildContactDirectory(JSON.stringify(previous));
  if (!old || old.guardian !== next.guardian || old.recipient !== next.recipient) throw new Error('Child directory pairing changed');
  if (old.revision > next.revision) return old;
  if (old.revision < next.revision) return next;
  if (JSON.stringify(old) === JSON.stringify(next)) return old;
  // Sticky at this revision, independent of arrival order. No names survive.
  return { ...old, issuedAt: Math.min(old.issuedAt, next.issuedAt), expiresAt: Math.min(old.expiresAt, next.expiresAt),
    conflicted: true, personas: old.personas.filter(p => next.personas.includes(p)), entries: [] };
}
export function childDirectoryVisible(view: ChildContactDirectory | null, now: number): boolean {
  return !!view && !view.conflicted && time(now) && now >= view.issuedAt - 300 && now < view.expiresAt;
}
export async function sealChildContactDirectory(view: ChildContactDirectory, endpoint: DecryptingSigningBackend): Promise<NostrEvent> {
  const parsed = parseChildContactDirectory(JSON.stringify(view));
  if (!parsed) throw new Error('Invalid child directory');
  const content = await endpoint.nip44Encrypt(parsed.recipient, JSON.stringify(parsed));
  return endpoint.signEvent({ kind: 30078, pubkey: endpoint.activePublicKeyHex, created_at: parsed.issuedAt,
    tags: [['d', CHILD_CONTACT_DIRECTORY_TAG]], content });
}
/** Only the transport key decrypts. Expected scope comes from the current pairing. */
export async function openChildContactDirectory(event: NostrEvent, options: {
  endpoint: string; guardian: string; recipient: string; availablePersonas: string[];
  backend: DecryptingSigningBackend; now: number; isCurrent: () => boolean;
}): Promise<ChildContactDirectory | null> {
  try {
    if (!options.isCurrent() || ![options.endpoint, options.guardian, options.recipient].every(k => typeof k === 'string' && HEX.test(k))
      || !keys(options.availablePersonas, 32) || !time(options.now) || options.backend.activePublicKeyHex !== options.recipient
      || event.pubkey !== options.endpoint || event.kind !== 30078 || !time(event.created_at)
      || event.created_at > options.now + 300 || event.created_at + TTL <= options.now
      || event.tags.length !== 1 || event.tags[0].length !== 2 || event.tags[0][0] !== 'd' || event.tags[0][1] !== CHILD_CONTACT_DIRECTORY_TAG
      || typeof event.content !== 'string' || event.content.length > 70_000
      || !verifyEvent({ id: event.id, pubkey: event.pubkey, kind: event.kind, created_at: event.created_at,
        content: event.content, sig: event.sig, tags: event.tags.map(t => [...t]) })) return null;
    const view = parseChildContactDirectory(await options.backend.nip44Decrypt(options.endpoint, event.content));
    if (!options.isCurrent() || !view || view.guardian !== options.guardian || view.recipient !== options.recipient
      || view.issuedAt !== event.created_at || view.expiresAt <= options.now
      || view.personas.some(p => !options.availablePersonas.includes(p))) return null;
    return view;
  } catch { return null; }
}
