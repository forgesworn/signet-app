/**
 * "Confirm it's them" — the pure decision and planning layer.
 *
 * Two axes stay apart. A contact's TIER is the real-world relationship and is
 * never gated on key proof; whether a KEY is really theirs lives on the
 * identity (`verification`) and in the contact's checks log. Confirming a key
 * only ever OFFERS a tier move.
 *
 * Nothing here adds a check method or an operation: every step compiles to an
 * existing contacts-v2 action (`record-check`, `update-identity`,
 * `add-identity`, `remove-item`, `set-tier`), so every build
 * and device already reads the result. Nothing touches a relay, and nothing
 * touches the user's Nostr follow list.
 *
 * `proven` = a one-sided proof that this is their key (you scanned it, or read
 * it out and it matched); `mutual` = both sides ran the My Signet exchange with
 * the words confirmed. That is what the reducer's rank (`unverified < proven <
 * mutual`) and the key-link path ("follows PROOF") already mean.
 */
import { nip19 } from 'nostr-tools';
import type {
  AddIdentityValue, ContactIdentity, ContactTier,
  EffectiveContact, UpdateIdentityValue,
} from '../types';
import type { ContactCheck } from './contact-checks';
import { routeQR } from './qr-router';
import { parseContactQR } from './contact-qr';
import { parsePubkeyInput } from './pubkey-input';
import { encodeNpub, isValidHexKey } from './signet';
import { hexToBytes } from '@noble/hashes/utils.js';
import { verificationUpgrade } from './contacts-v2-verification';

export { verificationRank, isConfirmed, isContactConfirmed, verificationUpgrade } from './contacts-v2-verification';

/** The newest recorded check for one key, or null. `owner` narrows to one identity list's own checks. */
export function newestCheckFor(
  record: Pick<EffectiveContact, 'checks'>,
  pubkey: string,
  owner?: string,
): ContactCheck | null {
  let best: ContactCheck | null = null;
  for (const c of record.checks ?? []) {
    if (c.identityPubkey !== pubkey) continue;
    if (owner && c.ownerIdentityPubkey !== owner) continue;
    if (!best || c.checkedAt > best.checkedAt) best = c;
  }
  return best;
}

/**
 * The last 16 characters of the npub as four groups of four, for reading out.
 * 16 bech32 characters is 80 bits: not practical to vanity-grind, unlike the
 * last 4-8 characters people usually compare.
 */
export function npubReadoutGroups(hex: string): string[] {
  const npub = encodeNpub(hexToBytes(hex.toLowerCase()));
  const tail = npub.slice(-16);
  return [tail.slice(0, 4), tail.slice(4, 8), tail.slice(8, 12), tail.slice(12, 16)];
}

/**
 * Turn whatever a scanner returned into a lowercase hex pubkey, reusing the
 * app's existing detection (`routeQR`) and decoding (`parsePubkeyInput`, the
 * contact-card parser, nostr-tools for `nprofile`). Accepts `npub`,
 * `nostr:npub`, `nprofile`, a My Signet card (contact JSON or invite link) and
 * bare hex. Returns null for anything else.
 */
export function scannedKeyToHex(data: string): string | null {
  let raw = data.trim();
  if (!raw || raw.length > 8192) return null;
  const card = parseContactQR(raw);
  if (card) return card.pubkey;
  raw = raw.replace(/^nostr:/i, '');
  const action = routeQR(raw);
  if (action.type === 'contact-invite') {
    const r = action.invite.recipient?.toLowerCase();
    return r && isValidHexKey(r) ? r : null;
  }
  if (action.type === 'contact') {
    if (/^nprofile1/i.test(action.npub)) {
      try {
        const d = nip19.decode(action.npub.toLowerCase());
        if (d.type === 'nprofile' && isValidHexKey(d.data.pubkey)) return d.data.pubkey.toLowerCase();
      } catch { /* not a profile */ }
      return null;
    }
    const parsed = parsePubkeyInput(action.npub);
    return 'hex' in parsed ? parsed.hex : null;
  }
  const parsed = parsePubkeyInput(raw);
  return 'hex' in parsed ? parsed.hex : null;
}

export type ScanDecision =
  | { kind: 'match' }
  | { kind: 'mismatch' }
  /** The scanned key already belongs to a DIFFERENT contact. Never merge silently. */
  | { kind: 'belongs-to-other'; contactId: string; displayName: string }
  /** The scanned key is another key already on THIS contact. */
  | { kind: 'other-key-of-this-contact'; itemId: string }
  | { kind: 'own-key' };

