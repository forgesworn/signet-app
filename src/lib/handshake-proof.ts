import type { ContactInvite, ContactRequest } from '@forgesworn/signet-contacts';
import { parseContactInviteLink } from './contact-invite-link';
import { readSessionQR, type ScannedCode } from './handshake-reveal';

/** The invite a camera-bound proof speaks for: the peer's revealed invite,
 * once its binding verified under the session this camera read. */
export interface HandshakeQR { invite: ContactInvite }
/**
 * What the handshake camera read. A session code is the unlinkable handshake.
 * A plain SDK invite link (a contact card, another app) can only ever lead to
 * the one-way seam check. A code from an older build is refused: it would
 * show a persona key to anyone who photographs the screen.
 */
export type HandshakeCode = ScannedCode | { kind: 'invite'; invite: ContactInvite };
export function readHandshakeCode(raw: string, now: number): HandshakeCode | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  const session = readSessionQR(raw, now);
  if (session) return session;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && 'handshake' in value) return { kind: 'outdated' };
  } catch { /* Not JSON: a plain invite link may still be scanned for the one-way path. */ }
  const invite = parseContactInviteLink(raw, now);
  return invite ? { kind: 'invite', invite } : null;
}
export function handshakeRole(own: string, peer: string): 'requester' | 'recipient' | null {
  if (!/^[0-9a-f]{64}$/.test(own) || !/^[0-9a-f]{64}$/.test(peer) || own === peer) return null;
  return own < peer ? 'requester' : 'recipient';
}
/** Call only with an SDK-opened (signature verified, author-bound) request
 * received on this screen’s single-use invitation, and a `scanned` invite
 * whose reveal binding verified under the session this camera read. */
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
