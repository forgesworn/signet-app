import { useState, useEffect, useCallback } from 'react';
import type { AppPreferences, SecurityTier, RelayConfig } from '../types';
import { primaryRelayUrl } from '../lib/relay-service';
import { TIER_WORD_COUNT } from '../types';
import * as db from '../lib/db';
import { DEFAULT_BLOSSOM_URL } from '../lib/blossom';

/**
 * Default-ON (spec §6, §11): the anonymous persona is the sign-in default
 * everywhere, so only an explicit `false` (the user turned it off in Security
 * settings) disables it. Exported so the default lives in exactly one place and
 * can be pinned by a test.
 */
export function resolvePreferPersonaForSignIns(prefs: AppPreferences): boolean {
  return prefs.preferPersonaForSignIns !== false;
}

export function usePreferences() {
  const [preferences, setPreferences] = useState<AppPreferences>({ id: 'current', theme: 'system' });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    db.getPreferences().then(async p => {
      // One-shot migration: convert literal-equals-default to fall-through.
      // Users who got pre-populated by an earlier default, or whose Venue Entry write
      // happened to match the current default move back to tracking the
      // default. Users who set a different URL keep their custom value.
      // After this, every read site resolves via `preferences.defaultBlossomUrl
      // ?? DEFAULT_BLOSSOM_URL`, so absent-field == "use the default and stay
      // tracking future rotations." Empty string ('') is preserved as the
      // user's deliberate-clear escape hatch (disables uploads).
      if (p.defaultBlossomUrl === DEFAULT_BLOSSOM_URL) {
        const { defaultBlossomUrl: _drop, ...rest } = p;
        void _drop;
        setPreferences(rest);
        setLoading(false);
        await db.savePreferences(rest);
        return;
      }
      setPreferences(p);
      setLoading(false);
    }).catch(() => {
      // IDB read failed, or the migration write above rejected mid-chain.
      // Fall back to the useState default ({ id: 'current', theme: 'system' })
      // already in state, and stop showing "loading" rather than hanging
      // forever — an unhandled rejection here previously left `loading`
      // stuck true.
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (preferences.theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', preferences.theme);
    }
  }, [preferences.theme]);

  const setTheme = useCallback(async (theme: 'system' | 'light' | 'dark') => {
    const updated = { ...preferences, theme };
    setPreferences(updated);
    await db.savePreferences(updated);
  }, [preferences]);

  const setSecurityTier = useCallback(async (tier: SecurityTier) => {
    const updated = { ...preferences, securityTier: tier };
    setPreferences(updated);
    await db.savePreferences(updated);
  }, [preferences]);

  const setRelayUrl = useCallback(async (url: string) => {
    const updated = {
      ...preferences,
      relayUrl: url,
      relays: [{ url, enabled: true, read: true, write: true }],
    };
    setPreferences(updated);
    await db.savePreferences(updated);
  }, [preferences]);

  // Clear the user's saved relay so the resolver falls back to
  // DEFAULT_RELAY_URL again — and stays tracking it across future
  // default rotations. Used by the "Restore to default" button.
  const resetRelayUrl = useCallback(async () => {
    const { relayUrl: _drop, ...rest } = preferences;
    void _drop;
    setPreferences(rest);
    await db.savePreferences(rest);
  }, [preferences]);

  // Replace the relay set and keep `relayUrl` in sync as the derived primary
  // so legacy single-URL consumers (pairing QRs, NIP-46 transport, the ~10
  // `preferences.relayUrl ?? DEFAULT_RELAY_URL` call sites) keep working.
  const setRelays = useCallback(async (relays: RelayConfig[]) => {
    const updated = { ...preferences, relays, relayUrl: primaryRelayUrl(relays) };
    setPreferences(updated);
    await db.savePreferences(updated);
  }, [preferences]);

  const setPowerMode = useCallback(async (enabled: boolean) => {
    const updated = { ...preferences, powerMode: enabled };
    setPreferences(updated);
    await db.savePreferences(updated);
  }, [preferences]);

  const setBlossomConsent = useCallback(async (consent: boolean) => {
    const updated = { ...preferences, blossomConsent: consent };
    setPreferences(updated);
    await db.savePreferences(updated);
  }, [preferences]);

  const setDefaultBlossomUrl = useCallback(async (url: string) => {
    // Reject schemes other than https or http://localhost. Mirrors the
    // AdvancedSettings UI gate — defence-in-depth so the setter itself
    // refuses to persist data: / javascript: / file: / plain http URLs.
    if (url !== '' && !/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(url)) {
      throw new Error('Blossom URL must use https:// (or http://localhost for dev)');
    }
    const updated = { ...preferences, defaultBlossomUrl: url };
    setPreferences(updated);
    await db.savePreferences(updated);
  }, [preferences]);

  // Clear the user's saved Blossom URL so the resolver falls back to
  // DEFAULT_BLOSSOM_URL — and stays tracking it across future default
  // rotations. Used by the "Restore to default" button.
  const resetDefaultBlossomUrl = useCallback(async () => {
    const { defaultBlossomUrl: _drop, ...rest } = preferences;
    void _drop;
    setPreferences(rest);
    await db.savePreferences(rest);
  }, [preferences]);

  const setBlurIdentityNames = useCallback(async (enabled: boolean) => {
    const updated = { ...preferences, blurIdentityNames: enabled };
    setPreferences(updated);
    await db.savePreferences(updated);
  }, [preferences]);

  const setRequireNpConfirmation = useCallback(async (enabled: boolean) => {
    const updated = { ...preferences, requireNpConfirmation: enabled };
    setPreferences(updated);
    await db.savePreferences(updated);
  }, [preferences]);

  const setBunkerServerEnabled = useCallback(async (enabled: boolean) => {
    const updated = { ...preferences, bunkerServerEnabled: enabled };
    setPreferences(updated);
    await db.savePreferences(updated);
  }, [preferences]);

  const setBackgroundBunkerEnabled = useCallback(async (enabled: boolean) => {
    const updated = { ...preferences, backgroundBunkerEnabled: enabled };
    setPreferences(updated);
    await db.savePreferences(updated);
  }, [preferences]);

  const setPreferPersonaForSignIns = useCallback(async (enabled: boolean) => {
    const updated = { ...preferences, preferPersonaForSignIns: enabled };
    setPreferences(updated);
    await db.savePreferences(updated);
  }, [preferences]);

  const setPreferredPersonaPubkey = useCallback(async (pubkey: string | undefined) => {
    const updated = { ...preferences, preferredPersonaPubkey: pubkey };
    setPreferences(updated);
    await db.savePreferences(updated);
  }, [preferences]);

  const snoozeBackupNudge = useCallback(async (untilMs: number) => {
    const updated = { ...preferences, backupNudgeSnoozedUntil: untilMs };
    setPreferences(updated);
    await db.savePreferences(updated);
  }, [preferences]);

  const setFallbackBunkerRelays = useCallback(async (relays: string[]) => {
    // Defence-in-depth: drop anything that doesn't pass the scheme check on
    // write. buildPairingURI will also reject, but silently filtering here
    // means a bad entry can't poison the whole preferences record.
    const valid = relays.filter(r => typeof r === 'string' && (/^wss:\/\//i.test(r) || /^ws:\/\/(localhost|127\.0\.0\.1)([:\/]|$)/i.test(r))).slice(0, 4);
    const updated = { ...preferences, fallbackBunkerRelays: valid };
    setPreferences(updated);
    await db.savePreferences(updated);
  }, [preferences]);

  // Re-read preferences from IDB and replace local state. For callers that
  // wrote prefs directly via `db.savePreferences` (paired-child onboarding,
  // Heartwood / NIP-07 connect, mode switches) — without this, the hook's
  // React state remains whatever was loaded at mount, so consumers like the
  // Carousel see e.g. signingMode=undefined even though IDB says
  // 'paired-child', and gated effects (persona-inventory consumer, auto-
  // unlock prompt, dormant carousel) silently no-op. Bug found on the kid's
  // surface after fresh pair: AddCard rendered the guardian "Create persona"
  // variant instead of the "Personas are managed for you" empty state
  // because `preferences.signingMode` was stale.
  // `encryptionKey`, when passed, decrypts AppPreferences.bunkerUri (M1) —
  // see db.getPreferences. Omit while locked; App.tsx calls this again
  // with the key once unlock completes.
  const reloadPreferences = useCallback(async (encryptionKey?: string) => {
    const fresh = await db.getPreferences(encryptionKey);
    setPreferences(fresh);
  }, []);

  const securityTier: SecurityTier = preferences.securityTier ?? 'basic';
  const wordCount = TIER_WORD_COUNT[securityTier];
  const powerMode = preferences.powerMode ?? false;
  const blossomConsent = preferences.blossomConsent ?? false;
  // Default-off: only an explicit true enables the blur (anti-shoulder-surf). Absent field = not blurred.
  const blurIdentityNames = preferences.blurIdentityNames === true;
  // Default-on: treat undefined as true. Users can turn it off, but new installs start protected.
  const requireNpConfirmation = preferences.requireNpConfirmation ?? true;
  const preferPersonaForSignIns = resolvePreferPersonaForSignIns(preferences);
  const preferredPersonaPubkey = preferences.preferredPersonaPubkey;
  const bunkerServerEnabled = preferences.bunkerServerEnabled ?? false;

  return { preferences, loading, setTheme, securityTier, wordCount, setSecurityTier, setRelayUrl, resetRelayUrl, setPowerMode, powerMode, blossomConsent, setBlossomConsent, setDefaultBlossomUrl, resetDefaultBlossomUrl, blurIdentityNames, setBlurIdentityNames, requireNpConfirmation, setRequireNpConfirmation, preferPersonaForSignIns, setPreferPersonaForSignIns, preferredPersonaPubkey, setPreferredPersonaPubkey, bunkerServerEnabled, setBunkerServerEnabled, setBackgroundBunkerEnabled, setFallbackBunkerRelays, setRelays, snoozeBackupNudge, reloadPreferences };
}
