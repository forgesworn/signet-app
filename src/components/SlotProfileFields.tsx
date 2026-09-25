/**
 * SlotProfileFields — inline editor for a single slot's kind-0 config.
 *
 * Phase 2 (persona-card-as-source-of-truth) UX surface. The persona card
 * itself hosts these editors inline — they are visible by default for every
 * slot kind. Publish / Disable / Switch primary / Backup-status / etc. all
 * move BEHIND a per-slot ⚙ Advanced page (built in T23+).
 *
 * Slot kinds & defaults:
 *   - natural-person / professional-persona / extras / all dep slots:
 *     ALL six fields (Picture, Banner, About, NIP-05, Lightning, Website)
 *     render inline.
 *   - persona (default Persona, the anonymous one):
 *     Picture / Banner / About visible inline. NIP-05 / Lightning / Website
 *     are HIDDEN behind a `▸ Show all fields` toggle (these fields are
 *     deanonymising for a privacy-first Persona, so we don't put them in
 *     the user's face).
 *
 * Save behaviour:
 *   1. onSaveConfig(localConfig) — writes the config slice (not state).
 *   2. If the slot is currently published and the parent wired onPublishNow,
 *      render a modal: "You're currently published — also push these changes
 *      to Nostr now?" Republish on confirm, else dismiss.
 *
 * This component does NOT call onPublish itself — the parent owns the
 * publish path. We only fire `onPublishNow` from the prompt's "Yes" branch.
 *
 * Paired-child surface (§6.6.11): when `pairedChildView === true`, all
 * inputs are disabled and a read-only banner explains the guardian set
 * this up.
 */

import { useState } from 'react';
import { NpubRow } from './NpubRow';
import type { PublicProfileConfig, PersonaPublicProfile } from '../types';
import { safeImageOrLinkUrl } from '../lib/public-profile-publish';
import { checkNip05, parseNip05, type Nip05CheckResult } from '../lib/nip05-check';
import { ImageRow } from './ImageRow';
import { Icon } from './Icon';

/** Small filled status dot used beside "On / Off / Pending" state text — a
 * simple geometric indicator rather than a coloured emoji circle. */
function StatusDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginRight: 6, verticalAlign: 1 }}
    />
  );
}

export type SlotKind =
  | 'natural-person'
  | 'persona'
  | 'professional-persona'
  | 'extra'
  | 'dep-natural-person'
  | 'dep-persona'
  | 'dep-extra';

export interface SlotProfileFieldsProps {
  /** The slot's own hex pubkey. Drives the npub copy row and the NIP-05 check. */
  pubkey: string;
  config: PublicProfileConfig;
  publishedState?: PersonaPublicProfile;
  slotKind: SlotKind;
  /** Shows "Imported — not in your seed phrase" badge above fields. Extras only. */
  imported?: boolean;
  /** Disables all inputs; renders §6.6.11 framing. Used on paired-child surface. */
  pairedChildView?: boolean;
  /** Blossom server URL for Upload buttons. From preferences.defaultBlossomUrl. */
  defaultBlossomUrl?: string;
  /** User consent for Blossom uploads. From preferences.blossomConsent. */
  blossomConsent?: boolean;

  /** Called when user taps Save. Component passes the form's full config snapshot. */
  onSaveConfig: (next: PublicProfileConfig) => Promise<void>;

  /** Called from the "Yes, republish" path of the §9 Q7 prompt. Optional —
   *  parent wires this only when slot is currently published. */
  onPublishNow?: () => Promise<void>;

  /** Uploads a file to Blossom and returns the resulting URL + sha256. */
  onUploadPicture?: (file: File, kind: 'picture' | 'banner') => Promise<{ url: string; sha256: string }>;

  /**
   * Persist a NIP-05 check result after the "Check" button runs `checkNip05`.
   * Optional — when the parent has no persistence path for this surface
   * (e.g. the paired-child read-only view), it leaves this undefined and
   * the Check button doesn't render at all.
   */
  onNip05Checked?: (result: Nip05CheckResult, checkedAt: number) => void;
}

