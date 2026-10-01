import { useState, useEffect, useCallback, useRef } from 'react';
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

  // Applied to the latest state AND a fresh IDB read, not a spread of the
  // `preferences` captured at render (see noteDependantAdded): the always-on
  // re-arm and a stay-awake window restored or armed at the same unlock write
  // within milliseconds of each other, and two spread-and-save setters back to
  // back lose one of the two fields.
  // Serialised, so two of these fired together each read the other's write.
  const applyFreshChainRef = useRef<Promise<void>>(Promise.resolve());
  const applyFresh = useCallback((apply: (p: AppPreferences) => AppPreferences): Promise<void> => {
    setPreferences(apply);
    const run = applyFreshChainRef.current.catch(() => {}).then(async () => {
      const stored = await db.getPreferences();
      const updated = apply(stored);
      if (updated !== stored) await db.savePreferences(updated);
    });
    applyFreshChainRef.current = run;
    return run;
  }, []);

  const setBackgroundBunkerEnabled = useCallback(async (enabled: boolean) => {
    await applyFresh(p => (p.backgroundBunkerEnabled === enabled ? p : { ...p, backgroundBunkerEnabled: enabled }));
  }, [applyFresh]);

  /**
   * Device-local wall-clock end (Date.now() ms) of the open stay-awake
   * window, or null to clear it. Read back on unlock so a window survives a
   * swipe-away, process death or reboot (src/lib/bunker-restore.ts).
   */
  const setStayAwakeEndsAt = useCallback(async (endsAt: number | null, opts?: { endedBy?: number }) => {
    await applyFresh(p => {
      if (endsAt === null) {
        if (p.stayAwakeEndsAt === undefined) return p;
        // Expiry clears only a window that has ended by then — never a later
        // one armed meanwhile. An explicit Stop passes no bound.
        if (opts?.endedBy !== undefined && p.stayAwakeEndsAt > opts.endedBy) return p;
        const next = { ...p };
        delete next.stayAwakeEndsAt;
        return next;
      }
      return p.stayAwakeEndsAt === endsAt ? p : { ...p, stayAwakeEndsAt: endsAt };
    });
  }, [applyFresh]);

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

  /**
   * Bookkeeping after a dependant is created: stamp the one-time role
   * confirm, and (while the words are not backed up) clear the nudge snooze
   * so the reminder reappears at once — holding someone else's keys makes the
   * identity worth losing whatever was dismissed before.
   *
   * ONE setter for both fields, on purpose. Every other setter here spreads
   * the `preferences` captured at render and `db.savePreferences` is a full
   * overwrite, so two setters called back-to-back would each write a record
   * missing the other's field, and the closure predates an `await
   * addDependant` that can take up to 120 s on a device derive. So the state
   * update is functional and the disk write is applied to a fresh read.
   */
  const noteDependantAdded = useCallback(async (opts: { clearSnooze: boolean }) => {
    const stamp = Date.now();
    const apply = (p: AppPreferences): AppPreferences => {
      const next = { ...p };
      let changed = false;
      if (!next.dependantRoleConfirmedAt) { next.dependantRoleConfirmedAt = stamp; changed = true; }
      if (opts.clearSnooze && next.backupNudgeSnoozedUntil !== undefined) { delete next.backupNudgeSnoozedUntil; changed = true; }
      return changed ? next : p;
    };
    setPreferences(apply);
    const stored = await db.getPreferences();
    const updated = apply(stored);
    if (updated !== stored) await db.savePreferences(updated);
  }, []);

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

  return { preferences, loading, setTheme, securityTier, wordCount, setSecurityTier, setRelayUrl, resetRelayUrl, setPowerMode, powerMode, blossomConsent, setBlossomConsent, setDefaultBlossomUrl, resetDefaultBlossomUrl, blurIdentityNames, setBlurIdentityNames, requireNpConfirmation, setRequireNpConfirmation, preferPersonaForSignIns, setPreferPersonaForSignIns, preferredPersonaPubkey, setPreferredPersonaPubkey, bunkerServerEnabled, setBunkerServerEnabled, setBackgroundBunkerEnabled, setStayAwakeEndsAt, setFallbackBunkerRelays, setRelays, snoozeBackupNudge, noteDependantAdded, reloadPreferences };
}
