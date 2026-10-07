/**
 * "Your name and photo in contact requests" (design 2026-10-07 §1).
 *
 * The card rides inside the request and accept messages, which are already
 * end-to-end encrypted between two personas; it is never in the QR. Pure
 * helpers only: the upload and publish that make a photo shareable are
 * injected (`sharePhoto`) so they run on Send/Accept and never on a tick.
 */
import { parseContactCard } from '@forgesworn/signet-contacts';
import type { ContactCard, ContactExchangeState } from '@forgesworn/signet-contacts';
import type { SignetIdentity } from '../types';
import { sanitizeDisplayName } from './text-sanitize';

/** What the sender has ticked under "They'll see:". */
export interface ContactCardChoice { name: boolean; photo: boolean }

/** What a persona can offer: its name, and whether it has an in-app (private) picture. */
export interface ContactCardInfo { name: string; hasPhoto: boolean }

/** The share copy could not be made ready, so nothing was sent. */
export class ContactCardPhotoError extends Error {
  constructor(message = 'photo-share-failed') { super(message); this.name = 'ContactCardPhotoError'; }
}

/** The default choice shown before any tick: name on when there is one, photo off. */
export function defaultCardChoice(info: ContactCardInfo): ContactCardChoice {
  return { name: info.name.length > 0, photo: false };
}

/**
 * What the chips offer for `persona`, or null for no chips at all. Null on a
 * paired-child install (kid-side photo publishing is suppressed) and for any
 * pubkey that is not one of the signed-in owner's own slots (a dependant's
 * directory is never described by the guardian's card).
 */
export function contactCardInfoFor(identity: SignetIdentity | null, persona: string, opts: { pairedChild: boolean }): ContactCardInfo | null {
  if (opts.pairedChild || !identity || !persona) return null;
  const want = persona.toLowerCase();
  const slots = [identity.persona, ...(identity.extraPersonas ?? []), identity.naturalPerson];
  const slot = slots.find(s => s?.publicKey?.toLowerCase() === want);
  if (slot) {
    return { name: sanitizeDisplayName(slot.displayName ?? '', 100),
      hasPhoto: !!(slot.avatarHash && slot.avatarBlossomUrl && slot.avatarKey) };
  }
  // The Professional Persona has no in-app picture story.
  if (identity.professionalPersona?.publicKey?.toLowerCase() === want) {
    return { name: sanitizeDisplayName(identity.professionalPersona.displayName ?? '', 100), hasPhoto: false };
  }
  return null;
}

/**
 * Build the card for a Send or Accept press. `sharePhoto` is only called when
 * "Your photo" is on, and only here (never on a tick). If it rejects, or the
 * result is not a card the wire would carry, this throws `ContactCardPhotoError`
 * and the caller must send nothing.
 */
export async function buildContactCard(choice: ContactCardChoice, info: ContactCardInfo,
  sharePhoto: () => Promise<{ key: string; server: string; hash: string }>): Promise<ContactCard | undefined> {
  const draft: ContactCard = {};
  if (choice.name && info.name) draft.name = info.name;
  if (choice.photo) {
    if (!info.hasPhoto) throw new ContactCardPhotoError('no-in-app-picture');
    let photo: { key: string; server: string; hash: string };
    try { photo = await sharePhoto(); } catch { throw new ContactCardPhotoError(); }
    draft.photo = { key: photo.key, server: photo.server, hash: photo.hash };
  }
  if (!draft.name && !draft.photo) return undefined;
  // Validate the way the wire will, so a refused photo is an error here and not
  // a throw from the library create function after the share copy went up.
  const parsed = parseContactCard(draft);
  if (draft.photo && !parsed?.photo) throw new ContactCardPhotoError('photo-not-shareable');
  return parsed ?? undefined;
}

/** The OTHER side's card on a finished exchange: the acceptance's for a requester, the request's for a recipient. */
export function partnerCardOf(exchange: Pick<ContactExchangeState, 'role' | 'request' | 'acceptance'>): ContactCard | undefined {
  return (exchange.role === 'requester' ? exchange.acceptance?.card : exchange.request.card) ?? undefined;
}
