import { handshakeEvidence } from './handshake-sigil';
import type { HandshakeRecord } from './contact-invite-store';
import type { ContactOrigin } from './contact-origins';
import { contactExchangeKey } from './contact-exchange-key';
import { sanitizeDisplayName } from './text-sanitize';
import { shortNpub } from './nostr-follows';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { contactVerificationWords } from '@forgesworn/signet-contacts';
import type { ContactExchangeState } from '@forgesworn/signet-contacts';
import { contactsMutationQueue } from './contacts-v2-queue';
import { applyOperations, validateOperation, CAP_NAME } from './contacts-v2-reducer';
import { resolveEffective } from './contacts-v2-effective';
import { buildOperation } from './contacts-v2-mutations';
import type { MutationActor } from './contacts-v2-mutations';
import { frontierOf } from './contacts-v2-clock';
import { verificationUpgrade } from './contacts-v2-verification';
import { listContactOperationsV2Cached, saveContactOperationsV2, saveContactAvatar, getContactAvatar } from './db';
import { partnerCardOf } from './contact-card-share';
import type { ContactOperation } from '../types';
const id = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value))).slice(0, 32);
/** Checked against the current log on every call; the decrypt is reused only
 * while the stored rows are unchanged, so a new block applies at once. */
export async function contactPeerAllowed(directoryId: string, key: string, peer: string): Promise<boolean> {
  const records = applyOperations(await listContactOperationsV2Cached(directoryId, key));
  return ![...records.values()].some(r => r.identities.some(i => i.pubkey === peer)
    && resolveEffective(r, { activeGuardianPubkeys: [], defaultChildCeiling: 'ken', directoryIsDependant: directoryId !== 'owner' }).blocked);
}
/** `ContactAvatarRecord.addedAt` is ms for rows written here and seconds for a scanned QR key. */
const asMs = (t: number) => (t < 1e11 ? t * 1000 : t);

/**
 * The partner's shared photo, kept for display. The card's key goes into the
 * #242 recipient store for the partner persona, with its `{ server, hash }` as
 * the fallback for a sharer whose pointer our relays cannot find. Best-effort:
 * the contact exists either way, and a photo that cannot be stored is only a
 * missing picture. Returns the stored record's parts so the caller can seed the
 * pointer cache, or null when the partner shared no photo (or this exchange's
 * card is not newer than the key already stored).
 *
 * The row is stamped with the time of the card's own message, and an exchange
 * whose card is older than the stored row never replaces it (M4): a replayed
 * or restored old exchange must not undo a newer key the partner re-shared.
 *
 * Guardians acting in a dependant's directory send no card
 * (`contactCardInfoFor` is null for a dependant persona), but a card a
 * dependant-directory exchange RECEIVES lands in this device-wide store too
 * (M8, accepted: the key is the guardian's to hold).
 */
export async function recordPartnerCardPhoto(args: { exchange: ContactExchangeState; key: string }):
  Promise<{ peer: string; hash: string; server: string } | null> {
  const { exchange: e } = args;
  const photo = partnerCardOf(e)?.photo;
  if (!photo) return null;
  const peer = (e.role === 'requester' ? e.request.to : e.request.from).toLowerCase();
  // Seconds since epoch of the message that carried the partner's card.
  const cardAt = (e.role === 'requester' ? e.acceptance?.createdAt : e.request.createdAt) ?? e.request.createdAt;
  const at = cardAt * 1000;
  try {
    const stored = await getContactAvatar(peer, args.key);
    if (stored && asMs(stored.addedAt) >= at) return null;
    await saveContactAvatar({ pubkey: peer, shareKey: photo.key, addedAt: at,
      fallback: { server: photo.server, hash: photo.hash } }, args.key);
  } catch { return null; }
  return { peer, hash: photo.hash, server: photo.server };
}

/** Semantic completion markers prevent replay after removal. Operation IDs hash
 * their full payload so concurrent devices never reuse an ID with different bytes. */
