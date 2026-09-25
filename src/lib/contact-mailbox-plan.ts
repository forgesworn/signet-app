import { contactExchangeKey } from './contact-exchange-key';
import { conflictedContactExchanges, type ContactInviteVault } from './contact-invite-store';
export interface ContactMailboxBinding {
  id: string; secret: string; relays: string[]; channel: 'invite' | 'exchange';
}
/** Recovered devices may exceed local admission limits. Rotate the excess without
 * deleting invitations or joining different identities on a shared connection. */
export function contactMailboxPlan(state: ContactInviteVault, identity: string, now: number) {
  const conflicts = conflictedContactExchanges(state);
  const candidates: ContactMailboxBinding[] = [
    ...state.invites.filter(i => i.identityPubkey === identity && i.enabled
      && (i.invite.expiresAt === undefined || i.invite.expiresAt > now)
      && (i.mode !== 'single-use' || !state.arrivals.some(a => a.inviteId === i.id)))
      .map(i => ({ id: i.id, secret: i.invite.secret, relays: i.invite.relays, channel: 'invite' as const })),
    ...state.exchanges.filter(e => (e.role === 'requester' ? e.request.from : e.request.to) === identity
      && !conflicts.has(contactExchangeKey(e.request)) && e.phase !== 'complete' && e.phase !== 'declined' && e.request.expiresAt > now)
      .map(e => ({ id: contactExchangeKey(e.request), ...e.request.reply, channel: 'exchange' as const })),
  ].sort((a, b) => a.id.localeCompare(b.id) || a.channel.localeCompare(b.channel));
  const start = candidates.length ? Math.floor(now / 60) % candidates.length : 0;
  const ordered = [...candidates.slice(start), ...candidates.slice(0, start)];
  const relays = new Set<string>(), counts = { invite: 0, exchange: 0 };
  const bindings: ContactMailboxBinding[] = [];
  for (const candidate of ordered) {
    if (counts[candidate.channel] >= (candidate.channel === 'invite' ? 16 : 32)) continue;
    const addresses = [...new Set(candidate.relays.map(url => new URL(url).href))];
    if (new Set([...relays, ...addresses]).size > 16) continue;
    addresses.forEach(url => relays.add(url));
    counts[candidate.channel]++;
    bindings.push({ ...candidate, relays: addresses });
  }
  return { bindings, deferred: candidates.length - bindings.length };
}
