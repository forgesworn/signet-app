// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePreferences, resolvePreferPersonaForSignIns } from './usePreferences';
import * as db from '../lib/db';

// Reset the in-memory fake-indexeddb state between tests so each test
// starts with a clean preferences store.
beforeEach(async () => {
  await db.purgeAllUserData();
});

describe('usePreferences — defaults', () => {
  it('returns system theme when nothing is saved', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.preferences.theme).toBe('system');
  });

  it('defaults security tier to basic', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.securityTier).toBe('basic');
  });

  it('defaults word count to 1 for basic tier', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.wordCount).toBe(1);
  });

  it('defaults power mode to false', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.powerMode).toBe(false);
  });

  it('defaults blossom consent to false', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.blossomConsent).toBe(false);
  });
});

describe('usePreferences — theme', () => {
  it('persists light theme and reads it back', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.setTheme('light'); });

    expect(result.current.preferences.theme).toBe('light');

    // Verify it round-trips through the DB
    const saved = await db.getPreferences();
    expect(saved.theme).toBe('light');
  });

  it('persists dark theme', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.setTheme('dark'); });

    expect(result.current.preferences.theme).toBe('dark');
  });

  it('reverts to system theme', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.setTheme('dark'); });
    await act(async () => { await result.current.setTheme('system'); });

    expect(result.current.preferences.theme).toBe('system');
  });
});

describe('usePreferences — relay URL', () => {
  it('persists relay URL and reads it back', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.setRelayUrl('wss://relay.example.com'); });

    expect(result.current.preferences.relayUrl).toBe('wss://relay.example.com');
    expect(result.current.preferences.relays).toEqual([
      { url: 'wss://relay.example.com', enabled: true, read: true, write: true },
    ]);

    const saved = await db.getPreferences();
    expect(saved.relayUrl).toBe('wss://relay.example.com');
    expect(saved.relays).toEqual([
      { url: 'wss://relay.example.com', enabled: true, read: true, write: true },
    ]);
  });

  it('does not validate relay URL — validation is in relay-service', async () => {
    // usePreferences stores whatever string is passed; validation is the
    // caller's responsibility (relay-service.setRelayUrl throws for bad URLs).
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.setRelayUrl('http://bad-url'); });

    expect(result.current.preferences.relayUrl).toBe('http://bad-url');
  });
});

describe('usePreferences — security tier', () => {
  it('persists standard tier', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.setSecurityTier('standard'); });

    expect(result.current.securityTier).toBe('standard');
    expect(result.current.wordCount).toBe(2);
  });

  it('persists expert tier', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.setSecurityTier('expert'); });

    expect(result.current.securityTier).toBe('expert');
    expect(result.current.wordCount).toBe(3);
  });

  it('writes tier to DB', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.setSecurityTier('standard'); });

    const saved = await db.getPreferences();
    expect(saved.securityTier).toBe('standard');
  });
});

describe('usePreferences — power mode', () => {
  it('enables power mode', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.setPowerMode(true); });

    expect(result.current.powerMode).toBe(true);
  });

  it('disables power mode', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.setPowerMode(true); });
    await act(async () => { await result.current.setPowerMode(false); });

    expect(result.current.powerMode).toBe(false);
  });
});

describe('usePreferences — loading from existing DB state', () => {
  it('reads previously saved preferences on mount', async () => {
    // Pre-populate the DB before the hook mounts
    await db.savePreferences({
      id: 'current',
      theme: 'dark',
      securityTier: 'expert',
      relayUrl: 'wss://pre-saved.example.com',
    });

    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.preferences.theme).toBe('dark');
    expect(result.current.securityTier).toBe('expert');
    expect(result.current.preferences.relayUrl).toBe('wss://pre-saved.example.com');
  });
});

