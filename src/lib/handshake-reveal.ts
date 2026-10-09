import { parseContactInvite, type ContactInvite } from '@forgesworn/signet-contacts';
import { nip44 } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import { decodeBase45, encodeBase45 } from './handshake-optical';
import { isPrivateOrInternalHost } from './safe-url';

// The unlinkable handshake (design D11, §5a). The QR shows only a fresh
// session public key M, its relays and its expiry: never a persona key or a
// secret, so a photograph of both screens shows two random keys. Each phone
// then sends the other a sealed reveal: its unchanged SDK v1 single-use invite
// and a persona signature over (its own M, the M it scanned, and a proof of
// possession: a hash of the ECDH of its session secret and the scanned M).
// Only the two session holders can compute that ECDH, so knowing both public
// keys (from photos, a relay or Bluetooth) is not enough to forge a reveal.
// The reveal never states the sender's own M: only a phone that read the
// sender's screen can recompute the proof, and a proof made with my M shows
// the sender read mine. The SDK exchange then runs unchanged on the revealed
// invites, whose mailbox secrets never appear on a screen.

export const SESSION_QR_PREFIX = 'SGH2:';
const OUTDATED_PREFIX = 'SGH1:';
export const REVEAL_BINDING_KIND = 21238;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_RELAYS = 8, MAX_QR = 8192, SESSION_SECONDS = 120;

export interface HandshakeSession { secret: Uint8Array; publicKey: string }
export interface SessionCard { publicKey: string; expiresAt: number; relays: string[] }
export interface RevealBody { v: 2; to: string; invite: ContactInvite; binding: NostrEvent }

/** Fresh per handshake screen; the secret never leaves memory. */
export function createHandshakeSession(): HandshakeSession {
  const secret = generateSecretKey();
  return { secret, publicKey: getPublicKey(secret) };
}

export function sessionQR(card: SessionCard): string | null {
  if (!HEX64.test(card.publicKey) || !Number.isSafeInteger(card.expiresAt) || card.expiresAt < 0 || card.expiresAt > 0xffffffff
    || card.relays.length < 1 || card.relays.length > MAX_RELAYS || card.relays.some(url => !url.startsWith('wss://'))) return null;
  const relays = card.relays.map(url => new TextEncoder().encode(url.slice('wss://'.length)));
  if (relays.some(r => !r.length || r.length > 255)) return null;
  const bytes = new Uint8Array(38 + relays.reduce((n, r) => n + 1 + r.length, 0));
  const view = new DataView(bytes.buffer);
  bytes[0] = 2; bytes.set(hexToBytes(card.publicKey), 1); view.setUint32(33, card.expiresAt); bytes[37] = relays.length;
  let offset = 38;
  for (const r of relays) { bytes[offset] = r.length; bytes.set(r, offset + 1); offset += 1 + r.length; }
  const raw = SESSION_QR_PREFIX + encodeBase45(bytes);
  return raw.length <= MAX_QR ? raw : null;
}

export type ScannedCode =
  | { kind: 'session'; card: SessionCard }
  /** A handshake code from an older build: it carries a persona key, so it is refused. */
  | { kind: 'outdated' };

/** Only a live, short-lived session code; anything else is not a session. */
export function readSessionQR(raw: string, now: number): ScannedCode | null {
  if (typeof raw !== 'string' || raw.length > MAX_QR) return null;
  if (raw.startsWith(OUTDATED_PREFIX)) return { kind: 'outdated' };
  if (!raw.startsWith(SESSION_QR_PREFIX)) return null;
  const bytes = decodeBase45(raw.slice(SESSION_QR_PREFIX.length));
  if (!bytes || bytes.length < 38 || bytes[0] !== 2 || bytes[37] < 1 || bytes[37] > MAX_RELAYS) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expiresAt = view.getUint32(33);
  if (expiresAt <= now || expiresAt > now + SESSION_SECONDS) return null;
  const relays: string[] = [];
  let offset = 38;
  try {
    for (let i = 0; i < bytes[37]; i++) {
      const size = bytes[offset];
      if (!size || offset + 1 + size > bytes.length) return null;
      const host = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset + 1, offset + 1 + size));
      const url = new URL('wss://' + host);
      if (url.protocol !== 'wss:' || url.username || url.password) return null;
      // The reveal is published to these relays. A code that arrived without
      // being aimed at (a tap) must not steer that onto this phone's network.
      if (!isPrivateOrInternalHost(url.hostname)) relays.push('wss://' + host);
      offset += 1 + size;
    }
  } catch { return null; }
  if (offset !== bytes.length || !relays.length) return null;
  const publicKey = bytesToHex(bytes.subarray(1, 33));
  return { kind: 'session', card: { publicKey, expiresAt, relays } };
}

/** Proof of possession: only the holder of one session's secret and the
 * other's public key (or the reverse) can compute it. Never leaves the phone
 * except hashed inside a sealed reveal. */
export function revealProof(ownSecret: Uint8Array, peerSession: string): string {
  if (!HEX64.test(peerSession)) throw new Error('Invalid handshake session');
  const shared = nip44.v2.utils.getConversationKey(ownSecret, peerSession);
  try {
    const tag = new TextEncoder().encode('signet:handshake:reveal:pop:v2');
    const input = new Uint8Array(tag.length + shared.length);
    input.set(tag); input.set(shared, tag.length);
    try { return bytesToHex(sha256(input)); } finally { input.fill(0); }
  } finally { shared.fill(0); }
}
/** The invite fields exactly as the receiver will parse them. */
function canonicalInvite(invite: ContactInvite): ContactInvite {
  const parsed = parseContactInvite(JSON.stringify(invite));
  if (!parsed) throw new Error('Invalid invite');
  return parsed;
}
/** What the persona signs: both session keys, the proof and the invite. */
export function revealDigest(senderSession: string, receiverSession: string, proof: string, invite: ContactInvite): string {
  const i = canonicalInvite(invite);
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([
    'signet:handshake:reveal:v2', senderSession, receiverSession, proof,
    i.recipient, i.secret, i.expiresAt ?? null, i.relays,
  ]))));
}

