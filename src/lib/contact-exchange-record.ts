import type { ContactOrigin } from './contact-origins';
import { contactExchangeKey } from './contact-exchange-key';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { contactVerificationWords } from '@forgesworn/signet-contacts';
import type { ContactExchangeState } from '@forgesworn/signet-contacts';
import { contactsMutationQueue } from './contacts-v2-queue';
import { applyOperations, validateOperation } from './contacts-v2-reducer';
import { resolveEffective } from './contacts-v2-effective';
import { buildOperation } from './contacts-v2-mutations';
import type { MutationActor } from './contacts-v2-mutations';
import { frontierOf } from './contacts-v2-clock';
import { listContactOperationsV2, saveContactOperationsV2 } from './db';
import type { ContactOperation } from '../types';
const id = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value))).slice(0, 32);
export async function contactPeerAllowed(directoryId: string, key: string, peer: string): Promise<boolean> {
  const records = applyOperations(await listContactOperationsV2(directoryId, key));
  return ![...records.values()].some(r => r.identities.some(i => i.pubkey === peer)
    && resolveEffective(r, { activeGuardianPubkeys: [], defaultChildCeiling: 'ken', directoryIsDependant: directoryId !== 'owner' }).blocked);
}
/** Semantic completion markers prevent replay after removal. Operation IDs hash
 * their full payload so concurrent devices never reuse an ID with different bytes. */
export function recordCompletedContactExchange(args: { directoryId: string; key: string; actor: MutationActor;
  exchange: ContactExchangeState & { wordsConfirmedAt?: number; origin?: ContactOrigin }; isCurrent(): boolean }): Promise<string> {
  return contactsMutationQueue.run(async () => {
    const { exchange: e } = args;
    if (e.phase !== 'complete' || !e.acceptance || !e.reveal) throw new Error('Contact exchange is incomplete');
    const own = e.role === 'requester' ? e.request.from : e.request.to;
    const peer = e.role === 'requester' ? e.request.to : e.request.from;
    contactVerificationWords(e.request, e.acceptance, e.reveal, own);
    const ops = await listContactOperationsV2(args.directoryId, args.key);
    const exchangeId = contactExchangeKey(e.request);
    const seed = `contact-exchange:${args.directoryId}:${exchangeId}`;
    const saved = ops.find(op => op.action === 'link-list' && (op.value as { contactExchangeId?: string }).contactExchangeId === exchangeId);
    const recordWords = async (contactId: string, current: ContactOperation[]) => {
      if (!e.wordsConfirmedAt || current.some(op => op.action === 'record-check' && (op.value as { exchangeId?: string }).exchangeId === exchangeId)) return;
      const contact = [...applyOperations(current).values()].find(record => record.contactId === contactId || record.mergedContactIds?.includes(contactId));
      if (!contact || contact.lifecycle === 'removed' || !contact.identities.some(identity => identity.pubkey === peer)) return;
      const check = { ...buildOperation({ directoryId: args.directoryId, contactId, action: 'record-check',
        value: { id: id(seed + ':words-record'), identityPubkey: peer, ownerIdentityPubkey: own, method: 'words', checkedAt: e.wordsConfirmedAt * 1000, exchangeId },
        clock: frontierOf(current).maxClock + 1, actor: args.actor, now: e.wordsConfirmedAt * 1000, operationId: id(seed + ':words-check') }), ownerIdentityPubkey: own };
      check.operationId = id(JSON.stringify(check));
      if (!args.isCurrent()) throw new Error('Contact exchange scope changed');
      await saveContactOperationsV2([check], args.key);
    };
    if (saved) { await recordWords(saved.contactId, ops); return saved.contactId; }
    const records = applyOperations(ops);
    const existing = [...records.values()].find(r => r.identities.some(i => i.pubkey === peer));
    if (existing && resolveEffective(existing, { activeGuardianPubkeys: [], defaultChildCeiling: 'ken', directoryIsDependant: args.directoryId !== 'owner' }).blocked) throw new Error('Contact is blocked');
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
      changes.push(make('add', { type: existing?.type ?? 'person', displayName: existing?.displayName ?? peer.slice(0, 12) + '…',
        tier: existing?.tier === 'kin' ? 'kin' : 'kith', ownerIdentityPubkey: own }, 'add'));
    } else if (existing.tier === 'ken') changes.push(make('set-tier', { tier: 'kith' }, 'tier'));
    if (!existing) changes.push(make('add-identity', { itemId: id(seed + ':identity'), pubkey: peer,
      provenance: 'direct', verification: 'unverified' }, 'identity'));
    changes.push(make('link-list', { ownerIdentityPubkey: own, contactExchangeId: exchangeId }, 'membership'));
    if (e.origin) changes.push(make('record-origin', e.origin, 'origin'));
    if (!changes.every(validateOperation) || !args.isCurrent()) throw new Error('Contact exchange scope changed');
    await saveContactOperationsV2(changes, args.key);
    await recordWords(contactId, [...ops, ...changes]);
    return contactId;
  });
}
