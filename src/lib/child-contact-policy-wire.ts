import { verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'signet-protocol';
import type { ChildSettings, ContactRecord } from '../types';
import type { DecryptingSigningBackend } from './signing-backend';
import { contactInviteDecision, type ContactInviteDecision } from './contact-invite-policy';
import { portableChildContactSettings } from './child-contact-settings';

export const CHILD_CONTACT_POLICY_TAG = 'signet:child-contact-policy:v1';
const HEX = /^[0-9a-f]{64}$/;
const MAX_PEERS = 500;
const MAX_BYTES = 100_000;
const TTL = 15 * 60;
/** Advisory child-device view. The guardian signer always evaluates live policy.
 * No names, notes, contact evidence, owner lists, or dormant child NP key. */
export interface ChildContactPolicyView {
  v: 1;
  guardian: string;
  recipient: string;
  revision: number;
  expiresAt: number;
  policy: 'kin-only' | 'approved' | 'open';
  ceiling: 'none' | 'ken' | 'kith' | 'kin';
  conflicted: boolean;
  allowed: string[];
  blocked: string[];
}
const safeTime = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 253402300799;
function peers(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_PEERS || raw.some(key => typeof key !== 'string' || !HEX.test(key))) return null;
  return [...new Set(raw)].sort();
}
export function parseChildContactPolicy(raw: string): ChildContactPolicyView | null {
  if (new TextEncoder().encode(raw).length > MAX_BYTES) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || value.v !== 1 || typeof value.guardian !== 'string' || !HEX.test(value.guardian)
      || typeof value.recipient !== 'string' || !HEX.test(value.recipient)
      || !safeTime(value.revision) || !safeTime(value.expiresAt) || value.expiresAt <= value.revision || value.expiresAt - value.revision > TTL
      || !['kin-only', 'approved', 'open'].includes(value.policy) || !['none', 'ken', 'kith', 'kin'].includes(value.ceiling)
      || typeof value.conflicted !== 'boolean') return null;
    const allowed = peers(value.allowed), blocked = peers(value.blocked);
    if (!allowed || !blocked || allowed.length + blocked.length > MAX_PEERS || allowed.some(key => blocked.includes(key))) return null;
    return { v: 1, guardian: value.guardian, recipient: value.recipient, revision: value.revision,
      expiresAt: value.expiresAt, policy: value.policy, ceiling: value.ceiling, conflicted: value.conflicted, allowed, blocked };
  } catch { return null; }
}
/** Build only from the selected dependant directory. Oversize views fail closed;
 * callers must show unavailable, never publish a truncated block/allow list. */
