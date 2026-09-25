import { useRef, useState } from 'react';
import type { CarouselRow, PublicProfileConfig, PersonaPublicProfile } from '../types';
import type { ResolvedIdentity } from '../lib/carousel-utils';
import { resolveDependantCardSlot } from '../lib/carousel-utils';
import { AUTONOMY_STAGE_INFO } from '../lib/autonomy-labels';
import { resolveDependantIdFromRowAlways } from '../lib/carousel-routing';
import { MiniIdBadge } from './MiniIdBadge';
import { SlotProfileFields, type SlotKind } from './SlotProfileFields';
import { Icon } from './Icon';

interface Props {
  resolved: ResolvedIdentity;
  row: CarouselRow;
  childMode: boolean;
  /**
   * True when running on a paired-child install (the kid's own device,
   * `signingMode === 'paired-child'`). Suppresses the gear-fab on dep rows
   * — per Appendix B the kid sees only the §6.6.11 read-only framing and
   * has no Advanced-page actions to perform here. Default false.
   */
  isPairedChild?: boolean;
  onNavigateDeepPage: (page: string, opts?: {
    focusPersona?: string;
    dependantId?: string;
    slotTarget?: 'natural-person' | 'persona' | 'professional-persona' | string;
  }) => void;
  dependantsCount: number;

  // ─── Inline SlotProfileFields plumbing — Phase 3 (SettingsCard inline editor) ───
  /** Default Blossom server URL — forwarded to SlotProfileFields. */
  defaultBlossomUrl?: string;
  /** Blossom upload consent flag — forwarded to SlotProfileFields. */
  blossomConsent?: boolean;

  // ─── User-side handlers (NP / Persona / Extra) ───
  /** Save the slot's public-profile config (user-side). */
  onSavePersonaConfig?: (
    target: 'natural-person' | 'persona' | 'professional-persona' | string,
    config: PublicProfileConfig,
  ) => Promise<void>;
  /** Republish a currently-published user-side slot's profile. */
  onRepublishProfile?: (
    target: 'natural-person' | 'persona' | 'professional-persona' | string,
  ) => Promise<void>;
  /** Upload a picture or banner via the embedded ImageRow (user-side). */
  onUploadPersonaPicture?: (
    file: File,
    kind: 'picture' | 'banner',
  ) => Promise<{ url: string; sha256: string }>;
  /** Update the display name for a user-side persona slot. */
  onUpdateOwnPersonaName?: (
    target: 'natural-person' | 'persona' | 'professional-persona' | string,
    name: string,
  ) => Promise<void>;
  /**
   * Save a new in-app (encrypted) avatar for a user-side slot. Parent reads
   * the file, downscales + encrypts + uploads to Blossom, then persists the
   * metadata. Throws if Blossom isn't configured — error surfaced inline.
   */
  onSetPersonaAvatar?: (
    target: 'natural-person' | 'persona' | 'professional-persona' | string,
    file: File,
  ) => Promise<void>;
  /** Clear the avatar for a user-side slot. */
  onClearPersonaAvatar?: (
    target: 'natural-person' | 'persona' | 'professional-persona' | string,
  ) => Promise<void>;
  /** Persist a NIP-05 check result for a user-side slot (device-local, never synced). */
  onNip05Checked?: (
    target: 'natural-person' | 'persona' | 'professional-persona' | string,
    result: import('../lib/nip05-check').Nip05CheckResult,
    checkedAt: number,
  ) => Promise<void>;

  // ─── Dep-side handlers (Dep-NP / Dep-Persona / Dep-Extra) ───
  /** Save the slot's public-profile config (dep-side). */
  onSaveDepPersonaConfig?: (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
    config: PublicProfileConfig,
  ) => Promise<void>;
  /** Republish a currently-published dep slot's profile. */
  onRepublishDepProfile?: (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
  ) => Promise<void>;
  /** Upload a picture or banner via the embedded ImageRow (dep-side). */
  onUploadDepPersonaPicture?: (
    depPubkey: string,
    file: File,
    kind: 'picture' | 'banner',
  ) => Promise<{ url: string; sha256: string }>;
  /** Update the dep's overall (NP-row) display name. */
  onUpdateDepName?: (depPubkey: string, name: string) => Promise<void>;
  /** Update a dep persona's display name (Persona / Extra rows). */
  onUpdateDepPersonaName?: (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
    name: string,
  ) => Promise<void>;
  /**
   * Save a new in-app (encrypted) avatar for a dep slot. Same shape as the
   * user-side handler but scoped to a dependant.
   */
  onSetDepPersonaAvatar?: (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
    file: File,
  ) => Promise<void>;
  /** Clear the avatar for a dep slot. */
  onClearDepPersonaAvatar?: (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
  ) => Promise<void>;
  /** Persist a NIP-05 check result for a dep slot (device-local, never synced). */
  onDepNip05Checked?: (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
    result: import('../lib/nip05-check').Nip05CheckResult,
    checkedAt: number,
  ) => Promise<void>;
}

