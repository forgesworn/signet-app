/**
 * The keyless "New contact" form, as a plan.
 *
 * Spec section 7.8: the address book permits a locally classified Kin, Kith or
 * Ken before they have a Nostr key. Such a contact cannot participate in
 * Kenspeckle verification, Nostr discovery or pubkey filtering, and the form
 * says so rather than letting the user assume otherwise.
 */
import type { AddContactValue, AddMethodValue, ContactTier, ContactType } from '../types';
import { validateMethodDraft } from './contacts-v2-detail';
import { NEW_CONTACT_NAME_REQUIRED_COPY } from './contacts-v2-copy';
import { sanitizeDisplayName } from './text-sanitize';

export interface NewContactDraft {
  displayName: string;
  type: ContactType;
  tier: ContactTier;
  phone: string;
  email: string;
}

export const EMPTY_NEW_CONTACT_DRAFT: NewContactDraft = {
  displayName: '', type: 'person', tier: 'ken', phone: '', email: '',
};

export type NewContactPlan =
  | { ok: true; contact: AddContactValue; methods: Omit<AddMethodValue, 'itemId'>[] }
  | { ok: false; error: string };

export function planNewContact(draft: NewContactDraft): NewContactPlan {
  const displayName = sanitizeDisplayName(draft.displayName, 100);
  if (!displayName) return { ok: false, error: NEW_CONTACT_NAME_REQUIRED_COPY };

  const methods: Omit<AddMethodValue, 'itemId'>[] = [];
  for (const [kind, raw] of [['phone', draft.phone], ['email', draft.email]] as const) {
    if (!raw.trim()) continue;
    const parsed = validateMethodDraft({ kind, label: '', value: raw });
    if (!parsed.ok) return { ok: false, error: parsed.error };
    methods.push(parsed.value);
  }

  return {
    ok: true,
    contact: { type: draft.type, displayName, tier: draft.tier, lifecycle: 'active' },
    methods,
  };
}