export function projectChildContactPolicy(options: {
  child: string; guardian: string; recipient: string; settings?: ChildSettings; records: ContactRecord[]; now: number;
}): ChildContactPolicyView {
  const { child, guardian, recipient, now } = options;
  if (!HEX.test(child) || !HEX.test(guardian) || !HEX.test(recipient) || !safeTime(now)) throw new Error('Invalid family policy scope');
  const directoryId = `dependant:${child}`;
  if (options.records.some(record => record.directoryId !== directoryId)) throw new Error('Foreign contact directory');
  const settings = options.settings ? portableChildContactSettings(options.settings) : portableChildContactSettings({ childPubkey: child, guardianPubkey: guardian, contactPolicy: 'kin-only' });
  if (!settings || settings.childPubkey !== child || settings.guardianPubkey !== guardian) throw new Error('Foreign family policy');
  const candidates = new Set([...options.records.flatMap(record => record.identities.map(identity => identity.pubkey)), ...(settings.approvedContacts ?? [])]);
  if (candidates.size > MAX_PEERS) throw new Error('Family policy view too large');
  const allowed: string[] = [], blocked: string[] = [];
  for (const peer of candidates) {
    // Open policy isolates blocks independently of Kin/approval requirements.
    const context = { directoryId, settings, activeGuardianPubkeys: [guardian] };
    if (contactInviteDecision(peer, options.records, { ...context, settings: { ...settings, contactPolicy: 'open', contactPolicyConflicted: false } }) === 'deny') blocked.push(peer);
    else if (contactInviteDecision(peer, options.records, context) === 'allow') allowed.push(peer);
  }
  const view = parseChildContactPolicy(JSON.stringify({ v: 1, guardian, recipient, revision: now, expiresAt: now + TTL,
    policy: settings.contactPolicy, ceiling: settings.defaultChildCeiling, conflicted: !!settings.contactPolicyConflicted, allowed, blocked }));
  if (!view) throw new Error('Invalid family policy view');
  return view;
}
export function childContactPolicyDecision(view: ChildContactPolicyView | null, peer: string, now: number): ContactInviteDecision {
  if (!view || !HEX.test(peer) || !safeTime(now) || now < view.revision - 300 || now >= view.expiresAt || view.conflicted || view.blocked.includes(peer)) return 'deny';
  if (view.policy === 'open' || view.allowed.includes(peer)) return 'allow';
  return view.policy === 'approved' ? 'guardian-review' : 'deny';
}
export async function sealChildContactPolicy(view: ChildContactPolicyView, endpoint: DecryptingSigningBackend): Promise<NostrEvent> {
  const parsed = parseChildContactPolicy(JSON.stringify(view));
  if (!parsed) throw new Error('Invalid family policy view');
  const content = await endpoint.nip44Encrypt(parsed.recipient, JSON.stringify(parsed));
  return endpoint.signEvent({ kind: 30078, pubkey: endpoint.activePublicKeyHex, created_at: parsed.revision,
    tags: [['d', CHILD_CONTACT_POLICY_TAG]], content });
}
/** Pin the endpoint/guardian/recipient from the current pairing, independently
 * of relay filters. Verify signature before invoking any decryption backend. */
export async function openChildContactPolicy(event: NostrEvent, options: {
  endpoint: string; guardian: string; recipient: string; backend: DecryptingSigningBackend; now: number;
}): Promise<ChildContactPolicyView | null> {
  try {
    if (!event || !HEX.test(options.endpoint) || !HEX.test(options.guardian) || !HEX.test(options.recipient)
      || options.backend.activePublicKeyHex !== options.recipient || !safeTime(options.now)
      || event.pubkey !== options.endpoint || event.kind !== 30078 || !safeTime(event.created_at)
      || event.created_at > options.now + 300 || event.created_at + TTL <= options.now
      || event.tags.length !== 1 || event.tags[0].length !== 2 || event.tags[0][0] !== 'd' || event.tags[0][1] !== CHILD_CONTACT_POLICY_TAG
      || typeof event.content !== 'string' || event.content.length > 150_000 || !verifyEvent({ id: event.id, pubkey: event.pubkey, kind: event.kind, created_at: event.created_at, content: event.content, sig: event.sig, tags: event.tags.map(tag => [...tag]) })) return null;
    const view = parseChildContactPolicy(await options.backend.nip44Decrypt(options.endpoint, event.content));
    if (!view || view.guardian !== options.guardian || view.recipient !== options.recipient || view.revision !== event.created_at || view.expiresAt <= options.now) return null;
    return view;
  } catch { return null; }
}

/** Monotonic advisory cache. Equal-time disagreement pauses invitations instead
 * of letting relay ordering choose the more permissive policy. */
export function mergeChildContactPolicy(previous: ChildContactPolicyView | null, incoming: ChildContactPolicyView): ChildContactPolicyView {
  if (!previous) return incoming;
  if (previous.guardian !== incoming.guardian || previous.recipient !== incoming.recipient) throw new Error('Family policy pairing changed');
  if (previous.revision > incoming.revision) return previous;
  if (previous.revision < incoming.revision) return incoming;
  if (JSON.stringify(previous) === JSON.stringify(incoming)) return previous;
  const ceilings = ['none', 'ken', 'kith', 'kin'] as const;
  return { ...previous, policy: 'kin-only', conflicted: true,
    ceiling: ceilings[Math.min(ceilings.indexOf(previous.ceiling), ceilings.indexOf(incoming.ceiling))],
    expiresAt: Math.min(previous.expiresAt, incoming.expiresAt),
    allowed: previous.allowed.filter(peer => incoming.allowed.includes(peer)),
    blocked: [...new Set([...previous.blocked, ...incoming.blocked])].sort() };
}