/**
 * Map a carousel row to a `PersonaAdvancedRoute.slotTarget`.
 *
 * Built-in slots return their canonical token; extras return the extra's
 * own pubkey hex (matches the `KeypairToken` convention used elsewhere
 * for slot identity).
 *
 * Mirrors the case-branch shape used by `resolveActiveIdentity` in
 * `src/lib/carousel-utils.ts`; new row types should add a case here too.
 *
 * Rows that don't represent a single slot (`add`) fall
 * through to `'natural-person'` — safe because every identity has an NP
 * slot, and the gear-fab isn't surfaced on those rows in practice.
 */
export function resolveSlotTargetFromRow(row: CarouselRow): string {
  switch (row.type) {
    case 'bot': return row.bot.publicKey;
    case 'natural-person':
      return 'natural-person';
    case 'persona':
      return 'persona';
    case 'extra-persona':
      return row.identity.extraPersonas?.[row.personaIndex]?.publicKey ?? 'natural-person';
    case 'dependant':
      // Guardian viewing a dep card. The card stands for the dep's ACTING
      // slot, so the cog must open the SAME slot the card shows — otherwise a
      // persona-first dependant's card shows the handle while the gear-fab
      // opens Advanced on the dormant real-name slot, rendering its npub, its
      // hex key and a kind-0 publish button for a pubkey the guardian has
      // never activated. One resolver, one answer (spec §7.6).
      return resolveDependantCardSlot(row.dependant).slotTarget;
    case 'dependant-persona':
      return 'persona';
    case 'dependant-extra-persona':
      return row.dependant.extraPersonas?.[row.personaIndex]?.publicKey ?? 'natural-person';
    // `add` is not a per-slot row. Safe fallback: NP.
    // TODO: gear-fab shouldn't render on that row; revisit if it ever does.
    default:
      return 'natural-person';
  }
}

/** `SlotKind` for a dep slot token from `resolveDependantCardSlot`. */
function dependantSlotKindFor(slotTarget: string): SlotKind {
  if (slotTarget === 'natural-person') return 'dep-natural-person';
  if (slotTarget === 'persona') return 'dep-persona';
  return 'dep-extra';
}

interface ResolvedSlot {
  /** Token to pass to the user-side save/publish/rename handlers. */
  ownTarget?: 'natural-person' | 'persona' | 'professional-persona' | string;
  /** Token to pass to the dep-side save/publish/rename handlers. */
  depTarget?: 'natural-person' | 'persona' | string;
  /** Owning dep pubkey for dep-side handlers. */
  depPubkey?: string;
  /** The slot's own hex pubkey — forwarded to SlotProfileFields' npub row + NIP-05 check. */
  pubkey: string;
  /** SlotProfileFields' slotKind discriminator. */
  slotKind: SlotKind;
  /** PublicProfileConfig snapshot derived from the slot. */
  config: PublicProfileConfig;
  /** PublicProfile state snapshot for §9 Q7 republish prompt + status line. */
  publishedState?: PersonaPublicProfile;
  /** Imported flag for extras (renders the §6.4 banner). */
  imported?: boolean;
  /** Whether this row's persona is the user's own (vs dep) — selects handler family. */
  scope: 'own' | 'dep';
  /** Encrypted in-app avatar hash, if any. Drives Set/Change wording. */
  avatarHash?: string;
}