// Validation regex shared by NIP-05 and lightning-address (LUD-16) inputs.
const NIP05_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/;

// Default-Persona variant hides the three deanonymising fields by default
// (per the brainstorm — anonymous personas shouldn't be nudged into hooking
// up a NIP-05 / Lightning address that ties them to their real-world identity).
function showAllFieldsByDefault(slotKind: SlotKind): boolean {
  return slotKind !== 'persona';
}

function truncateRelay(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url.length > 40 ? url.slice(0, 37) + '…' : url;
  }
}

function formatDate(unix: number | undefined): string {
  if (!unix) return '';
  try {
    return new Date(unix * 1000).toLocaleString();
  } catch {
    return '';
  }
}

function hostFromUrl(url: string): string {
  try { return new URL(url).hostname; } catch { return url.slice(0, 30); }
}

// Attacker-controlled strings get truncated before display (repo convention)
// — a NIP-05 domain reaches this component via config, which for a dep slot
// may have been typed by the guardian, not necessarily the current viewer.
const MAX_DOMAIN_DISPLAY = 64;
function truncateDomain(domain: string): string {
  return domain.length > MAX_DOMAIN_DISPLAY ? domain.slice(0, MAX_DOMAIN_DISPLAY) + '…' : domain;
}

function formatRelativeCheckedAt(checkedAtMs: number): string {
  const deltaSec = Math.max(0, Math.floor((Date.now() - checkedAtMs) / 1000));
  if (deltaSec < 60) return 'checked just now';
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `checked ${deltaMin} minute${deltaMin === 1 ? '' : 's'} ago`;
  const deltaHour = Math.floor(deltaMin / 60);
  if (deltaHour < 24) return `checked ${deltaHour} hour${deltaHour === 1 ? '' : 's'} ago`;
  const deltaDay = Math.floor(deltaHour / 24);
  return `checked ${deltaDay} day${deltaDay === 1 ? '' : 's'} ago`;
}

/** Pure-function helper — compare two configs after normalising blanks/undefineds. */
function configsEqual(a: PublicProfileConfig, b: PublicProfileConfig): boolean {
  return (
    (a.displayName ?? '') === (b.displayName ?? '') &&
    (a.about ?? '') === (b.about ?? '') &&
    (a.pictureUrl ?? '') === (b.pictureUrl ?? '') &&
    (a.pictureBlossomHash ?? '') === (b.pictureBlossomHash ?? '') &&
    (a.bannerUrl ?? '') === (b.bannerUrl ?? '') &&
    (a.bannerBlossomHash ?? '') === (b.bannerBlossomHash ?? '') &&
    (a.nip05 ?? '') === (b.nip05 ?? '') &&
    (a.lud16 ?? '') === (b.lud16 ?? '') &&
    (a.website ?? '') === (b.website ?? '')
  );
}

