/**
 * Merge a partial `ChildSettings` update onto the record already on disk.
 *
 * `saveChildSettings` (`db.ts`) is a bare full-record `put` — whatever object
 * a caller passes it becomes the entire stored row. A handler that rebuilds
 * the record field-by-field (as the App.tsx contact-policy and default-child-
 * ceiling handlers used to) silently deletes any field it doesn't enumerate,
 * notably `approvedContacts`. This helper always starts from the existing
 * record (or the same defaults the old handlers used when there isn't one
 * yet) and only overwrites the fields the caller is actually changing.
 */
import { DEFAULT_CHILD_CEILING, type ChildSettings } from '../types';

export function mergeChildSettings(
  existing: ChildSettings | undefined,
  childPubkey: string,
  guardianPubkey: string,
  patch: Partial<Pick<ChildSettings, 'contactPolicy' | 'defaultChildCeiling'>>,
): ChildSettings {
  return {
    contactPolicy: 'kin-only',
    defaultChildCeiling: DEFAULT_CHILD_CEILING,
    ...existing,
    childPubkey,
    guardianPubkey,
    ...patch,
  };
}