function buildConfigFromSlot(s: {
  displayName: string;
  about?: string;
  pictureUrl?: string;
  pictureBlossomHash?: string;
  bannerUrl?: string;
  bannerBlossomHash?: string;
  nip05?: string;
  lud16?: string;
  website?: string;
  nip05CheckResult?: PublicProfileConfig['nip05CheckResult'];
  nip05CheckedAt?: number;
}): PublicProfileConfig {
  return {
    displayName: s.displayName,
    about: s.about,
    pictureUrl: s.pictureUrl,
    pictureBlossomHash: s.pictureBlossomHash,
    bannerUrl: s.bannerUrl,
    bannerBlossomHash: s.bannerBlossomHash,
    nip05: s.nip05,
    lud16: s.lud16,
    website: s.website,
    nip05CheckResult: s.nip05CheckResult,
    nip05CheckedAt: s.nip05CheckedAt,
  };
}

/**
 * Resolve the row into the slot data needed to render `<SlotProfileFields />`
 * inline. Returns `null` for non-slot rows (`add`) — the
 * caller short-circuits and renders a system-level layout instead.
 */
function resolveSlotForRow(row: CarouselRow): ResolvedSlot | null {
  switch (row.type) {
    case 'natural-person': {
      const s = row.identity.naturalPerson;
      return {
        ownTarget: 'natural-person',
        pubkey: s.publicKey,
        slotKind: 'natural-person',
        config: buildConfigFromSlot(s),
        publishedState: s.publicProfile,
        scope: 'own',
        avatarHash: s.avatarHash,
      };
    }
    case 'persona': {
      const s = row.identity.persona;
      return {
        ownTarget: 'persona',
        pubkey: s.publicKey,
        slotKind: 'persona',
        config: buildConfigFromSlot(s),
        publishedState: s.publicProfile,
        scope: 'own',
        avatarHash: s.avatarHash,
      };
    }
    case 'extra-persona': {
      const ep = row.identity.extraPersonas?.[row.personaIndex];
      if (!ep) return null;
      return {
        ownTarget: ep.publicKey,
        pubkey: ep.publicKey,
        slotKind: 'extra',
        config: buildConfigFromSlot(ep),
        publishedState: ep.publicProfile,
        imported: ep.imported,
        scope: 'own',
        avatarHash: ep.avatarHash,
      };
    }
    case 'dependant': {
      const { slotTarget, slot: s } = resolveDependantCardSlot(row.dependant);
      return {
        depTarget: slotTarget,
        depPubkey: row.dependant.id,
        pubkey: s.publicKey,
        slotKind: dependantSlotKindFor(slotTarget),
        config: buildConfigFromSlot(s),
        publishedState: s.publicProfile,
        scope: 'dep',
        avatarHash: s.avatarHash,
      };
    }
    case 'dependant-persona': {
      const s = row.dependant.persona;
      return {
        depTarget: 'persona',
        depPubkey: row.dependant.id,
        pubkey: s.publicKey,
        slotKind: 'dep-persona',
        config: buildConfigFromSlot(s),
        publishedState: s.publicProfile,
        scope: 'dep',
        avatarHash: s.avatarHash,
      };
    }
    case 'dependant-extra-persona': {
      const ep = row.dependant.extraPersonas?.[row.personaIndex];
      if (!ep) return null;
      return {
        depTarget: ep.publicKey,
        depPubkey: row.dependant.id,
        pubkey: ep.publicKey,
        slotKind: 'dep-extra',
        config: buildConfigFromSlot(ep),
        publishedState: ep.publicProfile,
        imported: ep.imported,
        scope: 'dep',
        avatarHash: ep.avatarHash,
      };
    }
    default:
      return null;
  }
}

/**
 * Inline avatar Set/Change/Remove row — the encrypted in-app picture for
 * the slot. Lives above the InlineNameEditor inside the Profile form-group
 * so the user sees "picture, name, public profile fields" in the natural
 * top-down order. Same pattern as the per-row controls in Personas.tsx /
 * GuardianSettings.tsx (lifted here) so those deep pages can
 * drop their now-redundant UI. Suppressed on the paired-child surface —
 * the kid's local writes get overwritten by the next persona-inventory
 * sync from the guardian.
 */
