import type { ContactCeilingTier } from './contacts-v2';

export interface ChildSettings {
  /** Child's pubkey — primary key */
  childPubkey: string;
  guardianPubkey: string;
  /**
   * Who may reach this dependant. `'kin-only'` is the renamed `'family-only'`
   * (§7.10): it admits effective Kin — close friends or family, not blood
   * status. Stored `'family-only'` rows read as `'kin-only'` via
   * `liftChildSettings`; nothing rewrites them in place.
   */
  contactPolicy: 'kin-only' | 'approved' | 'open';
  approvedContacts?: string[];
  /** Millisecond clock for portable guardian contact decisions. */
  updatedAt?: number;
  /** Equal-clock conflicting decisions deny access until explicitly resolved. */
  contactPolicyConflicted?: boolean;
  /**
   * Guardian ceiling applied to any contact in this dependant's directory that
   * the dependant added themselves and that no active guardian has vouched
   * for. Defaults to `'ken'` — the §7.10 answer to the self-classification
   * loop, and what stops the `family-only` → `kin-only` widening from
   * widening anything silently.
   */
  defaultChildCeiling?: ContactCeilingTier;
}

/** Verification security tier — controls word count in Signet Me */
export type SecurityTier = 'basic' | 'standard' | 'expert';

/** Maps tier names to word count per side */
export const TIER_WORD_COUNT: Record<SecurityTier, number> = {
  basic: 1,
  standard: 2,
  expert: 3,
};

/**
 * A single relay in the user's relay set (multi-relay manager, 2026-06-10).
 * `enabled` is the master on/off. `read`/`write` select fan-out participation:
 * publishes go to every enabled+write relay; reads query every enabled+read
 * relay (deduped). The "read-only" UI toggle flips `write` only — a relay is
 * never persisted with both read:false && write:false (use `enabled:false`).
 */
export interface RelayConfig {
  url: string;
  enabled: boolean;
  read: boolean;
  write: boolean;
}

export interface AppPreferences {
  id: string;
  theme: 'system' | 'light' | 'dark';
  /** Timestamp for portable settings only; device pairing state is never synced. */
  portableSettingsUpdatedAt?: number;
  activeAccountId?: string;
  /** Verification security tier (default: basic) */
  securityTier?: SecurityTier;
  /** User's configured relay URL for publishing credentials */
  relayUrl?: string;
  /**
   * Multi-relay set — source of truth for the relay pool. When present,
   * `relayUrl` is kept in sync as the derived primary (first enabled+write
   * relay). Absent until the user edits relays; the pool defaults to the
   * 6-relay set meanwhile.
   */
  relays?: RelayConfig[];
  /** Power mode toggle state — reveals advanced settings */
  powerMode?: boolean;
  /** User acknowledged Blossom photo upload terms */
  blossomConsent?: boolean;
  /** Preferred Blossom server URL */
  defaultBlossomUrl?: string;
  /** Signing mode: 'local' (default), 'bunker' (Heartwood NIP-46), or 'nip07' (browser extension) */
  signingMode?: 'local' | 'bunker' | 'nip07' | 'paired-child';
  /**
   * `bunker://...&secret=...` URI for Heartwood connection — carries a
   * reusable NIP-46 reauth secret. ENCRYPTED AT REST (M1, 2026-07-02
   * audit): `db.savePreferences` encrypts it whenever an encryption key
   * is supplied and refuses to persist a plaintext value otherwise;
   * `db.getPreferences(encryptionKey)` decrypts it back to a usable URI.
   * Without a key this field is an opaque value (ciphertext, or a legacy
   * pre-migration cleartext value) — never assume it's a usable URI
   * unless it was obtained via a keyed `getPreferences` call. See
   * `db.migrateCleartextBunkerUri` for the one-shot migration of
   * pre-existing cleartext values.
   */
  bunkerUri?: string;
  /**
   * Require an explicit confirmation before signing a Sign-in-with-Signet
   * request with the natural-person keypair. Defends against hostile
   * `accept=natural-person` hints pressuring real-name disclosure.
   * Defaults to true (undefined is treated as on).
   */
  requireNpConfirmation?: boolean;
  /**
   * When true, sign-in flows default-select the persona keypair when the
   * consumer did not send an `accept=` hint. Does NOT override explicit
   * consumer hints. **Default ON** — only an explicit `false` disables it.
   * Toggled via the Security settings screen.
   */
  preferPersonaForSignIns?: boolean;
  /**
   * Hex pubkey of the persona (built-in `persona` or an `extra-persona`)
   * the user chose as their preferred sign-in default. Only meaningful when
   * `preferPersonaForSignIns` is true. Undefined → fall back to the built-in
   * persona. A stale value (deleted persona) self-heals: the resolver falls
   * back to the built-in persona, then NP. Set via the Security settings
   * screen's persona picker.
   */
  preferredPersonaPubkey?: string;
  /**
   * When true, the app subscribes to its configured relay for inbound
   * NIP-46 requests (sign_event etc.) and offers an approval UI for
   * each one. Off by default — users who don't pair with external apps
   * (MatchPass, other NIP-46 clients, etc.) shouldn't pay the battery / network
   * cost of a persistent relay subscription.
   */
  bunkerServerEnabled?: boolean;
  /**
   * Native-only (Android APK shell): when true, the bunker keeps serving with
   * the screen off via the foreground service + partial wake lock, and the
   * app re-arms this on unlock. Ignored on web — `isNativeApp()` gates every
   * consumer, so a web build never acts on it. Survives restarts so the
   * always-on posture is sticky across app kills.
   */
  backgroundBunkerEnabled?: boolean;
  /** Blur identity names/avatars in the carousel until tapped to reveal.
   *  Default OFF (opt-in). Absent = off; only an explicit `true` blurs. */
  blurIdentityNames?: boolean;
  /**
   * Additional relays baked into dependant pairing QRs. The
   * primary `relayUrl` goes first; these fall in behind in order. If
   * the child's network blocks the primary, their BunkerSigner will try
   * each fallback until one connects. Max 4 fallbacks — combined with
   * the primary this keeps the URI under MAX_RELAYS in pairing-uri.ts.
   * All entries must pass the wss:// / ws://localhost scheme check
   * before being baked into a pairing URI.
   */
  fallbackBunkerRelays?: string[];
  /**
   * Ms epoch until which the home-ring backup nudge stays hidden. Set to
   * `Date.now() + BACKUP_NUDGE_SNOOZE_MS` when the user dismisses it. Absent
   * means never dismissed. Routing metadata, stored in clear like the rest of
   * this record.
   */
  backupNudgeSnoozedUntil?: number;
  /**
   * Per-device id for contacts v2 operation authorship (32 hex). Minted once
   * per install by `ensureContactsDeviceId`. Routing metadata, stored in clear
   * like the rest of this record — it identifies a device, never a key.
   */
  contactsDeviceId?: string;
}
