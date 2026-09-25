/**
 * Which sync rails have lost a backup, in the order the banner names them.
 *
 * Extracted from App.tsx so the per-rail gating is testable without rendering
 * the app. The gates are unchanged from the shipped banner: personas,
 * dependants and grants only count when there is something local to lose;
 * contacts and credentials have no accurate count at the call site, so they
 * are ungated EXCEPT on a paired-child install, where an empty owner rail is
 * normal rather than a lost backup. Only `'missing-after-seen'` ever counts —
 * neither `'unreachable'` nor `'never-seen'` is evidence of a lost backup, and
 * neither is a checkpoint that exists but could not be read (the rail hook
 * reports that as `'present'`, ruling R9).
 *
 * Contacts now has two rails (legacy read-only + v2). They share ONE banner
 * entry: the user has one contacts backup as far as they are concerned, and
 * naming it twice would read as two separate faults.
 */

import type { SyncRemoteState } from './sync-seen';

export interface MissingBackupInput {
  personas: SyncRemoteState | null;
  dependants: SyncRemoteState | null;
  contacts: SyncRemoteState | null;
  contactsV2: SyncRemoteState | null;
  credentials: SyncRemoteState | null;
  grants: SyncRemoteState | null;
  extraPersonaCount: number;
  dependantCount: number;
  grantCount: number;
  isPairedChild: boolean;
}

const gone = (state: SyncRemoteState | null): boolean => state === 'missing-after-seen';

export function missingBackupRailsFor(input: MissingBackupInput): string[] {
  const rails: string[] = [];
  if (gone(input.personas) && input.extraPersonaCount > 0) rails.push('persona');
  if (gone(input.dependants) && input.dependantCount > 0) rails.push('dependant');
  if ((gone(input.contacts) || gone(input.contactsV2)) && !input.isPairedChild) rails.push('contact');
  if (gone(input.credentials) && !input.isPairedChild) rails.push('credential');
  if (gone(input.grants) && input.grantCount > 0) rails.push('grant');
  return rails;
}
