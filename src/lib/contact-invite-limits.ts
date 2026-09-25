import type { ContactInviteVault } from './contact-invite-store';
/** Local admission limits; encrypted histories retain their separate storage bounds. */
export function assertContactMailboxCapacity(state: ContactInviteVault, identity: string, now: number,
  relays: string[], kind: 'invite' | 'exchange'): void {
  const invites = state.invites.filter(i => i.identityPubkey === identity && i.enabled
    && (i.invite.expiresAt === undefined || i.invite.expiresAt > now)
    && !(i.mode === 'single-use' && state.arrivals.some(a => a.inviteId === i.id)));
  const exchanges = state.exchanges.filter(e => (e.role === 'requester' ? e.request.from : e.request.to) === identity
    && e.phase !== 'complete' && e.phase !== 'declined' && e.request.expiresAt > now);
  if (kind === 'invite' && invites.length >= 16) throw new Error('This identity has 16 active invites. Switch one off before creating another.');
  if (kind === 'exchange' && exchanges.length >= 32) throw new Error('This identity has 32 pending exchanges. Cancel an old request before adding another.');
  const connections = new Set([...relays, ...invites.flatMap(i => i.invite.relays), ...exchanges.flatMap(e => e.request.reply.relays)].map(url => new URL(url).href));
  if (connections.size > 16) throw new Error('This identity is already using too many relay addresses. Close an old invite or cancel a pending exchange first.');
}