describe('usePreferences — reloadPreferences', () => {
  // Several App.tsx flows (paired-child onboarding, Heartwood/NIP-07
  // connect, mode switches) write preferences directly via
  // `db.savePreferences` without going through this hook. Without
  // reloadPreferences, the hook's React state stays at whatever was
  // loaded at mount, so consumers like Carousel and persona-inventory
  // hooks read stale signingMode / activeAccountId. Discovered when
  // the kid's surface rendered the guardian "Create persona" AddCard
  // after fresh pair instead of the paired-child empty state.
  it('picks up direct db.savePreferences writes after manual reload', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Default: no signingMode
    expect(result.current.preferences.signingMode).toBeUndefined();

    // Simulate the handlePairChild path: direct IDB write bypassing the hook.
    await db.savePreferences({
      ...(await db.getPreferences()),
      activeAccountId: 'kid-pubkey-hex',
      signingMode: 'paired-child',
    });

    // Without reloadPreferences, React state is still stale.
    expect(result.current.preferences.signingMode).toBeUndefined();
    expect(result.current.preferences.activeAccountId).toBeUndefined();

    // reloadPreferences re-reads IDB and updates the state.
    await act(async () => { await result.current.reloadPreferences(); });

    expect(result.current.preferences.signingMode).toBe('paired-child');
    expect(result.current.preferences.activeAccountId).toBe('kid-pubkey-hex');
  });

  it('preserves other React-state fields after reload', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Set theme through the hook (so it's tracked in both React state and IDB)
    await act(async () => { await result.current.setTheme('dark'); });
    expect(result.current.preferences.theme).toBe('dark');

    // Direct IDB write adds a new field. bunkerUri carries a reusable NIP-46
    // reauth secret (M1) — writing it for real requires a key, matching
    // db.savePreferences's contract.
    const key = 'test-encryption-key-min-8';
    await db.savePreferences({
      ...(await db.getPreferences()),
      signingMode: 'bunker',
      bunkerUri: 'bunker://example',
    }, key);

    await act(async () => { await result.current.reloadPreferences(key); });

    // Both the hook-set field and the direct-set field are present
    expect(result.current.preferences.theme).toBe('dark');
    expect(result.current.preferences.signingMode).toBe('bunker');
    expect(result.current.preferences.bunkerUri).toBe('bunker://example');
  });
});

// M1 (2026-07-02 audit): AppPreferences.bunkerUri carries a reusable
// bunker://...&secret=... NIP-46 reauth secret and must never sit in
// cleartext at rest.
describe('usePreferences — bunkerUri encrypted at rest (M1)', () => {
  const KEY = 'test-encryption-key-min-8';

  it('reloadPreferences without a key never surfaces the plaintext secret', async () => {
    await db.savePreferences({ id: 'current', theme: 'system', bunkerUri: 'bunker://secret-endpoint?secret=abc' }, KEY);

    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Initial mount load has no key — must not expose the raw secret.
    expect(result.current.preferences.bunkerUri).not.toBe('bunker://secret-endpoint?secret=abc');

    await act(async () => { await result.current.reloadPreferences(); });
    expect(result.current.preferences.bunkerUri).not.toBe('bunker://secret-endpoint?secret=abc');
  });

  it('reloadPreferences with the correct key decrypts the secret', async () => {
    await db.savePreferences({ id: 'current', theme: 'system', bunkerUri: 'bunker://secret-endpoint?secret=abc' }, KEY);

    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.reloadPreferences(KEY); });
    expect(result.current.preferences.bunkerUri).toBe('bunker://secret-endpoint?secret=abc');
  });

  it('writing bunkerUri without a key never persists it in cleartext, even indirectly via a spread of decrypted state', async () => {
    // Seed an encrypted value, then simulate an unrelated hook setter
    // (e.g. setTheme) spreading the in-memory (decrypted) preferences
    // object through a savePreferences call with no key — the exact shape
    // of every setter in this hook.
    await db.savePreferences({ id: 'current', theme: 'system', bunkerUri: 'bunker://secret-endpoint?secret=abc' }, KEY);
    const decrypted = await db.getPreferences(KEY);
    expect(decrypted.bunkerUri).toBe('bunker://secret-endpoint?secret=abc');

    await db.savePreferences({ ...decrypted, theme: 'dark' }); // no key — matches setTheme's call shape

    // On-disk ciphertext must be unchanged/still decryptable — NOT
    // overwritten with the plaintext value that was spread through.
    const rereadDecrypted = await db.getPreferences(KEY);
    expect(rereadDecrypted.bunkerUri).toBe('bunker://secret-endpoint?secret=abc');
    expect(rereadDecrypted.theme).toBe('dark');

    const rereadRaw = await db.getPreferences(); // no key — raw on-disk shape
    expect(rereadRaw.bunkerUri).not.toBe('bunker://secret-endpoint?secret=abc');
  });
});

describe('usePreferences — initial load failure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops loading (does not hang) when the initial db read rejects', async () => {
    vi.spyOn(db, 'getPreferences').mockRejectedValueOnce(new Error('IDB unavailable'));

    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Falls back to the useState default rather than throwing an
    // unhandled rejection that leaves `loading` stuck true.
    expect(result.current.preferences).toEqual({ id: 'current', theme: 'system' });
  });
});

describe('preferPersonaForSignIns default', () => {
  it('defaults ON when the field is absent', () => {
    expect(resolvePreferPersonaForSignIns({ id: 'current', theme: 'system' } as never)).toBe(true);
  });

  it('honours an explicit false — the user turned it off', () => {
    expect(resolvePreferPersonaForSignIns({ id: 'current', theme: 'system', preferPersonaForSignIns: false } as never)).toBe(false);
  });

  it('honours an explicit true', () => {
    expect(resolvePreferPersonaForSignIns({ id: 'current', theme: 'system', preferPersonaForSignIns: true } as never)).toBe(true);
  });
});
