// MySignet App — Types (v2)
//
// Barrel: every type previously exported from `src/types.ts` is re-exported
// here so consumers can keep `import { X } from './types'` (or `'../types'`)
// unchanged. Per-domain files live alongside this barrel.

export * from './public-profile';
export * from './identity';
export * from './dependants';
export * from './credentials';
export * from './contacts';
export * from './contacts-v2';
export * from './contacts-grants-v2';
export * from './preferences';
export * from './paired-child';
export * from './grants';
export * from './auth-policy';
export * from './routing';
export * from './companion';

/**
 * Max companion-app data grants a Signet identity may hold at once.
 * Enforced by `db.saveCompanionGrant` for *new* appPubkeys — updating an
 * already-granted app is always allowed.
 */
export const COMPANION_GRANT_CAP = 5;
