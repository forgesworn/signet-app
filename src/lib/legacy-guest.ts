/** Mirrors `getAuthMethod()`'s return type in auth.ts. */
type AuthMethod = 'biometric' | 'pin' | 'grace';

/**
 * Resolve the encryption key needed to migrate a legacy unprotected identity
 * onto a real lock (spec §9).
 *
 * Such an identity stays viewable WITHOUT its encryption key in React state —
 * the aggressive mobile hide/idle auto-lock nulls the key, and the identity
 * carried on regardless because it had no lock to re-enter. So when the key is
 * absent, recover it from the stored non-extractable handle with no user
 * prompt.
 *
 * THROWS rather than resolving null when the key is unrecoverable, so the
 * caller surfaces an error instead of silently doing nothing (the exact
 * regression that once froze the old securing screen on "Setting up…").
 */
export async function resolveLegacyGuestKey(
  encryptionKey: string | null,
  authMethod: AuthMethod | null,
  authenticateStoredKey: () => Promise<string | null>,
): Promise<string> {
  if (encryptionKey) return encryptionKey;
  const recovered = authMethod === 'grace' ? await authenticateStoredKey() : null;
  if (!recovered) throw new Error('Could not access this identity to secure it');
  return recovered;
}

/**
 * Is this install one of the retired no-lock identities (spec §9)?
 *
 * The stored auth method is the WHOLE answer. A 'grace' method means there is
 * no PIN and no biometric wrap to unlock with, so `AuthScreen` cannot let this
 * user in at all — the migration notice is the only door they have.
 *
 * The per-identity marker row is deliberately NOT required. It is optional
 * confirmation, and it can legitimately be gone while the method still reads
 * 'grace' (an interrupted migration clears the row before the new wrap lands),
 * which is exactly the state that used to fall through to an unusable unlock
 * screen. Requiring it would trade one dead end for another.
 *
 * The converse is not true: a leftover row on an install that already has a PIN
 * or biometric is not legacy — that user can unlock normally, and raising the
 * notice for them would be a false positive.
 */
export function isLegacyUnprotectedInstall(authMethod: AuthMethod | null): boolean {
  return authMethod === 'grace';
}

/** The legacy-migration screen this app is showing, or `null` for nobody. */
export type LegacyMigrationStep = 'notice' | 'setup' | null;

/**
 * Fold a detection-probe result (`isLegacyUnprotectedInstall`) into the
 * migration step (spec §9).
 *
 * The probe re-runs whenever the identity object changes — a sync-rail merge
 * or persona reconcile is enough — and `getAuthMethod()` still reads 'grace'
 * for the whole of the setup screen (the method only flips once the new wrap
 * lands). So the probe MUST NOT be able to knock an in-progress 'setup' back
 * to 'notice': that would discard the entered PIN mid-flow, and if it landed
 * mid-`endGraceWithPin` the wrap would complete (grace handle cleared) while
 * the completion handler never ran, leaving the marker row behind and the
 * notice returning above all routing with no key to retry from.
 *
 * Hence: an existing step always wins; the probe only ever decides the FIRST
 * transition, out of `null`.
 */
export function nextLegacyMigrationState(
  prev: LegacyMigrationStep,
  isLegacy: boolean,
): LegacyMigrationStep {
  if (prev !== null) return prev;
  return isLegacy ? 'notice' : null;
}