export function SlotProfileFields({
  pubkey,
  config,
  publishedState,
  slotKind,
  imported = false,
  pairedChildView = false,
  onSaveConfig,
  onPublishNow,
  onUploadPicture,
  onNip05Checked,
}: SlotProfileFieldsProps) {
  // Field state, seeded from `config`. Local form-only; parent owns canonical.
  const [about, setAbout] = useState(config.about ?? '');
  const [pictureUrl, setPictureUrl] = useState(config.pictureUrl ?? '');
  const [pictureBlossomHash, setPictureBlossomHash] = useState(config.pictureBlossomHash);
  const [bannerUrl, setBannerUrl] = useState(config.bannerUrl ?? '');
  const [bannerBlossomHash, setBannerBlossomHash] = useState(config.bannerBlossomHash);
  const [nip05, setNip05] = useState(config.nip05 ?? '');
  const [lud16, setLud16] = useState(config.lud16 ?? '');
  const [website, setWebsite] = useState(config.website ?? '');

  // Preview-gate state per §6.6.4 — pasted external URLs render only after
  // explicit click. Blossom-hosted images skip the gate.
  const [showPicturePreview, setShowPicturePreview] = useState(false);
  const [showBannerPreview, setShowBannerPreview] = useState(false);

  // Default-Persona collapse — when true, NIP-05 / Lightning / Website are
  // hidden behind a "Show all fields" toggle. Other slot kinds default to
  // showAll = true (no toggle visible).
  const [showAll, setShowAll] = useState(showAllFieldsByDefault(slotKind));

  // I/O state.
  const [uploadingPicture, setUploadingPicture] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Post-save republish prompt. Stashes the saved config so the parent's
  // onPublishNow path can read it if needed — we ALREADY called onSaveConfig
  // before showing this modal, so the parent's slot is up to date.
  const [republishPromptOpen, setRepublishPromptOpen] = useState(false);
  const [republishing, setRepublishing] = useState(false);

  // NIP-05 check — never auto-runs. Only the "Check" button tap below calls
  // checkNip05; no effect anywhere in this component fetches on mount, save,
  // or field change.
  const [checkingNip05, setCheckingNip05] = useState(false);
  // True when the last Check tap's checkNip05 call resolved fine but the
  // parent's persistence (onNip05Checked) rejected — e.g. no encryption key
  // because the app locked mid-check. Reset on the next Check tap.
  const [nip05SaveError, setNip05SaveError] = useState(false);

  // Validation. Live (not on-blur) for v1 — matches EditPublicProfile.tsx.
  const nip05Invalid = nip05.length > 0 && !NIP05_RE.test(nip05);
  const lud16Invalid = lud16.length > 0 && !NIP05_RE.test(lud16);
  const websiteInvalid = website.length > 0 && safeImageOrLinkUrl(website) === null;

  const isPictureSignetHosted = !!pictureBlossomHash;
  const isBannerSignetHosted = !!bannerBlossomHash;

  // Inputs disable when saving, when republishing, or in paired-child view.
  // Republishing is included so the form doesn't get edited mid-publish.
  const inputsDisabled = saving || republishing || pairedChildView;

  /** Build a candidate PublicProfileConfig from current form state. Mirrors
   *  EditPublicProfile.buildCandidateConfig — drops invalid-scheme URLs but
   *  preserves the user's typed string in the local form. */
  function buildCandidate(): PublicProfileConfig {
    const pictureForSave = pictureUrl && safeImageOrLinkUrl(pictureUrl) ? pictureUrl : undefined;
    const bannerForSave = bannerUrl && safeImageOrLinkUrl(bannerUrl) ? bannerUrl : undefined;
    return {
      // displayName is owned by the persona card's name input, not this
      // component (Phase 2 design §6.3) — we preserve the parent's value.
      displayName: config.displayName,
      about: about.trim() || undefined,
      pictureUrl: pictureForSave,
      pictureBlossomHash: pictureForSave === pictureUrl ? pictureBlossomHash : undefined,
      bannerUrl: bannerForSave,
      bannerBlossomHash: bannerForSave === bannerUrl ? bannerBlossomHash : undefined,
      nip05: nip05.trim() || undefined,
      lud16: lud16.trim() || undefined,
      website: website.trim() || undefined,
    };
  }

  const candidate = buildCandidate();
  const dirty = !configsEqual(candidate, config);

  // The NIP-05 check runs against the SAVED value (config.nip05), never the
  // live form field — so the stored result always refers to the identifier
  // that's actually persisted. "Dirty" here is scoped to the NIP-05 field
  // only (not the whole form) so editing an unrelated field (About, say)
  // doesn't block a check on an already-saved NIP-05.
  const nip05Dirty = nip05.trim() !== (config.nip05 ?? '');
  const nip05Empty = nip05.trim().length === 0;
  // NIP05_RE (the Save-time validator above) is intentionally looser than
  // parseNip05 (accepts `+` in the local part, doesn't reject IP-literal
  // domains, etc.) — a value can pass NIP05_RE and still fail parseNip05.
  // Gate the Check button on the STRICT parser too, or checkNip05 silently
  // no-fetches to 'unreachable' and the result line renders with an empty
  // domain.
  const savedNip05Parsed = config.nip05 ? parseNip05(config.nip05) : null;
  const nip05Unparseable = !nip05Empty && !nip05Dirty && !!config.nip05 && savedNip05Parsed === null;
  const nip05CheckDisabled =
    inputsDisabled || checkingNip05 || nip05Empty || nip05Invalid || nip05Dirty || nip05Unparseable;

  async function handleCheckNip05() {
    if (!onNip05Checked || !config.nip05) return;
    setCheckingNip05(true);
    setNip05SaveError(false);
    try {
      const result = await checkNip05(config.nip05, pubkey);
      // onNip05Checked is typed `=> void` but the real prop the parent
      // wires is async (persists to IDB) — await it so a rejection (e.g.
      // no encryption key because the app locked mid-check) is caught here instead
      // of becoming an unhandled rejection.
      await onNip05Checked(result, Date.now());
    } catch {
      // Never surface console output. The stored check state is left
      // exactly as it was — only the button's inline message changes.
      setNip05SaveError(true);
    } finally {
      setCheckingNip05(false);
    }
  }

  async function handleUpload(kind: 'picture' | 'banner', e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !onUploadPicture) return;
    if (kind === 'picture') setUploadingPicture(true);
    else setUploadingBanner(true);
    setError('');
    try {
      const { url, sha256 } = await onUploadPicture(file, kind);
      if (kind === 'picture') {
        setPictureUrl(url);
        setPictureBlossomHash(sha256);
        setShowPicturePreview(true);
      } else {
        setBannerUrl(url);
        setBannerBlossomHash(sha256);
        setShowBannerPreview(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      if (kind === 'picture') setUploadingPicture(false);
      else setUploadingBanner(false);
    }
  }

  function handlePastedPictureUrl(value: string) {
    setPictureUrl(value);
    setPictureBlossomHash(undefined);
    setShowPicturePreview(false);
  }
  function handlePastedBannerUrl(value: string) {
    setBannerUrl(value);
    setBannerBlossomHash(undefined);
    setShowBannerPreview(false);
  }
  function removePicture() {
    setPictureUrl('');
    setPictureBlossomHash(undefined);
    setShowPicturePreview(false);
  }
  function removeBanner() {
    setBannerUrl('');
    setBannerBlossomHash(undefined);
    setShowBannerPreview(false);
  }

  async function handleSave() {
    if (nip05Invalid || lud16Invalid || websiteInvalid) {
      setError('Please fix the invalid fields before saving.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const next = buildCandidate();
      await onSaveConfig(next);
      // §9 Q7 — after successful local save, if the slot is currently
      // published, ask whether to push the changes to Nostr too. Skip the
      // prompt in paired-child view (no publish capability locally) and
      // when the parent didn't wire onPublishNow.
      if (!pairedChildView && publishedState?.enabled === true && onPublishNow) {
        setRepublishPromptOpen(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleRepublishConfirm() {
    if (!onPublishNow) {
      setRepublishPromptOpen(false);
      return;
    }
    setRepublishing(true);
    setError('');
    try {
      await onPublishNow();
      setRepublishPromptOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publish failed');
    } finally {
      setRepublishing(false);
    }
  }

  // Status line — rendered at the bottom of the card.
  let statusLine: React.ReactNode;
  if (republishing) {
    statusLine = <>Public Nostr profile: <StatusDot color="var(--warning)" />Pending publish…</>;
  } else if (!publishedState?.enabled) {
    statusLine = <>Public Nostr profile: <StatusDot color="var(--text-muted)" />Off</>;
  } else {
    const ts = formatDate(publishedState.lastPublishedAt);
    const relay = truncateRelay(publishedState.lastPublishedRelay);
    statusLine = (
      <>
        Public Nostr profile: <StatusDot color="var(--success)" />On
        {ts && <> — published {ts}</>}
        {relay && <> to {relay}</>}
      </>
    );
  }

  // Stored NIP-05 check result line — read directly from `config` (the
  // persisted value), never from local form state. Domain comes from
  // re-parsing the SAVED nip05 (the identifier the stored result actually
  // refers to), truncated per repo convention for attacker/guardian-typed
  // display strings. Falls back to a domain-free phrasing when the saved
  // value doesn't parse (e.g. a result stored by an older build whose
  // Save-time validator was looser than parseNip05 — see nip05Unparseable).
  let nip05CheckLine: React.ReactNode = null;
  if (config.nip05CheckResult) {
    const parsed = parseNip05(config.nip05 ?? '');
    const domain = parsed ? truncateDomain(parsed.domain) : 'the domain';
    switch (config.nip05CheckResult) {
      case 'match':
        nip05CheckLine = (
          <>
            Verified: {domain} lists this key
            {config.nip05CheckedAt && <> — {formatRelativeCheckedAt(config.nip05CheckedAt)}</>}
          </>
        );
        break;
      case 'mismatch':
        nip05CheckLine = <>{domain} lists a different key for this name</>;
        break;
      case 'not-found':
        nip05CheckLine = <>{domain} doesn't list this name</>;
        break;
      case 'unreachable':
        nip05CheckLine = <>Couldn't reach {domain} to check</>;
        break;
    }
  }

  return (
    <div className="slot-profile-fields">
      <NpubRow pubkey={pubkey} />

      {/* Everything below the identity row is a form stack with one
          consistent 12px rhythm (D8) — the rows above it are list rows. */}
      <div className="slot-fields">
        {imported && (
          <div
            role="note"
            style={{
              padding: '10px 12px',
              background: 'var(--accent-light)',
              color: 'var(--accent-text)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.85rem',
            }}
          >
            <Icon name="download" size={14} className="icon-inline" /><strong>Imported — not in your seed phrase.</strong> Restoring from your seed phrase will not bring this persona back.
          </div>
        )}

        {pairedChildView && (
          <div
            role="note"
            style={{
              padding: '10px 12px',
              background: 'var(--accent-light)',
              color: 'var(--accent-text)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.85rem',
            }}
          >
            <Icon name="key" size={14} className="icon-inline" /><strong>Your guardian set this up.</strong> Editing happens on their device.
          </div>
        )}

        {error && (
          <div
            role="alert"
            style={{
              padding: '10px 12px',
              background: 'var(--danger-light)',
              color: 'var(--danger)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.85rem',
            }}
          >
            {error}
          </div>
        )}

        <Field label="Picture" hint="Used as your profile picture across Nostr clients.">
          <ImageRow
            url={pictureUrl}
            isSignetHosted={isPictureSignetHosted}
            showPreview={showPicturePreview}
            uploading={uploadingPicture}
            hostname={hostFromUrl(pictureUrl)}
            onUpload={onUploadPicture ? (e) => handleUpload('picture', e) : undefined}
            onPasteUrl={handlePastedPictureUrl}
            onShowPreview={() => setShowPicturePreview(true)}
            onRemove={removePicture}
            disabled={inputsDisabled}
          />
        </Field>

        <Field label="Banner (optional)" hint="Wide banner image shown at the top of your profile on most Nostr clients.">
          <ImageRow
            url={bannerUrl}
            isSignetHosted={isBannerSignetHosted}
            showPreview={showBannerPreview}
            uploading={uploadingBanner}
            hostname={hostFromUrl(bannerUrl)}
            onUpload={onUploadPicture ? (e) => handleUpload('banner', e) : undefined}
            onPasteUrl={handlePastedBannerUrl}
            onShowPreview={() => setShowBannerPreview(true)}
            onRemove={removeBanner}
            disabled={inputsDisabled}
            aspect="wide"
          />
        </Field>

        <Field label="About" hint={`A line or two about yourself. Max 500. (${about.length}/500)`}>
          <textarea
            className="input"
            rows={3}
            value={about}
            onChange={e => setAbout(e.target.value)}
            maxLength={500}
            disabled={inputsDisabled}
            style={{ resize: 'vertical', fontFamily: 'inherit' }}
          />
        </Field>

        {/* Default-Persona variant collapses NIP-05 / Lightning / Website behind a toggle. */}
        {!showAll && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowAll(true)}
            disabled={inputsDisabled}
            style={{ alignSelf: 'flex-start' }}
          >
            ▸ Show all fields
          </button>
        )}

        {showAll && (
          <>
            <Field label="NIP-05 verification (optional)" hint="e.g. you@example.com">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="input"
                  value={nip05}
                  onChange={e => setNip05(e.target.value)}
                  maxLength={100}
                  disabled={inputsDisabled}
                  placeholder="you@example.com"
                  autoCapitalize="off"
                  style={{ flex: 1 }}
                />
                {onNip05Checked && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={handleCheckNip05}
                    disabled={nip05CheckDisabled}
                  >
                    {checkingNip05 ? 'Checking…' : 'Check'}
                  </button>
                )}
              </div>
              {nip05Invalid && <FieldError>NIP-05 looks like name@example.com. Yours doesn't match — it'll still publish, but most Nostr clients won't show it as verified.</FieldError>}
              {onNip05Checked && nip05Dirty && !nip05Empty && !nip05Invalid && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>Save first</div>
              )}
              {onNip05Checked && !nip05Dirty && !nip05Empty && !nip05Invalid && nip05Unparseable && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>This NIP-05 can't be checked</div>
              )}
              {nip05SaveError && (
                <div style={{ fontSize: '0.75rem', color: 'var(--danger)', marginTop: 4 }}>Couldn't save the result.</div>
              )}
              {nip05CheckLine && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 4 }}>{nip05CheckLine}</div>
              )}
            </Field>

            <Field label="Lightning address (optional)" hint="e.g. you@walletofsatoshi.com">
              <input
                className="input"
                value={lud16}
                onChange={e => setLud16(e.target.value)}
                maxLength={100}
                disabled={inputsDisabled}
                placeholder="you@walletofsatoshi.com"
                autoCapitalize="off"
              />
              {lud16Invalid && <FieldError>Lightning addresses look like name@wallet.example.com.</FieldError>}
            </Field>

            <Field label="Website (optional)" hint="">
              <input
                className="input"
                value={website}
                onChange={e => setWebsite(e.target.value)}
                maxLength={300}
                disabled={inputsDisabled}
                placeholder="https://example.com"
              />
              {websiteInvalid && <FieldError>Doesn't look like a URL. Try <code>https://example.com</code>.</FieldError>}
            </Field>
          </>
        )}

        <p className="slot-status-line">{statusLine}</p>

        {!pairedChildView && (
          <div className="slot-save-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              disabled={inputsDisabled || !dirty || nip05Invalid || lud16Invalid || websiteInvalid}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      {republishPromptOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Republish profile to Nostr?"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--scrim)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 16,
          }}
        >
          <div className="card" style={{ maxWidth: 480, width: '100%', padding: 20 }}>
            <h3 style={{ marginTop: 0, marginBottom: 8 }}>Push changes to Nostr?</h3>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 16 }}>
              You're currently published. Also push these changes to Nostr now, so everyone sees the new version?
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-secondary"
                onClick={() => setRepublishPromptOpen(false)}
                disabled={republishing}
                style={{ flex: 1 }}
              >
                Save locally for now
              </button>
              <button
                className="btn btn-primary"
                onClick={handleRepublishConfirm}
                disabled={republishing}
                style={{ flex: 1 }}
              >
                {republishing ? 'Publishing…' : 'Yes, republish'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="slot-field">
      <label className="slot-field-label">{label}</label>
      {children}
      {hint && <div className="slot-field-hint">{hint}</div>}
    </div>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: '0.75rem', color: 'var(--danger)', marginTop: 4 }}>{children}</div>;
}