export function recordCompletedContactExchange(args: { directoryId: string; key: string; actor: MutationActor;
  exchange: ContactExchangeState & { wordsConfirmedAt?: number; origin?: ContactOrigin; handshake?: HandshakeRecord }; isCurrent(): boolean }): Promise<string> {
  return contactsMutationQueue.run(async () => {
    const { exchange: e } = args;
    if (e.phase !== 'complete' || !e.acceptance || !e.reveal || (e.handshake && !e.handshake.strength)) throw new Error('Contact exchange is incomplete');
    const own = e.role === 'requester' ? e.request.from : e.request.to;
    const peer = e.role === 'requester' ? e.request.to : e.request.from;
    contactVerificationWords(e.request, e.acceptance, e.reveal, own);
    const ops = await listContactOperationsV2Cached(args.directoryId, args.key);
    const exchangeId = contactExchangeKey(e.request);
    const seed = `contact-exchange:${args.directoryId}:${exchangeId}`;
    const saved = ops.find(op => op.action === 'link-list' && (op.value as { contactExchangeId?: string }).contactExchangeId === exchangeId);
    const confirmationAt = e.handshake?.confirmedAt ?? e.wordsConfirmedAt;
    const confirmation = e.handshake?.strength ?? 'mutual';
    const recordWords = async (contactId: string, current: ContactOperation[]) => {
      if (!confirmationAt || current.some(op => op.action === 'record-check' && (op.value as { exchangeId?: string }).exchangeId === exchangeId)) return;
      const contact = [...applyOperations(current).values()].find(record => record.contactId === contactId || record.mergedContactIds?.includes(contactId));
      if (!contact || contact.lifecycle === 'removed' || !contact.identities.some(identity => identity.pubkey === peer)) return;
      const baseClock = frontierOf(current).maxClock + 1;
      const check = { ...buildOperation({ directoryId: args.directoryId, contactId, action: 'record-check',
        value: { id: id(seed + ':words-record'), identityPubkey: peer, ownerIdentityPubkey: own, method: e.handshake ? 'in-person' : 'words', checkedAt: confirmationAt * 1000, exchangeId,
          ...(e.handshake?.sigil ? { evidence: handshakeEvidence(confirmation, e.handshake.sigil) } : {}) },
        clock: baseClock, actor: args.actor, now: confirmationAt * 1000, operationId: id(seed + ':words-check') }), ownerIdentityPubkey: own };
      check.operationId = id(JSON.stringify(check));
      const batch: ContactOperation[] = [check];
      // Words confirmed on both sides is the ceremony `mutual` names: the
      // identity stops reading "Not verified". `update-identity` does not
      // rank-check, so never write it over an identity that is already mutual.
      // Without confirmed words (a pasted link may have travelled through the
      // very chat in question) nothing here touches verification.
      const peerIdentity = contact.identities.find(identity => identity.pubkey === peer)!;
      // A tap is one rung below a two-way camera read: the identity is proven.
      const verification = confirmation === 'mutual' ? 'mutual' : 'proven';
      if (verificationUpgrade(peerIdentity.verification, verification)) {
        const confirm = { ...buildOperation({ directoryId: args.directoryId, contactId, action: 'update-identity',
          value: { itemId: peerIdentity.itemId, verification }, clock: baseClock + 1, actor: args.actor,
          now: confirmationAt * 1000, operationId: id(seed + ':words-confirm') }), ownerIdentityPubkey: own };
        confirm.operationId = id(JSON.stringify(confirm));
        batch.push(confirm);
      }
      if (!batch.every(validateOperation) || !args.isCurrent()) throw new Error('Contact exchange scope changed');
      await saveContactOperationsV2(batch, args.key);
    };
    if (saved) { await recordWords(saved.contactId, ops); await recordPartnerCardPhoto({ exchange: e, key: args.key }); return saved.contactId; }
    const records = applyOperations(ops);
    const existing = [...records.values()].find(r => r.identities.some(i => i.pubkey === peer));
    if (existing && resolveEffective(existing, { activeGuardianPubkeys: [], defaultChildCeiling: 'ken', directoryIsDependant: args.directoryId !== 'owner' }).blocked) throw new Error('Contact is blocked');
    // The requester scanned an invite whose public caption is the inviter's own
    // name; the origin already carries it (validated, control/bidi-stripped).
    // Only for a link the user scanned or opened, never an app handover; and only
    // when it fits the reducer's UTF-16 cap, else the default name applies.
    const rawName = e.role === 'requester' && e.origin?.method === 'link' && e.origin.caption
      ? sanitizeDisplayName(e.origin.caption, CAP_NAME) : '';
    const scannedName = rawName && rawName.length <= CAP_NAME ? rawName : undefined;
    // Their self-declared card name (either side). Ranks above the invite
    // caption: existing contact name > card name > caption > short npub.
    const rawCardName = sanitizeDisplayName(partnerCardOf(e)?.name ?? '', CAP_NAME);
    const cardName = rawCardName && rawCardName.length <= CAP_NAME ? rawCardName : undefined;
    // The short key is the placeholder an exchange with no name writes, not a
    // name anyone chose, so it never outranks a card name or a caption — on a
    // removed contact coming back, or on a live one still showing it.
    const placeholder = shortNpub(peer.toLowerCase());
    const chosenName = existing?.displayName && existing.displayName !== placeholder ? existing.displayName : undefined;
    const displayName = chosenName ?? cardName ?? scannedName ?? placeholder;
    const contactId = existing?.contactId ?? id(seed + ':contact');
    let clock = frontierOf(ops).maxClock + 1;
    const now = e.reveal.createdAt * 1000;
    const make = (action: ContactOperation['action'], value: unknown, suffix: string): ContactOperation => {
      const op = { ...buildOperation({ directoryId: args.directoryId, contactId, action, value, clock: clock++, actor: args.actor,
        now, operationId: id(seed + ':' + suffix) }), ownerIdentityPubkey: own,
      };
      return { ...op, operationId: id(JSON.stringify(op)) };
    };
    const changes: ContactOperation[] = [];
    if (!existing || existing.lifecycle === 'removed') {
      changes.push(make('add', { type: existing?.type ?? 'person', displayName,
        tier: e.handshake ? existing?.tier ?? 'ken' : existing?.tier === 'kin' ? 'kin' : 'kith', ownerIdentityPubkey: own }, 'add'));
    } else {
      if (!e.handshake && existing.tier === 'ken') changes.push(make('set-tier', { tier: 'kith' }, 'tier'));
      if (displayName !== existing.displayName) changes.push(make('rename', { displayName }, 'rename'));
    }
    if (!existing) changes.push(make('add-identity', { itemId: id(seed + ':identity'), pubkey: peer,
      provenance: 'direct', verification: 'unverified' }, 'identity'));
    changes.push(make('link-list', { ownerIdentityPubkey: own, contactExchangeId: exchangeId }, 'membership'));
    if (e.origin) changes.push(make('record-origin', e.origin, 'origin'));
    if (!changes.every(validateOperation) || !args.isCurrent()) throw new Error('Contact exchange scope changed');
    await saveContactOperationsV2(changes, args.key);
    await recordWords(contactId, [...ops, ...changes]);
    await recordPartnerCardPhoto({ exchange: e, key: args.key });
    return contactId;
  });
}
