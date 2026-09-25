/**
 * Per-slot Advanced page — reached when the user taps the ⚙ gear-fab on a
 * persona card. Owns every consequential action for that slot: Publish,
 * Disable / retract, Switch primary, Show seed phrase, Hide, Delete; for a
 * dep's Natural Person slot it also owns dep-level Autonomy, Activity
 * visibility and Remove dependant.
 *
 * The persona card stays safe (rename, set avatar, edit kind-0 config); the
 * cog is consequential (do anything irreversible). The split is documented
 * in 2026-05-17-persona-card-as-source-of-truth-design.md Appendix B.
 *
 * Phase 2 T23. The page is defined here but not yet routed — Phase 2C
 * rewires the gear-fab and Phase 2F adds the route to App.tsx.
 */

import { useState } from 'react';
import { NpubRow } from '../components/NpubRow';
import { Icon } from '../components/Icon';
import type { SignetIdentity, DependantIdentity, AutonomyStage, PersonaPublicProfile } from '../types';
import { TypedNameConfirm } from '../components/TypedNameConfirm';
import { AUTONOMY_STAGE_INFO } from '../lib/autonomy-labels';
import { BACKUP_WORDS_ON_SIGNER } from '../lib/local-key-only-copy';
import { resolveAuditVisibility } from '../lib/audit-visibility';
import { isDependantNaturalPersonActive } from '../lib/identity-display';
import { resolveDependantCardSlot } from '../lib/carousel-utils';
import type { DependantContactsChoice } from '../lib/contacts-v2-removal';
import {
  ARCHIVE_CONTACTS_LABEL, DELETE_CONTACTS_LABEL, DEPENDANT_CONTACTS_SECTION_TITLE,
  REMOVE_DEPENDANT_CONTACTS_LOADING_COPY, removalChoiceCopy,
} from '../lib/contacts-v2-copy';

export type SlotKind =
  | 'natural-person'
  | 'persona'
  | 'professional-persona'
  | 'extra'
  | 'dep-natural-person'
  | 'dep-persona'
  | 'dep-extra';

export interface PersonaAdvancedProps {
  /** Slot target token: 'natural-person' | 'persona' | 'professional-persona' | extra-pubkey-hex */
  slotTarget: 'natural-person' | 'persona' | 'professional-persona' | string;
  /** Present for dep slots; absent for user's own slots. */
  depPubkey?: string;

  identity: SignetIdentity;
  dependants: ReadonlyArray<DependantIdentity>;

