/**
 * The contact detail page's section model and input validators.
 *
 * Contact methods are private-vault data (spec section 7.8): every new method
 * is created `sharingPolicy: 'private'` and `verification: 'unverified'`.
 * Nothing here proves an endpoint; typing a phone number is not evidence.
 */
import type { AddMethodValue, ContactMethodKind, EffectiveContact } from '../types';
import type { ActorRights } from './contacts-v2-rights';
import {
  METHOD_EMAIL_INVALID_COPY, METHOD_VALUE_REQUIRED_COPY, METHOD_WEBSITE_INVALID_COPY,
} from './contacts-v2-copy';
import { sanitizeDisplayName, sanitizeNote } from './text-sanitize';

export type DetailSection =
  | 'identities' | 'methods' | 'roles' | 'tier' | 'note' | 'block' | 'remove'
  | 'legacy-verification' | 'legacy-ken';

export interface LegacyMatch {
  /** A legacy `contacts` row with an ECDH secret matches one of the identities. */
  hasSharedSecret: boolean;
  /** A legacy `ken` row matches one of the identities. */
  hasKenEntry: boolean;
}

export function detailSections(
  record: EffectiveContact,
  rights: ActorRights,
  legacy: LegacyMatch,
): DetailSection[] {
  const out: DetailSection[] = ['identities', 'methods'];
  if (rights.canEditRoles || record.roles.length > 0) out.push('roles');
  if (rights.canSetTier) out.push('tier');
  if (rights.canEditNote || record.notes) out.push('note');
  // Always present once a record is blocked, so the reason and the
  // "who applied it" line have somewhere to live even when the actor
  // may neither block nor unblock.
  if (rights.canBlock || rights.canUnblock || record.blocked) out.push('block');
  if (rights.canRemove) out.push('remove');
  if (legacy.hasSharedSecret) out.push('legacy-verification');
  if (legacy.hasKenEntry) out.push('legacy-ken');
  return out;
}

export const METHOD_KINDS: readonly ContactMethodKind[] =
  ['phone', 'email', 'website', 'postal-address', 'other'];

export const METHOD_KIND_LABELS: Record<ContactMethodKind, string> = {
  phone: 'Phone',
  email: 'Email',
  website: 'Website',
  'postal-address': 'Postal address',
  other: 'Other',
};

export const METHOD_LABEL_MAX = 40;
export const METHOD_VALUE_MAX = 200;
export const ROLE_MAX = 40;
export const ROLES_CAP = 12;
export const NOTE_MAX = 2000;
export const BLOCK_REASON_MAX = 200;

export interface MethodDraft {
  kind: ContactMethodKind;
  label: string;
  value: string;
}

export type MethodValidation =
  | { ok: true; value: Omit<AddMethodValue, 'itemId'> }
  | { ok: false; error: string };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateMethodDraft(draft: MethodDraft): MethodValidation {
  const value = sanitizeDisplayName(draft.value, METHOD_VALUE_MAX);
  if (!value) return { ok: false, error: METHOD_VALUE_REQUIRED_COPY };

  if (draft.kind === 'email' && !EMAIL_RE.test(value)) {
    return { ok: false, error: METHOD_EMAIL_INVALID_COPY };
  }
  if (draft.kind === 'website') {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return { ok: false, error: METHOD_WEBSITE_INVALID_COPY };
    }
    // P1: https-only, matching what the copy has always said — the old guard
    // silently accepted http:// too.
    if (parsed.protocol !== 'https:') {
      return { ok: false, error: METHOD_WEBSITE_INVALID_COPY };
    }
  }

  const label = sanitizeDisplayName(draft.label, METHOD_LABEL_MAX);
  return {
    ok: true,
    value: {
      kind: draft.kind,
      ...(label ? { label } : {}),
      value,
      verification: 'unverified',
      sharingPolicy: 'private',
    },
  };
}

export function normaliseRole(raw: string): string {
  return sanitizeDisplayName(raw, ROLE_MAX);
}

export function addRole(roles: string[], raw: string): string[] {
  const role = normaliseRole(raw);
  if (!role) return roles;
  if (roles.length >= ROLES_CAP) return roles;
  if (roles.some(r => r.toLowerCase() === role.toLowerCase())) return roles;
  return [...roles, role];
}

export function removeRole(roles: string[], role: string): string[] {
  const target = role.toLowerCase();
  return roles.filter(r => r.toLowerCase() !== target);
}

/**
 * A note is multi-line free text (spec §7.8's private owner/guardian note),
 * so it goes through `sanitizeNote` rather than `sanitizeDisplayName` — the
 * latter strips `\n`/`\t` and would silently glue a multi-line note into one
 * line.
 */
export function normaliseNote(raw: string): string {
  return sanitizeNote(raw, NOTE_MAX);
}

export function normaliseBlockReason(raw: string): string | undefined {
  const reason = sanitizeDisplayName(raw, BLOCK_REASON_MAX);
  return reason || undefined;
}
