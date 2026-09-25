import { appInviteTag, parseAppInviteRequest, APP_INVITE_REQUEST_CAPABILITY, APP_INVITE_RECEIVE_CAPABILITY,
  CONTACT_AUTO_ACCEPT_SECONDS, type AppInviteReply } from '@forgesworn/signet-contacts';
import { verifyEvent, type NostrEvent } from 'signet-protocol';
import { vaultContentHash } from 'signet-protocol/experimental';
import { getContactGrantV2 } from './db';
import { LocalSigningBackend } from './signing-backend';
import { publishToRelays } from './sync-relays';
import { sanitizeDisplayName } from './text-sanitize';
import type { ContactInviteService } from './contact-invite-service';

/** Every request is authenticated to a fresh grant before identity-key work.
 * Reply encryption uses the random grant rail; completion is never returned. */
export async function handleContactAppInvite(args: {
  grantId: string; event: NostrEvent; encryptionKey: string; service: ContactInviteService;
  identities: readonly string[]; relays: string[]; now: number; isCurrent(): boolean;
}): Promise<boolean> {
  const { event, now } = args;
  if (!args.isCurrent() || event.kind !== 30078 || event.content.length > 16384
    || event.created_at > now || event.created_at + 300 <= now
    || event.tags.filter(t => t[0] === 'd').length !== 1
    || !event.tags.some(t => t[0] === 'd' && t[1] === appInviteTag(args.grantId)) || !await verifyEvent(event)) return false;
  const grant = await getContactGrantV2(args.grantId, args.encryptionKey);
  if (!grant || grant.revokedAt || grant.directoryId !== 'owner' || !grant.ownerIdentityPubkey
    || !args.identities.includes(grant.ownerIdentityPubkey) || event.pubkey !== grant.appPubkey || !args.isCurrent()) return false;
  const rail = new LocalSigningBackend(grant.railPrivateKey);
  try {
    if (rail.activePublicKeyHex !== grant.railPubkey) return false;
    const request = parseAppInviteRequest(await rail.nip44Decrypt(grant.appPubkey, event.content), now);
    if (!request || request.grantId !== grant.grantId || request.createdAt !== event.created_at) return false;
    const capability = request.action === 'create-invite' ? APP_INVITE_REQUEST_CAPABILITY : APP_INVITE_RECEIVE_CAPABILITY;
    const currentGrant = async () => {
      const current = await getContactGrantV2(args.grantId, args.encryptionKey);
      return args.isCurrent() && current && !current.revokedAt && current.ownerIdentityPubkey === grant.ownerIdentityPubkey
        && current.directoryId === grant.directoryId && current.appPubkey === grant.appPubkey
        && current.railPubkey === grant.railPubkey && current.capabilities.some(cap => (cap as string) === capability) ? current : null;
    };
    const current = await currentGrant();
    if (!current) return false;
    const app = { grantId: grant.grantId, requestId: request.requestId, requestHash: vaultContentHash(JSON.stringify(request)),
      appName: sanitizeDisplayName(grant.appName, 100) || 'Connected app' };
    let reply: AppInviteReply;
    if (request.action === 'create-invite') {
      const stored = await args.service.issueAppInvite(grant.ownerIdentityPubkey, args.relays, request.mode!, now,
        { ...app, ...(request.mode === 'single-use' && current.autoAcceptInvites !== false
          ? { autoAcceptUntil: request.createdAt + CONTACT_AUTO_ACCEPT_SECONDS } : {}) });
      if (!stored.enabled) return false;
      reply = { v: 1, grantId: grant.grantId, requestId: request.requestId, createdAt: now, status: 'issued', invite: stored.invite };
    } else {
      await args.service.request(grant.ownerIdentityPubkey, request.invite!, now, app);
      reply = { v: 1, grantId: grant.grantId, requestId: request.requestId, createdAt: now, status: 'queued' };
    }
    if (!await currentGrant()) { await args.service.disableAppInvites(grant.grantId, now); return false; }
    const content = await rail.nip44Encrypt(grant.appPubkey, JSON.stringify(reply));
    const response = await rail.signEvent({ kind: 30078, pubkey: grant.railPubkey, created_at: now,
      tags: [['d', appInviteTag(grant.grantId, request.requestId)]], content });
    if (!await currentGrant()) return false;
    return publishToRelays(response, [grant.relay]);
  } finally { rail.destroy(); }
}