function InlineAvatarRow({
  hasAvatar,
  onSet,
  onClear,
  disabled,
}: {
  hasAvatar: boolean;
  onSet: (file: File) => Promise<void>;
  onClear?: () => Promise<void>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function trigger() {
    if (busy || disabled) return;
    setError('');
    fileInputRef.current?.click();
  }

  async function handleFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset input so picking the same file twice still triggers onChange.
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      await onSet(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save avatar. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!onClear || busy) return;
    setBusy(true);
    setError('');
    try {
      await onClear();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove avatar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row">
      <div className="row-main">
        <span className="row-label">In-app picture</span>
        <span className="row-sub">Private — only on this device</span>
        {error && <span className="slot-row-error">{error}</span>}
      </div>
      <div className="slot-row-actions">
        <button
          className="btn btn-ghost btn-sm"
          onClick={trigger}
          disabled={busy || disabled}
        >
          {busy ? 'Uploading…' : hasAvatar ? 'Change' : 'Set'}
        </button>
        {hasAvatar && onClear && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={clear}
            disabled={busy}
            style={{ color: 'var(--text-muted)' }}
          >
            Remove
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleFileChosen}
        />
      </div>
    </div>
  );
}

/**
 * Inline name editor — used at the top of the persona section. Same shape
 * as the editor in Personas.tsx + GuardianSettings.tsx so we keep the UX
 * consistent across surfaces. We re-implement it here (rather than lifting
 * to a shared component in this pass) to keep the diff localised; the
 * planned Phase 4 trim of Personas.tsx will be a natural moment to extract.
 */
function InlineNameEditor({
  currentName,
  onSave,
  label,
  disabled,
}: {
  currentName: string;
  onSave: (name: string) => Promise<void>;
  label: string;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function start() {
    setDraft(currentName);
    setError('');
    setEditing(true);
  }
  function cancel() {
    setEditing(false);
    setDraft('');
    setError('');
  }
  async function save() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (trimmed.length > 100) {
      setError('Name must be 100 characters or fewer.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(trimmed);
      setEditing(false);
      setDraft('');
    } catch {
      setError('Failed to save name. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="row slot-name-row">
        <div className="row-main">
          <span className="row-sub">{label}</span>
          {/* A slot with no display name (the default Persona is often
              unnamed) would otherwise leave a bare label with nothing under
              it — say so instead. */}
          <span className={`slot-name-value${currentName ? '' : ' slot-name-value--unset'}`}>
            {currentName || 'Not set'}
          </span>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={start}
          disabled={disabled}
        >
          Edit
        </button>
      </div>
    );
  }
  return (
    <div className="row slot-name-row slot-name-row--editing">
      <span className="row-sub">{label}</span>
      <input
        className="input input-sm"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        maxLength={100}
        autoFocus
        disabled={saving}
      />
      {error && <div className="slot-row-error">{error}</div>}
      <div className="slot-row-actions slot-row-actions--end">
        <button className="btn btn-ghost btn-sm" onClick={cancel} disabled={saving}>
          Cancel
        </button>
        <button className="btn btn-ghost btn-sm" onClick={save} disabled={saving || !draft.trim()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

export function SettingsCard({
  resolved,
  row,
  childMode,
  isPairedChild = false,
  onNavigateDeepPage,
  dependantsCount,
  defaultBlossomUrl,
  blossomConsent,
  onSavePersonaConfig,
  onRepublishProfile,
  onUploadPersonaPicture,
  onUpdateOwnPersonaName,
  onSetPersonaAvatar,
  onClearPersonaAvatar,
  onNip05Checked,
  onSaveDepPersonaConfig,
  onRepublishDepProfile,
  onUploadDepPersonaPicture,
  onUpdateDepName,
  onUpdateDepPersonaName,
  onSetDepPersonaAvatar,
  onClearDepPersonaAvatar,
  onDepNip05Checked,
}: Props) {
  const isGuardianViewingChild = row.type === 'dependant' && !childMode;
  // Paired-child surface: no consequential actions on the dep persona card.
  // The §6.6.11 read-only framing is the whole UX — surfacing the gear-fab
  // would route the kid to user-side handlers (Publish/Switch primary/Show
  // seed phrase) which they have no right to invoke. Appendix B.
  const isDepRow = row.type === 'dependant' ||
    row.type === 'dependant-persona' ||
    row.type === 'dependant-extra-persona';
  const hidePersonaAdvancedCog = isPairedChild && isDepRow;
  // In child mode the dep's own rows shouldn't surface the guardian-scoped
  // Profile/Security/Connections shortcuts — `settings-profile` etc. all
  // bind to the guardian identity.
  const isChildModeDepRow = childMode && (
    row.type === 'dependant' ||
    row.type === 'dependant-persona' ||
    row.type === 'dependant-extra-persona'
  );

  // Guardian-side persona / extra-persona rows on the carousel.
  const isGuardianOwnPersonaRow = !childMode && (
    row.type === 'persona' || row.type === 'extra-persona'
  );

  // Inline slot data — drives the SlotProfileFields editor + name editor.
  const slot = resolveSlotForRow(row);

  // Render the inline SlotProfileFields block for any persona row.
  // `pairedChildViewForSlot` is true for the paired-child surface on dep
  // rows (read-only §6.6.11 framing). Guardian-acting-as in child-mode is
  // editable — `isPairedChild` only flips true when the install IS the
  // kid's device.
  const pairedChildViewForSlot = isPairedChild && isDepRow;

  function renderInlineSlotEditor() {
    if (!slot) return null;
    // Decide which save/publish/upload handlers to wire.
    const onSaveConfig = async (next: PublicProfileConfig) => {
      if (slot.scope === 'own' && slot.ownTarget && onSavePersonaConfig) {
        await onSavePersonaConfig(slot.ownTarget, next);
      } else if (slot.scope === 'dep' && slot.depPubkey && slot.depTarget && onSaveDepPersonaConfig) {
        await onSaveDepPersonaConfig(slot.depPubkey, slot.depTarget, next);
      }
    };
    const onPublishNow = slot.publishedState?.enabled
      ? async () => {
          if (slot.scope === 'own' && slot.ownTarget && onRepublishProfile) {
            await onRepublishProfile(slot.ownTarget);
          } else if (slot.scope === 'dep' && slot.depPubkey && slot.depTarget && onRepublishDepProfile) {
            await onRepublishDepProfile(slot.depPubkey, slot.depTarget);
          }
        }
      : undefined;
    const onUploadPicture =
      slot.scope === 'own'
        ? onUploadPersonaPicture
        : slot.scope === 'dep' && slot.depPubkey && onUploadDepPersonaPicture
          ? (file: File, kind: 'picture' | 'banner') =>
              onUploadDepPersonaPicture(slot.depPubkey!, file, kind)
          : undefined;
    // No persistence path on the read-only paired-child surface — leave
    // onNip05Checked undefined there so SlotProfileFields hides the Check
    // button rather than writing a check result the kid has no consequential
    // control over (mirrors the rest of this read-only view).
    const onNip05CheckedForSlot = pairedChildViewForSlot
      ? undefined
      : slot.scope === 'own' && slot.ownTarget && onNip05Checked
        ? (result: import('../lib/nip05-check').Nip05CheckResult, checkedAt: number) =>
            onNip05Checked(slot.ownTarget!, result, checkedAt)
        : slot.scope === 'dep' && slot.depPubkey && slot.depTarget && onDepNip05Checked
          ? (result: import('../lib/nip05-check').Nip05CheckResult, checkedAt: number) =>
              onDepNip05Checked(slot.depPubkey!, slot.depTarget!, result, checkedAt)
          : undefined;

    return (
      <SlotProfileFields
        pubkey={slot.pubkey}
        config={slot.config}
        publishedState={slot.publishedState}
        slotKind={slot.slotKind}
        imported={slot.imported}
        pairedChildView={pairedChildViewForSlot}
        defaultBlossomUrl={defaultBlossomUrl}
        blossomConsent={blossomConsent}
        onSaveConfig={onSaveConfig}
        onPublishNow={onPublishNow}
        onUploadPicture={onUploadPicture}
        onNip05Checked={onNip05CheckedForSlot}
      />
    );
  }

  // Inline avatar Set/Change/Remove row. Bound to the user-side or dep-side
  // handler family based on the resolved slot's scope. Suppressed on the
  // paired-child surface — the kid's writes would be overwritten by the
  // next persona-inventory sync from the guardian. Hidden when no
  // `onSet*Avatar` handler is wired (e.g. parent chose not to plumb it).
  function renderInlineAvatarRow() {
    if (pairedChildViewForSlot) return null;
    if (!slot) return null;
    const hasAvatar = !!slot.avatarHash;

    if (slot.scope === 'own') {
      if (!onSetPersonaAvatar || !slot.ownTarget) return null;
      const target = slot.ownTarget;
      return (
        <InlineAvatarRow
          hasAvatar={hasAvatar}
          onSet={(file) => onSetPersonaAvatar(target, file)}
          onClear={onClearPersonaAvatar ? () => onClearPersonaAvatar(target) : undefined}
        />
      );
    }

    // dep
    if (!onSetDepPersonaAvatar || !slot.depPubkey || !slot.depTarget) return null;
    const depPubkey = slot.depPubkey;
    const depTarget = slot.depTarget;
    return (
      <InlineAvatarRow
        hasAvatar={hasAvatar}
        onSet={(file) => onSetDepPersonaAvatar(depPubkey, depTarget, file)}
        onClear={onClearDepPersonaAvatar ? () => onClearDepPersonaAvatar(depPubkey, depTarget) : undefined}
      />
    );
  }

  // Inline display-name editor wiring per row. Returns null when no
  // handler is wired or when the row doesn't expose a renamable name
  // (e.g. add).
  function renderInlineNameEditor() {
    if (pairedChildViewForSlot) return null; // read-only on the kid's surface
    if (!slot) return null;

    if (slot.scope === 'own') {
      if (!onUpdateOwnPersonaName || !slot.ownTarget) return null;
      const label =
        slot.slotKind === 'natural-person'
          ? 'Natural Person name'
          : slot.slotKind === 'persona'
            ? 'Default persona name'
            : slot.slotKind === 'professional-persona'
              ? 'Professional persona name'
              : 'Persona name';
      const target = slot.ownTarget;
      return (
        <InlineNameEditor
          currentName={slot.config.displayName}
          label={label}
          onSave={(name) => onUpdateOwnPersonaName(target, name)}
        />
      );
    }

    // dep
    if (!slot.depPubkey) return null;
    const depPubkey = slot.depPubkey;
    if (slot.slotKind === 'dep-natural-person') {
      // Dep's overall display name — uses updateDependantName, not the
      // per-persona setter. The NP slot's displayName mirrors the dep's
      // overall name in practice; updating the top-level is what the
      // April refactor uses.
      if (!onUpdateDepName) return null;
      return (
        <InlineNameEditor
          currentName={resolved.displayName}
          label="Name"
          onSave={(name) => onUpdateDepName(depPubkey, name)}
        />
      );
    }
    if (!onUpdateDepPersonaName || !slot.depTarget) return null;
    const depTarget = slot.depTarget;
    const label = slot.slotKind === 'dep-persona' ? 'Default persona name' : 'Persona name';
    return (
      <InlineNameEditor
        currentName={slot.config.displayName}
        label={label}
        onSave={(name) => onUpdateDepPersonaName(depPubkey, depTarget, name)}
      />
    );
  }

  // Header line under the MiniIdBadge. A bare "Settings" duplicates the
  // badge and the section eyebrows below it, so it's dropped — only the
  // qualified variants ("<Name>'s Settings" / "<Persona> Settings") earn a
  // line of their own, rendered once as a quiet section header.
  const headerTitle = isGuardianViewingChild
    ? `${resolved.displayName}'s Settings`
    : resolved.type === 'Persona'
      ? `${resolved.displayName} Settings`
      : null;

  return (
    <div className="settings-view">
      <MiniIdBadge resolved={resolved} />
      {headerTitle && <h2 className="settings-view-title">{headerTitle}</h2>}

      {isGuardianViewingChild ? (
        <>
          <div className="settings-label">Guardian Controls</div>
          {/* Phone & Pairing is a shortcut: skip the GuardianSettings page and
           jump straight to pair-dependant-device (which handles its own
           Bunker-off / generate-QR / paired-status states). */}
          <button className="settings-row" onClick={() => onNavigateDeepPage('pair-dependant-device', { dependantId: row.dependant.id })}>
            <span className="sr-label"><Icon name="smartphone" size={16} className="icon-inline" />Phone & Pairing</span>
            <span className="sr-value">
              {row.dependant.bunkerEndpoint?.authorizedClientPubkey ? 'Paired' : 'No phone paired'}
            </span>
            <span className="sr-chevron">&rsaquo;</span>
          </button>
          <button className="settings-row" onClick={() => onNavigateDeepPage('settings', { dependantId: row.dependant.id })}>
            <span className="sr-label">Autonomy Level</span>
            <span className="sr-value">
              {AUTONOMY_STAGE_INFO[row.dependant.autonomyStage].label}
            </span>
            <span className="sr-chevron">&rsaquo;</span>
          </button>

          {/* Inline name editor + inline kind-0 fields editor for dep NP slot. */}
          <div className="settings-label" style={{ marginTop: 12 }}>Profile</div>
          <div className="settings-form-group">
            {renderInlineAvatarRow()}
            {renderInlineNameEditor()}
            {renderInlineSlotEditor()}
          </div>

          <div className="settings-label" style={{ marginTop: 12 }}>Danger Zone</div>
          <button className="settings-row danger" onClick={() => onNavigateDeepPage('transition-ceremony', { dependantId: row.dependant.id })}>
            <span className="sr-label">Independence Ceremony</span>
            <span className="sr-chevron">&rsaquo;</span>
          </button>
        </>
      ) : isChildModeDepRow ? (
        // Child-mode (guardian-acting-as OR paired-child) dep persona row.
        // For paired-child: read-only §6.6.11 framing (handled inside
        // SlotProfileFields via pairedChildView). For guardian-acting-as:
        // editable inline.
        <>
          <div className="settings-label">Profile</div>
          <div className="settings-form-group">
            {renderInlineAvatarRow()}
            {renderInlineNameEditor()}
            {renderInlineSlotEditor()}
          </div>
        </>
      ) : isGuardianOwnPersonaRow ? (
        <>
          <div className="settings-label">Profile</div>
          <div className="settings-form-group">
            {renderInlineAvatarRow()}
            {renderInlineNameEditor()}
            {renderInlineSlotEditor()}
          </div>

          <div className="settings-label">More</div>
          <button className="settings-row" onClick={() => onNavigateDeepPage('settings-personas')}>
            <span className="sr-label">Manage all personas</span>
            <span className="sr-chevron">&rsaquo;</span>
          </button>
        </>
      ) : (
        <>
          {dependantsCount > 0 && row.type === 'natural-person' && (
            <>
              <div className="settings-label">Family</div>
              <button className="settings-row" onClick={() => onNavigateDeepPage('family-list')}>
                <span className="sr-label">Dependants</span>
                <span className="sr-value">{dependantsCount}</span>
                <span className="sr-chevron">&rsaquo;</span>
              </button>
            </>
          )}

          <div className="settings-label">Profile</div>
          <div className="settings-form-group">
            {renderInlineAvatarRow()}
            {renderInlineNameEditor()}
            {renderInlineSlotEditor()}
          </div>
          <button className="settings-row" onClick={() => onNavigateDeepPage('photo-capture')}>
            <span className="sr-label">Photo</span>
            <span className="sr-value">Update</span>
            <span className="sr-chevron">&rsaquo;</span>
          </button>

          <div className="settings-label">Security</div>
          <button className="settings-row" onClick={() => onNavigateDeepPage('settings-security')}>
            <span className="sr-label">PIN / Biometric</span>
            <span className="sr-chevron">&rsaquo;</span>
          </button>
          <button className="settings-row" onClick={() => onNavigateDeepPage('settings-security')}>
            <span className="sr-label">Backup Words</span>
            <span className="sr-chevron">&rsaquo;</span>
          </button>

          <div className="settings-label">Connections</div>
          <button className="settings-row" onClick={() => onNavigateDeepPage('connections')}>
            <span className="sr-label">Connected Sites</span>
            <span className="sr-chevron">&rsaquo;</span>
          </button>
        </>
      )}

      {!hidePersonaAdvancedCog && (
        <button className="gear-fab" onClick={() => {
          // Use the *Always variant: the persona-advanced route depends on
          // `pendingPersonaAdvancedTarget.depPubkey` being set even when
          // `childMode` is true. Otherwise a guardian acting-as a dep who
          // taps the cog on a dep extra would land on their own NP-side
          // extra slot (childMode-suppressed dep id → user-side lookup).
          const depId = resolveDependantIdFromRowAlways(row);
          const slotTarget = resolveSlotTargetFromRow(row);
          onNavigateDeepPage('persona-advanced', {
            slotTarget,
            ...(depId ? { dependantId: depId } : {}),
          });
        }}>
          <Icon name="settings" size={20} title="Advanced" />
        </button>
      )}
    </div>
  );
}