/** The unsigned binding the persona signs (through any signer, a bunker included). */
export function bindingTemplate(sender: HandshakeSession, receiverSession: string, invite: ContactInvite, now: number) {
  const proof = revealProof(sender.secret, receiverSession);
  return { kind: REVEAL_BINDING_KIND, created_at: now, tags: [] as string[][], content: revealDigest(sender.publicKey, receiverSession, proof, invite) };
}

/** Sealed with a throwaway key to the receiver's session: only the holder of
 * the receiver's session secret can read it, and it names no sender. */
export function sealReveal(body: RevealBody, receiverSession: string, now: number): NostrEvent {
  const throwaway = generateSecretKey();
  try {
    const key = nip44.v2.utils.getConversationKey(throwaway, receiverSession);
    const content = nip44.v2.encrypt(JSON.stringify(body), key);
    key.fill(0);
    return finalizeEvent({ kind: 1059, created_at: now, tags: [['p', receiverSession]], content }, throwaway) as NostrEvent;
  } finally { throwaway.fill(0); }
}

const cleanEvent = (e: NostrEvent): NostrEvent => ({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind,
  tags: e.tags, content: e.content, sig: e.sig });

function isBinding(v: unknown): v is NostrEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return e.kind === REVEAL_BINDING_KIND && typeof e.id === 'string' && HEX64.test(e.id) && typeof e.pubkey === 'string' && HEX64.test(e.pubkey)
    && typeof e.sig === 'string' && /^[0-9a-f]{128}$/.test(e.sig) && Number.isSafeInteger(e.created_at) && Array.isArray(e.tags)
    && e.tags.length === 0 && typeof e.content === 'string' && HEX64.test(e.content);
}

/** Opens a reveal addressed to this session. The binding is NOT yet checked:
 * that needs the sender's session key, which only the camera can supply. */
export function openReveal(event: NostrEvent, session: HandshakeSession, now: number): RevealBody | null {
  try {
    const e = cleanEvent(event);
    if (e.kind !== 1059 || e.tags.length !== 1 || e.tags[0]?.[0] !== 'p' || e.tags[0][1] !== session.publicKey
      || typeof e.content !== 'string' || e.content.length > 16000 || !verifyEvent(e)) return null;
    const key = nip44.v2.utils.getConversationKey(session.secret, e.pubkey);
    let plain: string;
    try { plain = nip44.v2.decrypt(e.content, key); } finally { key.fill(0); }
    const value: unknown = JSON.parse(plain);
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    if (v.v !== 2 || v.to !== session.publicKey || !isBinding(v.binding)) return null;
    const invite = parseContactInvite(JSON.stringify(v.invite), now);
    if (!invite || invite.caption !== undefined || invite.expiresAt === undefined || invite.expiresAt <= now
      || invite.expiresAt > now + SESSION_SECONDS || v.binding.pubkey !== invite.recipient) return null;
    return { v: 2, to: session.publicKey, invite, binding: v.binding };
  } catch { return null; }
}

/** True when the persona named in the reveal signed THIS pair: the sender's
 * session as this phone's camera read it, this phone's own session, and the
 * proof only the holder of the sender's session secret could compute. */
export function verifyRevealBinding(body: RevealBody, cameraSenderSession: string, own: HandshakeSession): boolean {
  if (!HEX64.test(cameraSenderSession) || !HEX64.test(own.publicKey) || cameraSenderSession === own.publicKey) return false;
  let digest: string;
  try { digest = revealDigest(cameraSenderSession, own.publicKey, revealProof(own.secret, cameraSenderSession), body.invite); } catch { return false; }
  const b = cleanEvent(body.binding);
  return b.kind === REVEAL_BINDING_KIND && b.pubkey === body.invite.recipient && b.tags.length === 0
    && b.content === digest && verifyEvent(b);
}

/**
 * The only route to `mutual`. This phone read the peer's session from the
 * peer's screen (`readAt`, inside this screen's session); the peer's reveal is
 * signed by the SDK counterparty over that session and this phone's own, which
 * the peer could only know by reading this screen.
 */
export function mutualRevealProof(args: {
  ownSession: HandshakeSession; cameraPeerSession: string; peerReveal: RevealBody; counterparty: string;
  readAt: number; sessionStart: number; sessionExpiresAt: number; peerExpiresAt: number;
}): boolean {
  const { ownSession, cameraPeerSession, peerReveal, counterparty, readAt, sessionStart, sessionExpiresAt, peerExpiresAt } = args;
  return Number.isSafeInteger(readAt) && readAt >= sessionStart && readAt < sessionExpiresAt && readAt < peerExpiresAt
    && peerReveal.invite.recipient === counterparty
    && verifyRevealBinding(peerReveal, cameraPeerSession, ownSession);
}

/** Who dials over Bluetooth: the lower session key, so exactly one phone does. */
export function sessionDialler(own: string, peer: string): boolean { return HEX64.test(own) && HEX64.test(peer) && own < peer; }