  // — Publish/Disable —
  /** Tap to publish — fires NP typed-name confirm internally for NP first-time, single-confirm otherwise. */
  onPublishProfile: (
    slotKind: SlotKind,
    typedNameValue?: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  onDisablePublicProfile: () => Promise<void>;
  onRepublish?: () => Promise<{ ok: boolean; message?: string }>;

  // — User-side actions —
  onSwitchPrimary?: (target: 'natural-person' | 'persona') => Promise<void>;
  onShowMnemonic?: () => void;
  /**
   * True when this device holds no mnemonic because the family migrated to a
   * Heartwood signer — the Backup block then states where the words live
   * instead of offering a "Show seed phrase" button that has nothing to show
   * (family-bunker §11.1.7).
   */
  mnemonicOnSigner?: boolean;

  // — Extras-only —
  onHidePersona?: (pubkey: string) => Promise<void>;
  onShowPersona?: (pubkey: string) => Promise<void>;
  /**
   * §6.10 retract-on-hide. Called by HideBlock when the user opts in to the
   * "also ask the relay to delete the public profile" checkbox on the
   * hide-confirm prompt. Optional — when absent the §6.10 prompt offers
   * only the plain hide. Best-effort: failures are swallowed so the hide
   * proceeds regardless.
   *
   * Moved from ManageCarousel in Phase 2 T27 — hide now happens here, on
   * the persona card's ⚙ Advanced page, where the user has the full
   * context for the slot they're hiding.
   */
  onRetractExtraPersonaProfile?: (pubkey: string) => Promise<void>;
  onDeletePersona?: (pubkey: string) => Promise<void>;
  onShowImportedNsec?: () => void;

  // — Dep-NP-only (the dep-level "Manage Alex" surface) —
  onChangeAutonomyStage?: (stage: AutonomyStage) => Promise<void>;
  onChangeActivityVisibility?: (override: 'default' | 'force-visible' | 'force-hidden') => Promise<void>;
  /**
   * Guardian opt-in for C4 petitions on device auto-deny (family-bunker
   * §11.1.4/9): when the Heartwood hard-denies a request outside the
   * dep's compiled ceiling, raise a "Family asks" petition instead of
   * failing silently. Present only when a policy push target exists.
   */
  onChangePetitionOnDeny?: (on: boolean) => Promise<void>;
  onRemoveDependant?: (contactsChoice: DependantContactsChoice) => Promise<void>;
  /**
   * Whether the family contacts log the removal choice plans against is
   * still loading — the Remove control stays disabled while true, since a
   * click landing mid-load would offer a choice with nothing to apply it
   * to yet.
   */
  contactsLoading?: boolean;

  // — Routing —
  onBack: () => void;
}

// ─── Slot resolution ──────────────────────────────────────────────────────

function inferSlotKind(
  slotTarget: string,
  depPubkey: string | undefined,
): SlotKind {
  if (depPubkey) {
    if (slotTarget === 'natural-person') return 'dep-natural-person';
    if (slotTarget === 'persona') return 'dep-persona';
    return 'dep-extra';
  }
  if (slotTarget === 'natural-person') return 'natural-person';
  if (slotTarget === 'persona') return 'persona';
  if (slotTarget === 'professional-persona') return 'professional-persona';
  return 'extra';
}

interface ResolvedSlot {
  publicKey: string;
  displayName: string;
  publicProfile?: PersonaPublicProfile;
  /** Imported nsec — only meaningful for extras. */
  imported?: boolean;
  hidden?: boolean;
}

function resolveUserSlot(identity: SignetIdentity, target: string): ResolvedSlot | undefined {
  if (target === 'natural-person') {
    return {
      publicKey: identity.naturalPerson.publicKey,
      displayName: identity.naturalPerson.displayName,
      publicProfile: identity.naturalPerson.publicProfile,
    };
  }
  if (target === 'persona') {
    return {
      publicKey: identity.persona.publicKey,
      displayName: identity.persona.displayName,
      publicProfile: identity.persona.publicProfile,
    };
  }
  if (target === 'professional-persona') {
    if (!identity.professionalPersona) return undefined;
    return {
      publicKey: identity.professionalPersona.publicKey,
      displayName: identity.professionalPersona.displayName,
      publicProfile: identity.professionalPersona.publicProfile,
    };
  }
  const ep = (identity.extraPersonas ?? []).find(p => p.publicKey === target);
  if (!ep) return undefined;
  return {
    publicKey: ep.publicKey,
    displayName: ep.displayName,
    publicProfile: ep.publicProfile,
    imported: ep.imported,
    hidden: ep.hidden,
  };
}

function resolveDepSlot(dep: DependantIdentity | undefined, target: string): ResolvedSlot | undefined {
  if (!dep) return undefined;
  if (target === 'natural-person') {
    return {
      publicKey: dep.naturalPerson.publicKey,
      displayName: dep.naturalPerson.displayName,
      publicProfile: dep.naturalPerson.publicProfile,
    };
  }
  if (target === 'persona') {
    return {
      publicKey: dep.persona.publicKey,
      displayName: dep.persona.displayName,
      publicProfile: dep.persona.publicProfile,
    };
  }
  const ep = (dep.extraPersonas ?? []).find(p => p.publicKey === target);
  if (!ep) return undefined;
  return {
    publicKey: ep.publicKey,
    displayName: ep.displayName,
    publicProfile: ep.publicProfile,
    imported: ep.imported,
    hidden: ep.hidden,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function truncateRelay(relay?: string): string {
  if (!relay) return '';
  try {
    return new URL(relay).host;
  } catch {
    return relay.slice(0, 40);
  }
}

function formatPublishedAt(ts?: number): string {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString();
}

// ─── Page ─────────────────────────────────────────────────────────────────

export function PersonaAdvanced(props: PersonaAdvancedProps) {
  const { slotTarget, depPubkey, identity, dependants, onBack } = props;

  const dep = depPubkey ? dependants.find(d => d.id === depPubkey) : undefined;
  const slotKind = inferSlotKind(slotTarget, depPubkey);
  const slot = depPubkey ? resolveDepSlot(dep, slotTarget) : resolveUserSlot(identity, slotTarget);

  if (!slot) {
    return (
      <div className="fade-in empty-state">
        <div className="empty-state-icon"><Icon name="settings" size={36} /></div>
        <h3 className="empty-state-title">Persona not found</h3>
        <p className="empty-state-text">
          That persona isn't on this device any more — it may have been deleted
          or removed on another device.
        </p>
        <button className="btn btn-primary" onClick={onBack}>Back</button>
      </div>
    );
  }

  const isDep = !!depPubkey;
  const subjectName = isDep ? (dep?.displayName ?? 'this dependant') : 'you';

  // Belt-and-braces for the §7.6 leak the gear-fab used to cause: even if some
  // future caller routes here with a dormant dep NP target, the real-name
  // pubkey and its kind-0 publish button must not render. `resolveSlotTargetFromRow`
  // no longer produces this combination — this is the second lock, not the first.
  const dormantDepNp = slotKind === 'dep-natural-person' && !!dep && !isDependantNaturalPersonActive(dep);

  // Dep-level settings (autonomy stage, activity visibility, petitions, remove)
  // hang off whichever slot the dependant's CARD stands for, because the
  // gear-fab on that card is the only route to this page. Pinning them to the
  // NP slot (Appendix B "Option B") was the same thing while every dependant
  // was NP-primary; for a persona-first dependant it would strand the guardian
  // with no way to reach them at all.
  const showDepSettings = !!dep && slotTarget === resolveDependantCardSlot(dep).slotTarget;

  return (
    <div className="fade-in">
      {/* Identity strip — the Layout header already says "Advanced", so this
          says WHICH persona rather than repeating the page title. */}
      <div className="page-identity">
        <div className="page-identity-avatar" aria-hidden="true">{initialsFor(slot.displayName)}</div>
        <div className="page-identity-main">
          <span className="page-identity-name">{slot.displayName || 'Unnamed persona'}</span>
          <span className="page-identity-caption">{slotCaptionFor(slotKind)}</span>
        </div>
      </div>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0 0 16px' }}>
        Consequential actions for this persona. Name, picture and profile live on the card.
      </p>

      {dormantDepNp ? (
        <div className="card section">
          <div className="section-title">Real identity — not set up</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
            {subjectName} has a real-name slot on file, but it has not been activated
            yet. Nothing about it is shown or published until it is.
          </p>
        </div>
      ) : (
        <>
          <PublishBlock {...props} slotKind={slotKind} slot={slot} subjectName={subjectName} />

          <KeysBlock pubkey={slot.publicKey} />
        </>
      )}

      {/* Primary keypair switch — user NP/Persona only. */}
      {(slotKind === 'natural-person' || slotKind === 'persona') && props.onSwitchPrimary && (
        <PrimaryKeypairBlock identity={identity} slotKind={slotKind} onSwitchPrimary={props.onSwitchPrimary} />
      )}

      {/* Backup / seed phrase — user NP only. */}
      {slotKind === 'natural-person' && (props.onShowMnemonic || props.mnemonicOnSigner) && (
        <BackupBlock onShowMnemonic={props.mnemonicOnSigner ? undefined : props.onShowMnemonic} />
      )}

      {/* Imported nsec note — extras (user + dep) only, if imported. */}
      {(slotKind === 'extra' || slotKind === 'dep-extra') && slot.imported && (
        <ImportedNoteBlock onShowImportedNsec={props.onShowImportedNsec} />
      )}

      {/* Hide / unhide — extras only. */}
      {(slotKind === 'extra' || slotKind === 'dep-extra') && props.onHidePersona && (
        <HideBlock
          pubkey={slot.publicKey}
          displayName={slot.displayName}
          publicProfileEnabled={!!slot.publicProfile?.enabled}
          hidden={!!slot.hidden}
          onShowPersona={props.onShowPersona}
          onHidePersona={props.onHidePersona}
          onRetractExtraPersonaProfile={props.onRetractExtraPersonaProfile}
        />
      )}

      {/* Delete — extras only. */}
      {(slotKind === 'extra' || slotKind === 'dep-extra') && props.onDeletePersona && (
        <DeleteBlock pubkey={slot.publicKey} displayName={slot.displayName} onDeletePersona={props.onDeletePersona} />
      )}

      {/* Dep-level surfaces — rendered on the dependant's acting (card) slot. */}
      {showDepSettings && dep && (
        <DepSettingsBlock
          dep={dep}
          onChangeAutonomyStage={props.onChangeAutonomyStage}
          onChangeActivityVisibility={props.onChangeActivityVisibility}
          onChangePetitionOnDeny={props.onChangePetitionOnDeny}
          onRemoveDependant={props.onRemoveDependant}
          contactsLoading={props.contactsLoading ?? false}
        />
      )}
    </div>
  );
}

/** Caption under the identity strip's name — which slot this page is acting on. */
function slotCaptionFor(slotKind: SlotKind): string {
  switch (slotKind) {
    case 'natural-person': return 'Natural Person';
    case 'persona': return 'Default Persona';
    case 'professional-persona': return 'Professional Persona';
    case 'extra': return 'Persona';
    case 'dep-natural-person': return 'Dependant · Natural Person';
    case 'dep-persona': return 'Dependant · Persona';
    case 'dep-extra': return 'Dependant · Persona';
  }
}

/** Up to two initials for the identity-strip avatar. Never throws on a blank name. */
function initialsFor(displayName: string): string {
  const initials = displayName
    .split(' ')
    .filter(Boolean)
    .map(w => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return initials || '•';
}

// ─── Action blocks ────────────────────────────────────────────────────────

interface PublishBlockProps extends PersonaAdvancedProps {
  slotKind: SlotKind;
  slot: ResolvedSlot;
  subjectName: string;
}

function PublishBlock({
  slotKind,
  slot,
  subjectName,
  onPublishProfile,
  onDisablePublicProfile,
  onRepublish,
}: PublishBlockProps) {
  const enabled = !!slot.publicProfile?.enabled;
  const lastAt = slot.publicProfile?.lastPublishedAt;
  const lastRelay = slot.publicProfile?.lastPublishedRelay;

  // First-time NP enable fires the §6.5 typed-name confirm. Subsequent
  // publishes (Republish) and other slot kinds use the single-confirm prompt
  // or just publish directly.
  const requiresNpTypedName = slotKind === 'natural-person' && !enabled;

  // Single-confirm dialog state. `intent` distinguishes Publish vs Disable so
  // the same confirm UI can serve both — the user-visible copy differs but
  // the modal shape is identical.
  const [intent, setIntent] = useState<null | 'publish' | 'disable'>(null);
  const [npTypedName, setNpTypedName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  async function runPublish(typedNameValue?: string) {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const result = await onPublishProfile(slotKind, typedNameValue);
      if (!result.ok) {
        setError(result.message || 'The relay rejected the publish. Try again, or check your relay in Advanced Settings.');
      } else {
        setInfo('Profile published.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publish failed.');
    } finally {
      setBusy(false);
      setIntent(null);
      setNpTypedName(false);
    }
  }

  async function runDisable() {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await onDisablePublicProfile();
      setInfo('Profile disabled. Signet has asked the relay to retract it.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disable failed.');
    } finally {
      setBusy(false);
      setIntent(null);
    }
  }

  async function runRepublish() {
    if (!onRepublish) return;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const result = await onRepublish();
      if (!result.ok) {
        setError(result.message || 'Republish failed.');
      } else {
        setInfo('Profile republished.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Republish failed.');
    } finally {
      setBusy(false);
    }
  }

  const isDepSlot = slotKind === 'dep-natural-person' || slotKind === 'dep-persona' || slotKind === 'dep-extra';
  const publishLabel = isDepSlot ? `Publish for ${subjectName}` : 'Publish this persona to Nostr';

  return (
    <div className="card section">
      <div className="section-title">Public Nostr profile</div>

      {error && (
        <div role="alert" style={alertStyle('danger')}>{error}</div>
      )}
      {info && (
        <div role="status" style={alertStyle('info')}>{info}</div>
      )}

      <div style={{ marginBottom: 12 }}>
        {enabled ? (
          <>
            <div style={{ fontSize: '0.9rem', marginBottom: 4 }}>
              Status: <strong style={{ color: 'var(--accent-text)' }}><span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--success)', marginRight: 6, verticalAlign: 1 }} />On</strong>
              {lastAt && (
                <> — published {formatPublishedAt(lastAt)}{lastRelay && <> to {truncateRelay(lastRelay)}</>}</>
              )}
            </div>
          </>
        ) : (
          <div style={{ fontSize: '0.9rem', marginBottom: 4 }}>
            Status: <strong style={{ color: 'var(--text-muted)' }}><span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--text-muted)', marginRight: 6, verticalAlign: 1 }} />Off</strong>
          </div>
        )}
      </div>

      {!enabled && (
        <button
          className="btn btn-primary"
          onClick={() => {
            if (requiresNpTypedName) {
              setNpTypedName(true);
            } else {
              setIntent('publish');
            }
          }}
          disabled={busy}
        >
          {publishLabel}
        </button>
      )}

      {enabled && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {onRepublish && (
            <button className="btn btn-secondary" onClick={() => { void runRepublish(); }} disabled={busy}>
              Republish
            </button>
          )}
          <button
            className="btn btn-danger"
            onClick={() => setIntent('disable')}
            disabled={busy}
          >
            Disable / retract
          </button>
        </div>
      )}

      {/* §6.5 NP first-time typed-name confirm. */}
      {npTypedName && (
        <Modal>
          <TypedNameConfirm
            heading="Publish your real-name profile?"
            body="You're about to publish your Natural Person key's public Nostr profile. Anyone on the relay can read it and tie your real name to every signature you make with this key. Personas exist for anonymous use — only do this if you actively want a public real-name presence."
            expectedString={slot.displayName}
            helperText="Once you publish, the profile is on the relay. You can disable it later but some relays may keep a copy."
            confirmLabel="Publish profile"
            onCancel={() => setNpTypedName(false)}
            onConfirm={() => { void runPublish(slot.displayName); }}
          />
        </Modal>
      )}

      {/* Single-confirm modal — Publish or Disable. */}
      {intent === 'publish' && (
        <ConfirmModal
          heading={isDepSlot ? `Publish ${subjectName}'s profile?` : 'Publish this profile?'}
          body={
            isDepSlot
              ? `Signet will publish ${subjectName}'s public Nostr profile to the relay, signed with this persona's key. Anyone on the relay can read it.`
              : "Signet will publish this persona's public Nostr profile to the relay. Anyone on the relay can read it. You can disable it later, but some relays may keep a copy."
          }
          confirmLabel="Publish"
          confirmKind="primary"
          busy={busy}
          onCancel={() => setIntent(null)}
          onConfirm={() => { void runPublish(); }}
        />
      )}

      {intent === 'disable' && (
        <ConfirmModal
          heading="Make this profile private again?"
          body="Signet will ask Nostr relays to delete this public profile and stop publishing updates. Some relays may keep a copy — Signet can't force them to forget."
          confirmLabel={busy ? 'Disabling…' : 'Disable'}
          confirmKind="danger"
          busy={busy}
          onCancel={() => setIntent(null)}
          onConfirm={() => { void runDisable(); }}
        />
      )}
    </div>
  );
}

function PrimaryKeypairBlock({
  identity,
  slotKind,
  onSwitchPrimary,
}: {
  identity: SignetIdentity;
  slotKind: SlotKind;
  onSwitchPrimary: NonNullable<PersonaAdvancedProps['onSwitchPrimary']>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Treat undefined as 'natural-person' (default for identities created before
  // the primaryKeypair field was added — matches resolveLandingKeypair's logic).
  const effectivePrimary: 'natural-person' | 'persona' =
    identity.primaryKeypair || 'natural-person';

  const isActive =
    (slotKind === 'natural-person' && effectivePrimary === 'natural-person') ||
    (slotKind === 'persona' && effectivePrimary === 'persona');

  // The switch always targets the OTHER keypair (NP ↔ Persona). When this
  // slot is already primary the button demotes it; when it isn't, the button
  // promotes it. Both directions use the same write path.
  const switchTo = slotKind === 'natural-person' ? 'persona' : 'natural-person';
  const switchToLabel = switchTo === 'persona' ? 'default Persona' : 'Natural Person';

  async function handleSwitch() {
    setBusy(true);
    setError('');
    try {
      await onSwitchPrimary(switchTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Switch failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card section">
      <div className="section-title">Primary keypair</div>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
        Your primary keypair is currently your{' '}
        <strong>{effectivePrimary === 'natural-person' ? 'Natural Person' : 'default Persona'}</strong>.
        {isActive
          ? ' This slot holds that role — switch it to the other keypair below.'
          : ' Switching changes which keypair Signet uses by default for new actions.'}
      </p>
      {error && <div role="alert" style={alertStyle('danger')}>{error}</div>}
      <button className="btn btn-secondary" onClick={() => { void handleSwitch(); }} disabled={busy}>
        {busy ? 'Switching…' : `Switch primary to ${switchToLabel}`}
      </button>
    </div>
  );
}

function BackupBlock({ onShowMnemonic }: { onShowMnemonic?: () => void }) {
  if (!onShowMnemonic) {
    return (
      <div className="card section">
        <div className="section-title">Backup</div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          {BACKUP_WORDS_ON_SIGNER}
        </p>
      </div>
    );
  }
  return (
    <div className="card section">
      <div className="section-title">Backup</div>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
        Your recovery words back up every persona derived from this identity.
        Write them down somewhere safe — they're the only way to restore your account.
      </p>
      <button className="btn btn-secondary" onClick={onShowMnemonic}>Show recovery words</button>
    </div>
  );
}

const monoBlockStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '0.8rem',
  overflowWrap: 'break-word',
  wordBreak: 'break-all',
  marginBottom: 6,
};

/** Ordinary sharing uses npub; protocol representation is opt-in. */
function KeysBlock({ pubkey }: { pubkey: string }) {
  const [copiedHex, setCopiedHex] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function copyHex() {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(pubkey);
      setCopiedHex(true);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <div className="card section">
      <div className="section-title">Public address</div>
      <NpubRow key={pubkey} pubkey={pubkey} />
      <details style={{ marginTop: 12 }}>
        <summary>Technical details</summary>
        <p>Hex public key for protocol tools</p>
        <div style={monoBlockStyle}>{pubkey}</div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={copyHex}>
          {copiedHex ? 'Copied!' : 'Copy hex'}
        </button>
        {copyError && <p role="status">Couldn’t copy. Select the key above to copy it manually.</p>}
      </details>
    </div>
  );
}

function ImportedNoteBlock({ onShowImportedNsec }: { onShowImportedNsec?: () => void }) {
  return (
    <div className="card section">
      <div className="section-title">Imported persona</div>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
        This persona was imported from an existing nsec, not derived from your Signet
        seed phrase. Your recovery words won't bring it back — make sure your nsec
        is backed up separately. Imported personas stay on this device only; they are
        not included in the cross-device backup.
      </p>
      {onShowImportedNsec && (
        <button className="btn btn-secondary" onClick={onShowImportedNsec}>Show nsec</button>
      )}
    </div>
  );
}

function HideBlock({
  pubkey,
  displayName,
  publicProfileEnabled,
  hidden,
  onShowPersona,
  onHidePersona,
  onRetractExtraPersonaProfile,
}: {
  pubkey: string;
  displayName: string;
  publicProfileEnabled: boolean;
  hidden: boolean;
  onShowPersona?: PersonaAdvancedProps['onShowPersona'];
  onHidePersona: NonNullable<PersonaAdvancedProps['onHidePersona']>;
  onRetractExtraPersonaProfile?: PersonaAdvancedProps['onRetractExtraPersonaProfile'];
}) {
  // Two confirm shapes depending on whether the persona has a published
  // public Nostr profile:
  //   - plain — simple "Hide?" confirm
  //   - retract-prompt — §6.10 checkbox-gated confirm. Hiding a persona with
  //     publicProfile.enabled doesn't take down the kind-0; we offer to
  //     publish a kind-5 retract alongside the hide. Default-on (the safe
  //     choice for users who've forgotten the kind-0 exists).
  const [confirm, setConfirm] = useState(false);
  const [alsoRetract, setAlsoRetract] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const showRetractPrompt = publicProfileEnabled && !!onRetractExtraPersonaProfile;

  async function handleHide() {
    setBusy(true);
    setError('');
    try {
      if (showRetractPrompt && alsoRetract && onRetractExtraPersonaProfile) {
        try {
          await onRetractExtraPersonaProfile(pubkey);
        } catch {
          // §6.10: best-effort retract — proceed with hide regardless.
        }
      }
      await onHidePersona(pubkey);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Hide failed.');
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }

  if (hidden) {
    return (
      <div className="card section">
        <div className="section-title">Hidden persona</div>
        <p>This identity is hidden from your cards and sign-in choices. Showing it again keeps the same npub and does not publish a profile.</p>
        {error && <div role="alert" style={alertStyle('danger')}>{error}</div>}
        {onShowPersona && <button className="btn" disabled={busy} onClick={async () => {
          setBusy(true); setError('');
          try { await onShowPersona(pubkey); }
          catch (err) { setError(err instanceof Error ? err.message : 'Could not show this persona.'); }
          finally { setBusy(false); }
        }}>{busy ? 'Showing…' : 'Show this persona again'}</button>}
      </div>
    );
  }

  return (
    <div className="card section">
      <div className="section-title">Hide persona</div>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
        Hiding "{displayName}" removes it from the carousel and from every
        sign-in / connect picker. The keypair stays in your identity so the
        derivation slot isn't reused. You can restore from Manage Carousel.
      </p>
      {error && <div role="alert" style={alertStyle('danger')}>{error}</div>}
      <button className="btn btn-secondary" onClick={() => { setAlsoRetract(true); setConfirm(true); }} disabled={busy}>
        Hide this persona
      </button>

      {confirm && showRetractPrompt && (
        <Modal>
          <div className="card" style={{ padding: 20 }}>
            <h3 style={{ marginTop: 0, marginBottom: 8 }}>Hide this persona?</h3>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
              <Icon name="alertTriangle" size={14} className="icon-inline" />This persona has a public Nostr profile. Hiding it from your carousel doesn't take down the kind-0 on the relay.
            </p>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.9rem', marginBottom: 16 }}>
              <input
                type="checkbox"
                checked={alsoRetract}
                onChange={e => setAlsoRetract(e.target.checked)}
                style={{ marginTop: 3 }}
                disabled={busy}
              />
              <span>Also ask the relay to delete the public profile</span>
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-secondary"
                onClick={() => setConfirm(false)}
                disabled={busy}
                style={{ flex: 1 }}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => { void handleHide(); }}
                disabled={busy}
                style={{ flex: 1 }}
              >
                {busy ? 'Hiding…' : 'Hide'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {confirm && !showRetractPrompt && (
        <ConfirmModal
          heading="Hide this persona?"
          body={`Signet will hide "${displayName}" from the carousel and pickers. You can show it again from Settings → Personas.`}
          confirmLabel={busy ? 'Hiding…' : 'Hide'}
          confirmKind="primary"
          busy={busy}
          onCancel={() => setConfirm(false)}
          onConfirm={() => { void handleHide(); }}
        />
      )}
    </div>
  );
}

function DeleteBlock({
  pubkey,
  displayName,
  onDeletePersona,
}: {
  pubkey: string;
  displayName: string;
  onDeletePersona: NonNullable<PersonaAdvancedProps['onDeletePersona']>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleDelete() {
    setBusy(true);
    setError('');
    try {
      await onDeletePersona(pubkey);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }

  return (
    <div className="card section" style={{ borderColor: 'var(--danger)' }}>
      <div className="section-title" style={{ color: 'var(--danger)' }}>Delete persona</div>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
        Permanently remove "{displayName}" from this identity. If you've signed
        events with this keypair, those events stay on the relay — Signet can't
        retract them. You usually want <strong>Hide</strong> instead.
      </p>
      {error && <div role="alert" style={alertStyle('danger')}>{error}</div>}
      <button className="btn btn-danger" onClick={() => setConfirm(true)} disabled={busy}>
        Delete persona
      </button>

      {confirm && (
        <ConfirmModal
          heading="Delete this persona?"
          body={`This permanently removes "${displayName}" from your identity. Past events signed with this keypair stay on relays.`}
          confirmLabel={busy ? 'Deleting…' : 'Delete'}
          confirmKind="danger"
          busy={busy}
          onCancel={() => setConfirm(false)}
          onConfirm={() => { void handleDelete(); }}
        />
      )}
    </div>
  );
}

function DepSettingsBlock({
  dep,
  onChangeAutonomyStage,
  onChangeActivityVisibility,
  onChangePetitionOnDeny,
  onRemoveDependant,
  contactsLoading,
}: {
  dep: DependantIdentity;
  onChangeAutonomyStage?: PersonaAdvancedProps['onChangeAutonomyStage'];
  onChangeActivityVisibility?: PersonaAdvancedProps['onChangeActivityVisibility'];
  onChangePetitionOnDeny?: PersonaAdvancedProps['onChangePetitionOnDeny'];
  onRemoveDependant?: PersonaAdvancedProps['onRemoveDependant'];
  contactsLoading: boolean;
}) {
  const [stageBusy, setStageBusy] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [petitionBusy, setPetitionBusy] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [contactsChoice, setContactsChoice] = useState<DependantContactsChoice | null>(null);
  const [error, setError] = useState('');

  const auditVisibility = dep.auditVisibility ?? 'default';
  const visibilityResolved = resolveAuditVisibility(dep.autonomyStage, auditVisibility);

  async function changeStage(stage: AutonomyStage) {
    if (!onChangeAutonomyStage) return;
    setStageBusy(true);
    setError('');
    try {
      await onChangeAutonomyStage(stage);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change autonomy stage.');
    } finally {
      setStageBusy(false);
    }
  }

  async function changeVisibility(value: 'default' | 'force-visible' | 'force-hidden') {
    if (!onChangeActivityVisibility) return;
    setVisibilityBusy(true);
    setError('');
    try {
      await onChangeActivityVisibility(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change visibility.');
    } finally {
      setVisibilityBusy(false);
    }
  }

  async function changePetition(on: boolean) {
    if (!onChangePetitionOnDeny) return;
    setPetitionBusy(true);
    setError('');
    try {
      await onChangePetitionOnDeny(on);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change petitions.');
    } finally {
      setPetitionBusy(false);
    }
  }

  async function handleRemove() {
    if (!onRemoveDependant || contactsChoice === null) return;
    setRemoveBusy(true);
    setError('');
    try {
      await onRemoveDependant(contactsChoice);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed.');
    } finally {
      setRemoveBusy(false);
      setRemoveConfirm(false);
    }
  }

  return (
    <>
      {error && <div role="alert" style={alertStyle('danger')}>{error}</div>}

      {onChangeAutonomyStage && (
        <div className="card section">
          <div className="section-title">Signing autonomy</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
            How much signing authority {dep.displayName} has on their own device.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(Object.keys(AUTONOMY_STAGE_INFO) as AutonomyStage[]).map(stage => (
              <button
                key={stage}
                className={`btn ${dep.autonomyStage === stage ? 'btn-tile-selected' : 'btn-secondary'}`}
                onClick={() => { void changeStage(stage); }}
                disabled={stageBusy}
                style={{ padding: '10px 16px', textAlign: 'left', justifyContent: 'flex-start' }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{AUTONOMY_STAGE_INFO[stage].label}</div>
                  <div style={{ fontSize: '0.8rem', fontWeight: 400, opacity: 0.8 }}>{AUTONOMY_STAGE_INFO[stage].description}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {onChangeActivityVisibility && (
        <div className="card section">
          <div className="section-title">Activity visibility</div>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.5 }}>
            {visibilityResolved
              ? `Currently visible to ${dep.displayName} on their paired device.`
              : `Currently hidden from ${dep.displayName}.`}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {([
              { value: 'default', label: 'Use default for autonomy stage' },
              { value: 'force-visible', label: `Always visible to ${dep.displayName}` },
              { value: 'force-hidden', label: `Never visible to ${dep.displayName}` },
            ] as Array<{ value: 'default' | 'force-visible' | 'force-hidden'; label: string }>).map(opt => (
              <button
                key={opt.value}
                className={`btn ${auditVisibility === opt.value ? 'btn-tile-selected' : 'btn-secondary'}`}
                onClick={() => { void changeVisibility(opt.value); }}
                disabled={visibilityBusy}
                style={{ padding: '8px 12px', textAlign: 'left', justifyContent: 'flex-start', fontSize: '0.85rem' }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {onChangePetitionOnDeny && (
        <div className="card section">
          <div className="section-title">Petitions</div>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.5 }}>
            When the Heartwood refuses something outside {dep.displayName}'s rules, raise a “Family asks” petition on your phone
            instead of failing silently. Off by default.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {([
              { value: false, label: 'Refuse quietly' },
              { value: true, label: `Ask me when ${dep.displayName} is refused` },
            ] as Array<{ value: boolean; label: string }>).map(opt => (
              <button
                key={String(opt.value)}
                className={`btn ${(dep.petitionOnDeny === true) === opt.value ? 'btn-tile-selected' : 'btn-secondary'}`}
                onClick={() => { void changePetition(opt.value); }}
                disabled={petitionBusy}
                style={{ padding: '8px 12px', textAlign: 'left', justifyContent: 'flex-start', fontSize: '0.85rem' }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {onRemoveDependant && (
        <div className="card section" style={{ borderColor: 'var(--danger)' }}>
          <div className="section-title" style={{ color: 'var(--danger)' }}>Remove dependant</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
            Remove {dep.displayName} from this identity. Their keypair stays valid
            on relays (past events aren't retracted), but Signet stops managing
            them on this device.
          </p>
          <div className="section-title" style={{ marginTop: 12 }}>{DEPENDANT_CONTACTS_SECTION_TITLE}</div>
          {(['delete', 'archive'] as DependantContactsChoice[]).map(choice => (
            <button
              key={choice}
              className={`btn ${contactsChoice === choice ? 'btn-tile-selected' : 'btn-secondary'}`}
              style={{ width: '100%', marginBottom: 6, textAlign: 'left', justifyContent: 'flex-start' }}
              onClick={() => setContactsChoice(choice)}
            >
              {choice === 'delete' ? DELETE_CONTACTS_LABEL : ARCHIVE_CONTACTS_LABEL}
            </button>
          ))}
          <p className="field-hint">
            {contactsLoading
              ? REMOVE_DEPENDANT_CONTACTS_LOADING_COPY
              : contactsChoice === 'archive'
                ? removalChoiceCopy(dep.displayName).archiveLine
                : removalChoiceCopy(dep.displayName).deleteLine}
          </p>

          <button
            className="btn btn-danger"
            onClick={() => setRemoveConfirm(true)}
            disabled={removeBusy || contactsChoice === null || contactsLoading}
          >
            Remove {dep.displayName}
          </button>

          {removeConfirm && (
            <ConfirmModal
              heading={`Remove ${dep.displayName}?`}
              body={`Signet will stop managing ${dep.displayName} on this device. ${
                contactsChoice === 'archive'
                  ? removalChoiceCopy(dep.displayName).archiveLine
                  : removalChoiceCopy(dep.displayName).deleteLine
              }`}
              confirmLabel={removeBusy ? 'Removing…' : 'Remove'}
              confirmKind="danger"
              busy={removeBusy || contactsLoading}
              onCancel={() => setRemoveConfirm(false)}
              onConfirm={() => { void handleRemove(); }}
            />
          )}
        </div>
      )}
    </>
  );
}

// ─── Modal primitives ─────────────────────────────────────────────────────

function Modal({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0,
        background: 'var(--scrim)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 16,
      }}
    >
      <div style={{ maxWidth: 480, width: '100%' }}>{children}</div>
    </div>
  );
}

function ConfirmModal({
  heading,
  body,
  confirmLabel,
  confirmKind,
  busy,
  onCancel,
  onConfirm,
}: {
  heading: string;
  body: string;
  confirmLabel: string;
  confirmKind: 'primary' | 'danger';
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal>
      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>{heading}</h3>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 16 }}>
          {body}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={onCancel} disabled={busy} style={{ flex: 1 }}>
            Cancel
          </button>
          <button
            className={confirmKind === 'danger' ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
            disabled={busy}
            style={{ flex: 1 }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function alertStyle(kind: 'danger' | 'info'): React.CSSProperties {
  if (kind === 'danger') {
    return {
      padding: '10px 12px',
      background: 'var(--danger-light)',
      color: 'var(--danger)',
      borderRadius: 'var(--radius-sm)',
      fontSize: '0.85rem',
      marginBottom: 12,
    };
  }
  return {
    padding: '10px 12px',
    background: 'var(--info-light, var(--accent-light))',
    color: 'var(--info, var(--accent-text))',
    borderRadius: 'var(--radius-sm)',
    fontSize: '0.85rem',
    marginBottom: 12,
  };
}