export function decideScan(args: {
  record: Pick<EffectiveContact, 'contactId' | 'identities'>;
  identity: Pick<ContactIdentity, 'itemId' | 'pubkey'>;
  scannedHex: string;
  /** Every visible contact in the same directory (the contact itself included). */
  contacts: Pick<EffectiveContact, 'contactId' | 'displayName' | 'identities' | 'lifecycle'>[];
  /** The user's own public keys. */
  ownPubkeys: string[];
}): ScanDecision {
  const scanned = args.scannedHex.toLowerCase();
  if (scanned === args.identity.pubkey.toLowerCase()) return { kind: 'match' };
  if (args.ownPubkeys.some(k => k.toLowerCase() === scanned)) return { kind: 'own-key' };
  const sibling = args.record.identities.find(i => i.pubkey.toLowerCase() === scanned);
  if (sibling) return { kind: 'other-key-of-this-contact', itemId: sibling.itemId };
  const owner = args.contacts.find(c => c.contactId !== args.record.contactId && c.lifecycle !== 'removed'
    && c.identities.some(i => i.pubkey.toLowerCase() === scanned));
  if (owner) return { kind: 'belongs-to-other', contactId: owner.contactId, displayName: owner.displayName };
  return { kind: 'mismatch' };
}

/** One write, in the order it must be applied. Each maps onto an existing contacts-v2 action. */
export type ConfirmStep =
  | { op: 'add-identity'; pubkey: string; verification: 'proven' }
  | { op: 'record-check'; pubkey: string; method: 'in-person' | 'words' }
  | { op: 'update-identity'; itemId: string; verification: 'proven' | 'mutual' }
  | { op: 'remove-item'; itemId: string }
  | { op: 'set-tier'; tier: ContactTier };

/** The scanned or read-out key is the key already on file: record the check, lift verification if it is lower. */
export function planMatch(args: {
  identity: Pick<ContactIdentity, 'itemId' | 'pubkey' | 'verification'>;
  method: 'in-person' | 'words';
}): ConfirmStep[] {
  const steps: ConfirmStep[] = [{ op: 'record-check', pubkey: args.identity.pubkey, method: args.method }];
  const next = verificationUpgrade(args.identity.verification, 'proven');
  if (next) steps.push({ op: 'update-identity', itemId: args.identity.itemId, verification: next });
  return steps;
}

/** Only a `ken` contact is asked about a move, and the question is about the contact's own tier (a guardian's cap is not theirs to answer). */
export function shouldOfferTierMove(record: Pick<EffectiveContact, 'tier'>): boolean {
  return record.tier === 'ken';
}

export function planTierMove(tier: 'kith' | 'kin'): ConfirmStep[] {
  return [{ op: 'set-tier', tier }];
}

export type MismatchChoice = 'use-new' | 'keep-both' | 'old-not-theirs' | 'cancel';

/**
 * The mismatch outcomes. `scannedHex` is null on the read-out path (nothing
 * was scanned), where only "the old key isn't theirs" is meaningful.
 */
export function planMismatch(args: {
  choice: MismatchChoice;
  old: Pick<ContactIdentity, 'itemId' | 'pubkey'>;
  scannedHex: string | null;
}): ConfirmStep[] {
  const { choice, old, scannedHex } = args;
  if (choice === 'cancel') return [];
  const addNew: ConfirmStep[] = scannedHex
    ? [
      { op: 'add-identity', pubkey: scannedHex.toLowerCase(), verification: 'proven' },
      { op: 'record-check', pubkey: scannedHex.toLowerCase(), method: 'in-person' },
    ]
    : [];
  if (choice === 'keep-both') return scannedHex ? addNew : [];
  if (choice === 'use-new') return scannedHex ? [...addNew, { op: 'remove-item', itemId: old.itemId }] : [];
  // old-not-theirs. There is deliberately no "also block the old key": the
  // reducer reads ANY active block as blocking the whole contact (scope is
  // not consulted). Once removed, the stray key no longer aliases this
  // contact, so the user can file it as a separate contact and block that.
  return [...addNew, { op: 'remove-item', itemId: old.itemId }];
}

/** The slice of `useContactsV2` the executor needs, so it can be driven without React. */
export interface ConfirmOps {
  addIdentity(contactId: string, v: Omit<AddIdentityValue, 'itemId'>): Promise<string>;
  recordCheck(contactId: string, check: Omit<ContactCheck, 'id' | 'ownerIdentityPubkey'>): Promise<void>;
  updateIdentity(contactId: string, v: UpdateIdentityValue): Promise<void>;
  removeItem(contactId: string, itemId: string): Promise<void>;
  setTier(contactId: string, tier: ContactTier): Promise<void>;
}

/** Apply steps in order, stopping at the first failure (the mutators throw). */
export async function applyConfirmSteps(
  steps: ConfirmStep[],
  contactId: string,
  ops: ConfirmOps,
  now: () => number = Date.now,
): Promise<void> {
  for (const step of steps) {
    switch (step.op) {
      case 'add-identity':
        await ops.addIdentity(contactId, { pubkey: step.pubkey, provenance: 'direct', verification: step.verification });
        break;
      case 'record-check':
        await ops.recordCheck(contactId, { identityPubkey: step.pubkey, method: step.method, checkedAt: now() });
        break;
      case 'update-identity':
        await ops.updateIdentity(contactId, { itemId: step.itemId, verification: step.verification });
        break;
      case 'remove-item':
        await ops.removeItem(contactId, step.itemId);
        break;
      case 'set-tier':
        await ops.setTier(contactId, step.tier);
        break;
    }
  }
}
