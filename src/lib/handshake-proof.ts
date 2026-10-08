import { parseContactInvite } from '@forgesworn/signet-contacts';
import type { ContactInvite, ContactRequest } from '@forgesworn/signet-contacts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { parseContactInviteLink } from './contact-invite-link';

/** Optical envelope only. The enclosed invite and every relay message use SDK v1. */
export interface HandshakeQR { invite: ContactInvite; echo?: string }
export function inviteFingerprint(invite: ContactInvite): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([
    'signet:handshake:optical:v1', invite.recipient, invite.secret, invite.expiresAt,
  ]))));
}
export function handshakeQR(invite: ContactInvite, peer?: ContactInvite): string {
  return JSON.stringify({ handshake: 1, invite, ...(peer ? { echo: inviteFingerprint(peer) } : {}) });
}
export function readHandshakeQR(raw: string, now: number): HandshakeQR | null {
  if (raw.length > 8192) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && 'handshake' in value) {
      const v = value as { handshake: unknown; invite?: unknown; echo?: unknown; echoSeen?: unknown };
      const invite = parseContactInvite(JSON.stringify(v.invite), now);
      if (v.handshake !== 1 || !invite || invite.caption || invite.expiresAt === undefined
        || invite.expiresAt > now + 120 || (v.echo !== undefined && (typeof v.echo !== 'string' || !/^[0-9a-f]{64}$/.test(v.echo)))) return null;
      return { invite, ...(typeof v.echo === 'string' ? { echo: v.echo } : {}) };
    }
  } catch { /* A plain SDK invite or link may still be scanned for the one-way path. */ }
  const invite = parseContactInviteLink(raw, now);
  return invite ? { invite } : null;
}
export function handshakeRole(own: string, peer: string): 'requester' | 'recipient' | null {
  if (!/^[0-9a-f]{64}$/.test(own) || !/^[0-9a-f]{64}$/.test(peer) || own === peer) return null;
  return own < peer ? 'requester' : 'recipient';
}
/** Call only with an SDK-opened (signature verified, author-bound) request
 * received on this screen’s optical invitation, never a standing mailbox.
 * That signed request proves possession of our QR secret; our camera pins its author. */
export function mayAutoAcceptHandshake(args: {
  own: ContactInvite; scanned: HandshakeQR; request: ContactRequest; now: number; receivedOnOwnInvite: boolean;
}): boolean {
  const { own, scanned, request, now, receivedOnOwnInvite } = args;
  return Number.isSafeInteger(now) && own.expiresAt !== undefined && now < own.expiresAt
    && scanned.invite.expiresAt !== undefined && now < scanned.invite.expiresAt
    && handshakeRole(own.recipient, scanned.invite.recipient) === 'recipient'
    && receivedOnOwnInvite
    && request.from === scanned.invite.recipient && request.to === own.recipient
    && request.createdAt <= now && request.expiresAt > now;
}
export function validHandshakeScan(own: ContactInvite, scanned: HandshakeQR, now: number): boolean {
  return Number.isSafeInteger(now) && now >= 0 && !!handshakeRole(own.recipient, scanned.invite.recipient)
    && own.expiresAt !== undefined && scanned.invite.expiresAt !== undefined
    && now < own.expiresAt && now < scanned.invite.expiresAt;
}
