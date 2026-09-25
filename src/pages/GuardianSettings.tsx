import { useState, useEffect, useRef } from 'react';
import type { DependantIdentity, AutonomyStage, TrustedAppPairing, ContactCeilingTier } from '../types';
import { TRUSTED_APP_PAIRING_CAP } from '../types';
import { shortNpub } from '../lib/signet';
import { computeAge, formatDateOfBirth } from '../lib/date-utils';
import type { AuditVisibilityOverride } from '../lib/audit-visibility';
import { UpdateStatusLine } from '../components/UpdateStatusLine';
import { resolveDependantRealIdentityRow } from '../lib/real-identity-row';
import type { ContactPolicy } from '../lib/lift-child-settings';
import { DEFAULT_CHILD_CEILING_SECTION_TITLE, defaultChildCeilingCopy, tierChipLabel } from '../lib/contacts-v2-copy';

const TIER_LABELS: Record<string, string> = {
  basic: 'Basic',
  standard: 'Standard',
  expert: 'Expert',
};

interface Props {
  activeDependant: DependantIdentity;
  onUpdateDependantName?: (name: string) => Promise<void>;
  /**
   * Autonomy stage handler. Kept on the interface (Phase 2 transitional) —
   * the stage selector UI moved to PersonaAdvanced's DepSettingsBlock. App.tsx
   * routes the call from there through the existing handler so the underlying
   * persistence path is unchanged.
   */
  onUpdateAutonomyStage?: (stage: AutonomyStage) => Promise<void>;
  onBeginCeremony?: () => void;
  /** Open the dependant real-identity activation ceremony. Guardian mode only;
   *  omit on the paired-child surface. */
  onActivateDependantRealIdentity?: () => void;
  /** Opens the pair-to-device screen (phone-as-family-bunker). */
  onPairDevice?: () => void;
  /** Opens the pair-an-app screen for trusted-app pairings. */
  onPairApp?: () => void;
  /** Opens the per-dependant audit log (v1). */
  onViewActivity?: () => void;
  /**
   * Audit-visibility override — kept on the interface (Phase 2 transitional).
   * The selector UI moved to PersonaAdvanced's DepSettingsBlock. Read-only here.
   */
  auditVisibility?: AuditVisibilityOverride;
  /** Persist a new audit-visibility override — handler stays for Phase 2F rewire. */
  onChangeAuditVisibility?: (override: AuditVisibilityOverride) => Promise<void> | void;
  /**
   * Read-only view of trusted-app pairings for this dependant. Wired up
   * by the parent via `db.listAppBunkerPairings`. Shown as a list with
   * Revoke buttons in the "Connected apps" section.
   */
  appPairings?: TrustedAppPairing[];
  /** Revoke a trusted-app pairing by its NIP-46 client pubkey. */
  onRevokeAppPairing?: (clientPubkey: string) => Promise<void>;
  onSwitchDependantPrimary: (keypair: string) => void;
  onUpdateDependantPersonaName?: (target: 'natural-person' | 'persona' | string, name: string) => Promise<void>;
  onAddDependantPersona?: (displayName: string) => Promise<void>;
  /* Avatar Set/Change/Remove for dep personas moved to the carousel
     SettingsCard. The dep slot's `avatarHash` is still edited
     via `useDependants.setDependantPersonaAvatar` — just from the carousel
     surface, not this page. */
  /**
   * Toggle paired-device visibility for a persona. `pubkey` is the persona's
   * publicKey; `visible` is the new desired state. NP is never passed here.
   * Only rendered when a child device is paired and the caller wires the prop.
   */
  onUpdatePersonaVisibility?: (pubkey: string, visible: boolean) => Promise<void>;
  guardianHasMnemonic?: boolean;
  /** Tier 1 auth gate — required before autonomy stage changes. */
  requestAuth: () => Promise<string | null>;
  /** Owner's (guardian's) verification tier — mirrored read-only for the dependant. */
  ownerTier: string;
  /** Photo row in Profile — navigate to photo capture. */
  onUpdatePhoto: () => void;
  /** Current contact policy for this dependant. */
  currentContactPolicy: ContactPolicy;
  contactPolicyConflicted?: boolean;
  /** Persist a new contact policy (auth gate applied by caller). */
  onUpdateContactPolicy: (policy: ContactPolicy) => Promise<void> | void;
  /** Ceiling applied to contacts the dependant adds themselves. */
  currentDefaultChildCeiling: ContactCeilingTier;
  /** Persist a new default child ceiling (auth gate applied by caller). */
  onUpdateDefaultChildCeiling: (ceiling: ContactCeilingTier) => Promise<void> | void;
  /** 'guardian' = owner managing dependant; 'child' = dependant on a paired/handed-over device */
  viewer: 'guardian' | 'child';
  /**
   * Optional persona target to focus + start editing on mount. Pass
   * `'natural-person'`, `'persona'`, or an extra-persona pubkey hex.
   * GuardianSettings scrolls the personas section into view and seeds
   * the name editor in one shot, then calls `onConsumeFocus` so the
   * caller can clear the request (single-shot — re-mounts shouldn't
   * re-trigger). Used by the carousel SettingsCard to deep-link
   * directly to the right editor instead of dropping the user at the
   * top of the dep profile.
   */
  startEditPersona?: string | null;
  /** Called once `startEditPersona` has been consumed. */
  onConsumeFocus?: () => void;
}

/**
 * Thin overview of a dependant. Per-persona kind-0 profile editing (picture,
 * banner, NIP-05, etc.) lives on the dep persona's carousel `SettingsCard` —
 * that is the single source of truth. This page hosts the dep-level controls
 * that don't belong on any one persona: dep name + DOB, photo, phone pairing,
 * activity, connected apps, contact policy, verification, backup, and the
 * independence ceremony.
 */
export function GuardianSettings({
  activeDependant,
  onUpdateDependantName,
  onBeginCeremony,
  onActivateDependantRealIdentity,
  onPairDevice,
  onPairApp,
  onViewActivity,
  appPairings,
  onRevokeAppPairing,
  // Kept on the prop interface (Phase 2 transitional) — the Switch buttons
  // moved to PersonaAdvanced. Prefixed `_` to silence TS6133 while leaving
  // the type contract intact for Phase 2F rewiring.
  onSwitchDependantPrimary: _onSwitchDependantPrimary,
  onUpdateDependantPersonaName,
  onAddDependantPersona,
  onUpdatePersonaVisibility,
  guardianHasMnemonic,
  // The only caller of `requestAuth` in this file was removed along with the
  // Backup section (spec §7.7). Kept on the prop interface since
  // autonomy-stage gating may move back here; prefixed `_` to silence
  // TS6133, same pattern as `onSwitchDependantPrimary` above.
  requestAuth: _requestAuth,
  ownerTier,
  onUpdatePhoto,
  currentContactPolicy,
  contactPolicyConflicted,
  onUpdateContactPolicy,
  currentDefaultChildCeiling,
  onUpdateDefaultChildCeiling,
  viewer,
  startEditPersona,
  onConsumeFocus,
}: Props) {
  const realIdentityRow = resolveDependantRealIdentityRow(activeDependant);
  const personasSectionRef = useRef<HTMLDivElement | null>(null);
  // Name editing state (persona names)
  const [editingName, setEditingName] = useState<'natural-person' | 'persona' | string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState('');

  // Add persona state
  const [showAddPersona, setShowAddPersona] = useState(false);
  const [newPersonaName, setNewPersonaName] = useState('');
  const [addPersonaSaving, setAddPersonaSaving] = useState(false);
  const [addPersonaError, setAddPersonaError] = useState('');

  // Dependant profile editing state
  const [editingDependantName, setEditingDependantName] = useState(false);
  const [dependantNameDraft, setDependantNameDraft] = useState('');
  const [dependantNameSaving, setDependantNameSaving] = useState(false);
  const [dependantNameError, setDependantNameError] = useState('');

  // M8/N4: busy guard on the default-child-ceiling buttons — without it a
  // double-tap fires `onUpdateDefaultChildCeiling` (an auth-gated save)
  // twice, i.e. two auth prompts and two writes for one tap. `ceilingBusy`
  // (state) drives the `disabled` attribute for the render; `ceilingBusyRef`
  // is the actual guard, set SYNCHRONOUSLY before the first `await` — two
  // clicks landing in the same React batch (before the `setCeilingBusy(true)`
  // re-render has committed) would otherwise both read the same stale
  // `false` off the state closure and both fire.
  const policyBusyRef = useRef(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [contactSettingsError, setContactSettingsError] = useState('');
  async function handleUpdateContactPolicy(policy: ContactPolicy) {
    if (policyBusyRef.current) return;
    policyBusyRef.current = true;
    setPolicyBusy(true);
    setContactSettingsError('');
    try {
      await onUpdateContactPolicy(policy);
    } catch (error) {
      setContactSettingsError(error instanceof Error ? error.message : 'Could not save contact policy. Try again.');
    } finally {
      policyBusyRef.current = false;
      setPolicyBusy(false);
    }
  }
  const ceilingBusyRef = useRef(false);
  const [ceilingBusy, setCeilingBusy] = useState(false);
  async function handleUpdateDefaultChildCeiling(ceiling: ContactCeilingTier) {
    if (ceilingBusyRef.current) return;
    ceilingBusyRef.current = true;
    setCeilingBusy(true);
    setContactSettingsError('');
    try {
      await onUpdateDefaultChildCeiling(ceiling);
    } catch (error) {
      setContactSettingsError(error instanceof Error ? error.message : 'Could not save contact ceiling. Try again.');
    } finally {
      ceilingBusyRef.current = false;
      setCeilingBusy(false);
    }
  }

  // Deep-link entry from the carousel SettingsCard. When
  // `startEditPersona` arrives, scroll the personas section into view and
  // seed the inline name editor with the right target. Single-shot — we
  // call `onConsumeFocus` so the parent can clear the request and a
  // remount doesn't re-trigger the auto-edit on subsequent renders.
  useEffect(() => {
    if (!startEditPersona) return;
    let target: 'natural-person' | 'persona' | string;
    let currentName: string;
    if (startEditPersona === 'natural-person') {
      target = 'natural-person';
      currentName = activeDependant.naturalPerson.displayName;
    } else if (startEditPersona === 'persona') {
      target = 'persona';
      currentName = activeDependant.persona.displayName;
    } else {
      const ep = activeDependant.extraPersonas?.find(e => e.publicKey === startEditPersona);
      if (!ep) {
        // Unknown target — likely a stale focus request after the persona
        // was removed. Drop it silently.
        onConsumeFocus?.();
        return;
      }
      target = ep.publicKey;
      currentName = ep.displayName;
    }
    setEditingName(target);
    setNameDraft(currentName);
    setNameError('');
    onConsumeFocus?.();
    // Defer the scroll so the editor input mounts first; otherwise
    // scrollIntoView may target a node that's about to grow.
    requestAnimationFrame(() => {
      personasSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [startEditPersona, activeDependant, onConsumeFocus]);

  function startEditName(target: 'natural-person' | 'persona' | string, currentName: string) {
    setEditingName(target);
    setNameDraft(currentName);
    setNameError('');
  }

  function cancelEditName() {
    setEditingName(null);
    setNameDraft('');
    setNameError('');
  }

  async function saveNameEdit() {
    if (!editingName || !nameDraft.trim()) return;
    const trimmed = nameDraft.trim();
    if (trimmed.length > 100) {
      setNameError('Name must be 100 characters or fewer.');
      return;
    }

    setNameSaving(true);
    setNameError('');

    try {
      if (onUpdateDependantPersonaName) {
        await onUpdateDependantPersonaName(editingName, trimmed);
        setEditingName(null);
        setNameDraft('');
        return;
      }
    } catch {
      setNameError('Failed to save name. Please try again.');
    } finally {
      setNameSaving(false);
    }
  }

  async function handleAddPersona() {
    const trimmed = newPersonaName.trim();
    if (!trimmed) return;
    if (trimmed.length > 100) {
      setAddPersonaError('Name must be 100 characters or fewer.');
      return;
    }

    setAddPersonaSaving(true);
    setAddPersonaError('');

    try {
      if (onAddDependantPersona) {
        await onAddDependantPersona(trimmed);
      }
      setShowAddPersona(false);
      setNewPersonaName('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAddPersonaError(`Failed to add persona: ${msg}`);
    } finally {
      setAddPersonaSaving(false);
    }
  }

  async function saveDependantName() {
    const trimmed = dependantNameDraft.trim();
    if (!trimmed) return;
    if (trimmed.length > 100) {
      setDependantNameError('Name must be 100 characters or fewer.');
      return;
    }
    setDependantNameSaving(true);
    setDependantNameError('');
    try {
      await onUpdateDependantName?.(trimmed);
      setEditingDependantName(false);
      setDependantNameDraft('');
    } catch {
      setDependantNameError('Failed to save name. Please try again.');
    } finally {
      setDependantNameSaving(false);
    }
  }

  /** Inline name editor, used for both NP and persona rows */
  function NameEditor({ label }: { label: string }) {
    return (
      <div style={{ marginTop: 8 }}>
        <input
          className="input"
          value={nameDraft}
          onChange={e => { setNameDraft(e.target.value); setNameError(''); }}
          placeholder={label}
          maxLength={100}
          autoFocus
          disabled={nameSaving}
          onKeyDown={e => { if (e.key === 'Enter') { void saveNameEdit(); } if (e.key === 'Escape') cancelEditName(); }}
        />
        {nameError && (
          <p style={{ fontSize: '0.8rem', color: 'var(--danger)', marginTop: 4 }}>{nameError}</p>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" onClick={() => { void saveNameEdit(); }} disabled={!nameDraft.trim() || nameSaving} style={{ flex: 1 }}>
            {nameSaving ? 'Saving...' : 'Save'}
          </button>
          <button className="btn btn-ghost" onClick={cancelEditName} disabled={nameSaving} style={{ flex: 1 }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" role="main">
      {/* §6.2 §1 — Profile */}
      <div className="card section">
        <div className="section-title">Profile</div>

        {/* Name */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 4 }}>Name</div>
          {viewer === 'child' || !editingDependantName ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ fontWeight: 600 }}>{activeDependant.displayName || '(not set)'}</div>
              {viewer === 'guardian' && (
                <button
                  className="btn btn-secondary"
                  onClick={() => { setEditingDependantName(true); setDependantNameDraft(activeDependant.displayName); setDependantNameError(''); }}
                  style={{ flexShrink: 0, padding: '4px 12px', fontSize: '0.85rem' }}
                >
                  Edit
                </button>
              )}
            </div>
          ) : (
            <div>
              <input
                className="input"
                value={dependantNameDraft}
                onChange={e => { setDependantNameDraft(e.target.value); setDependantNameError(''); }}
                placeholder="Dependant's name"
                maxLength={100}
                autoFocus
                disabled={dependantNameSaving}
                onKeyDown={e => { if (e.key === 'Enter') { void saveDependantName(); } if (e.key === 'Escape') { setEditingDependantName(false); setDependantNameDraft(''); } }}
              />
              {dependantNameError && (
                <p style={{ fontSize: '0.8rem', color: 'var(--danger)', marginTop: 4 }}>{dependantNameError}</p>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn btn-primary" onClick={() => { void saveDependantName(); }} disabled={!dependantNameDraft.trim() || dependantNameSaving} style={{ flex: 1 }}>
                  {dependantNameSaving ? 'Saving...' : 'Save'}
                </button>
                <button className="btn btn-ghost" onClick={() => { setEditingDependantName(false); setDependantNameDraft(''); setDependantNameError(''); }} disabled={dependantNameSaving} style={{ flex: 1 }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Date of birth & Age — only if guardian provided DOB */}
        {activeDependant.dateOfBirth && (
          <>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 4 }}>Date of birth</div>
              <div style={{ fontWeight: 600 }}>{formatDateOfBirth(activeDependant.dateOfBirth)}</div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 4 }}>Age</div>
              <div style={{ fontWeight: 600 }}>{computeAge(activeDependant.dateOfBirth)} years old</div>
            </div>
          </>
        )}

        {/* Photo row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: '0.9rem' }}>Photo</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onUpdatePhoto}
          >
            {activeDependant.photoHash ? 'Change ›' : 'Set ›'}
          </button>
        </div>
      </div>

      {/* §6.2 §2 — Phone & Pairing (guardian-only). The paired-or-not signal
       is `authorizedClientPubkey`, NOT the presence of `bunkerEndpoint` —
       the latter is minted on first pair attempt and persists even when the
       kid's device never completed the handshake. See SettingsCard.tsx
       for the same check on the carousel col-2 chip. */}
      {viewer === 'guardian' && onPairDevice && (
        <div className="card section">
          <div className="section-title">Phone &amp; Pairing</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
            {activeDependant.bunkerEndpoint?.authorizedClientPubkey
              ? `${activeDependant.displayName}'s device is paired. Generate a new code to pair another, or revoke the current pairing.`
              : `Pair a phone or tablet for ${activeDependant.displayName}. Sign-ins from their device come to you for approval.`}
          </p>
          <button
            className="btn btn-secondary"
            onClick={onPairDevice}
          >
            {activeDependant.bunkerEndpoint?.authorizedClientPubkey ? 'Manage pairing' : 'Pair a device'}
          </button>
        </div>
      )}

      {/* Activity — guardian-side audit log of dependant signing decisions
          (v1). Sits next to "Connected apps" because
          both belong to the same "what's happening with this dependant"
          cluster. The audit log itself lives in src/pages/Activity.tsx.
          The visibility toggle (v2) moved to PersonaAdvanced's
          DepSettingsBlock per the Phase 2 redesign. */}
      {viewer === 'guardian' && onViewActivity && (
        <div className="card section">
          <div className="section-title">Activity</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
            See sign-ins, signing requests, and other actions taken on {activeDependant.displayName}'s behalf.
          </p>
          <button className="btn btn-secondary" onClick={onViewActivity}>
            View activity
          </button>
        </div>
      )}

      {/* Connected apps — trusted-app pairings per dependant. Distinct
          from the device pairing above; up to TRUSTED_APP_PAIRING_CAP slots. */}
      {viewer === 'guardian' && onPairApp && (
        <div className="card section">
          <div className="section-title">Connected apps</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
            Apps that act as {activeDependant.displayName} (e.g. Fathom). Up to {TRUSTED_APP_PAIRING_CAP} at a time.
            Separate from {activeDependant.displayName}'s own device pairing.
          </p>
          {(appPairings ?? []).length > 0 && (
            <div style={{ marginBottom: 12 }}>
              {(appPairings ?? []).map((p) => {
                const lastSeen = p.lastSeenAt ?? p.pairedAt;
                const when = new Date(lastSeen * 1000);
                const sameDay = when.toDateString() === new Date().toDateString();
                const dateStr = sameDay
                  ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  : when.toLocaleDateString();
                const subtitle = p.lastSeenAt
                  ? `${p.origin ?? 'unknown origin'} — last seen ${dateStr}`
                  : `${p.origin ?? 'unknown origin'} — paired ${dateStr}`;
                return (
                  <div
                    key={p.clientPubkey}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 0',
                      borderTop: '1px solid var(--border)',
                      gap: 8,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: '0.9rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.label || 'App'}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {subtitle}
                      </div>
                    </div>
                    {onRevokeAppPairing && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => { void onRevokeAppPairing(p.clientPubkey); }}
                        style={{ flexShrink: 0 }}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <button className="btn btn-secondary" onClick={onPairApp}>
            Pair an app
          </button>
        </div>
      )}

      {/* §6.2 §3 — Signing autonomy moved to PersonaAdvanced > DepSettingsBlock
          per the Phase 2 redesign (consequential per-dep actions live on the
          cog page for the dep's NP slot). */}

      {/* §6.2 §4 — Personas (guardian-only). Thin list view — per-persona
          kind-0 profile fields (picture, banner, NIP-05, etc.) and the
          encrypted in-app avatar live on the carousel SettingsCard.
          This page only hosts what doesn't fit on a single persona: the
          list, rename + visibility per row, and "Add persona". */}
      {viewer === 'guardian' && (
      <div className="card section" ref={personasSectionRef}>
        <div className="section-title">{activeDependant.displayName}&rsquo;s Identity</div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
          {activeDependant.displayName}&rsquo;s personas. Tap a name to rename. To edit a persona&rsquo;s public profile, open it from the carousel.
        </p>

        {/* Real identity row — rendered only once activated (spec §7.6). A
            dormant slot has no name to show and must not be renameable from
            here; the row below offers the activation ceremony instead. */}
        {realIdentityRow === 'active' && (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: '10px 14px',
                borderRadius: 10,
                background: activeDependant.primaryKeypair === 'natural-person' ? 'var(--accent-light)' : 'var(--bg-secondary)',
                border: `1px solid ${activeDependant.primaryKeypair === 'natural-person' ? 'var(--accent)' : 'var(--border)'}`,
                marginBottom: 8,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                    {activeDependant.naturalPerson.displayName || 'Real identity'}
                    {activeDependant.primaryKeypair === 'natural-person' ? ' (active)' : ''}
                  </div>
                  {editingName !== 'natural-person' && (
                    <button className="btn btn-ghost" onClick={() => startEditName('natural-person', activeDependant.naturalPerson.displayName)} style={{ width: 'auto', padding: '2px 8px', fontSize: '0.75rem' }}>
                      Edit name
                    </button>
                  )}
                </div>
                <div style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginTop: 2 }}>
                  {shortNpub(activeDependant.naturalPerson.publicKey)}
                </div>
              </div>
            </div>
            {editingName === 'natural-person' && <NameEditor label="Name" />}
          </>
        )}

        {/* Dormant real identity — the ceremony lives on the guardian device
            only (spec §7.6 "who may activate"). */}
        {realIdentityRow === 'dormant' && (
          <div style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border)', marginBottom: 8 }}>
            <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Real identity — Not set up</div>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
              {activeDependant.displayName} signs as their persona. Add their legal name when something needs it.
            </p>
            {onActivateDependantRealIdentity && (
              <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={onActivateDependantRealIdentity}>
                Set up their real identity
              </button>
            )}
          </div>
        )}

        {/* No natural-person key at all (e.g. a view-only imported
            dependant) — read-only, mirrors the owner-identity analogue in
            Personas.tsx (spec §7.6): explain why activation isn't offered
            rather than rendering nothing. */}
        {realIdentityRow === 'unavailable' && (
          <div style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border)', marginBottom: 8 }}>
            <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Real identity — unavailable</div>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
              This dependant was imported without a real-identity key, so a real identity can&rsquo;t be added here.
            </p>
          </div>
        )}

        {/* Persona row */}
        {(() => {
          const depPersonaNpub = shortNpub(activeDependant.persona.publicKey);
          const showVisibilityToggle =
            viewer === 'guardian' &&
            !!activeDependant.bunkerEndpoint?.authorizedClientPubkey &&
            !!onUpdatePersonaVisibility &&
            !!activeDependant.persona.publicKey;
          const isHidden = activeDependant.hiddenOnPairedDeviceKeys?.includes(activeDependant.persona.publicKey) ?? false;
          return (
            <div
              style={{
                border: `1px solid ${activeDependant.primaryKeypair === 'persona' ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 10,
                background: activeDependant.primaryKeypair === 'persona' ? 'var(--accent-light)' : 'var(--bg-secondary)',
                padding: '10px 14px',
                marginBottom: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                      {activeDependant.persona.displayName || 'Persona'}{activeDependant.primaryKeypair === 'persona' ? ' (active)' : ''}
                    </div>
                    {editingName !== 'persona' && (
                      <button
                        className="btn btn-ghost"
                        onClick={() => startEditName('persona', activeDependant.persona.displayName)}
                        style={{ width: 'auto', padding: '2px 8px', fontSize: '0.75rem' }}
                      >
                        Edit name
                      </button>
                    )}
                  </div>
                  <div style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginTop: 2 }}>
                    {depPersonaNpub}
                  </div>
                  {showVisibilityToggle && (
                    <button
                      className={`btn ${isHidden ? 'btn-secondary' : 'btn-primary'}`}
                      onClick={() => {
                        void onUpdatePersonaVisibility!(activeDependant.persona.publicKey, isHidden);
                      }}
                      style={{ width: 'auto', padding: '4px 10px', fontSize: '0.78rem', marginTop: 6 }}
                    >
                      {isHidden ? 'Hidden from phone' : 'Visible on phone'}
                    </button>
                  )}
                </div>
              </div>
              {editingName === 'persona' && <NameEditor label="Persona name" />}
            </div>
          );
        })()}

        {/* Extra personas */}
        {(activeDependant.extraPersonas ?? []).map((extra) => {
          const extraNpub = shortNpub(extra.publicKey);
          const isEditing = editingName === extra.publicKey;
          const isActive = activeDependant.primaryKeypair === extra.publicKey;
          const showVisibilityToggle =
            viewer === 'guardian' &&
            !!activeDependant.bunkerEndpoint?.authorizedClientPubkey &&
            !!onUpdatePersonaVisibility;
          const isHidden = activeDependant.hiddenOnPairedDeviceKeys?.includes(extra.publicKey) ?? false;
          return (
            <div
              key={extra.publicKey}
              style={{
                border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 10,
                background: isActive ? 'var(--accent-light)' : 'var(--bg-secondary)',
                padding: '10px 14px',
                marginBottom: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                      {extra.displayName || 'Unnamed Persona'}{isActive ? ' (active)' : ''}
                    </div>
                    {!isEditing && (
                      <button
                        className="btn btn-ghost"
                        onClick={() => startEditName(extra.publicKey, extra.displayName)}
                        style={{ width: 'auto', padding: '2px 8px', fontSize: '0.75rem' }}
                      >
                        Edit name
                      </button>
                    )}
                  </div>
                  <div style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginTop: 2 }}>
                    {extraNpub}
                  </div>
                  {showVisibilityToggle && (
                    <button
                      className={`btn ${isHidden ? 'btn-secondary' : 'btn-primary'}`}
                      onClick={() => {
                        void onUpdatePersonaVisibility!(extra.publicKey, isHidden);
                      }}
                      style={{ width: 'auto', padding: '4px 10px', fontSize: '0.78rem', marginTop: 6 }}
                    >
                      {isHidden ? 'Hidden from phone' : 'Visible on phone'}
                    </button>
                  )}
                </div>
              </div>
              {isEditing && <NameEditor label="Persona name" />}
            </div>
          );
        })}

        {/* Add persona */}
        {guardianHasMnemonic && !showAddPersona && (
          <button
            className="btn btn-secondary"
            onClick={() => { setShowAddPersona(true); setNewPersonaName(''); setAddPersonaError(''); }}
            style={{ width: '100%', marginTop: 4 }}
          >
            + Add persona
          </button>
        )}
        {showAddPersona && (
          <div style={{ marginTop: 8, padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-secondary)' }}>
            <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 8 }}>New persona</div>
            <input
              className="input"
              value={newPersonaName}
              onChange={e => { setNewPersonaName(e.target.value); setAddPersonaError(''); }}
              placeholder="Persona name"
              maxLength={100}
              autoFocus
              disabled={addPersonaSaving}
              onKeyDown={e => { if (e.key === 'Enter') { void handleAddPersona(); } if (e.key === 'Escape') { setShowAddPersona(false); setNewPersonaName(''); } }}
            />
            {addPersonaError && (
              <p style={{ fontSize: '0.8rem', color: 'var(--danger)', marginTop: 4 }}>{addPersonaError}</p>
            )}
            <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 6 }}>
              A new anonymous identity for {activeDependant.displayName}. Its tier inherits from the natural person via the identity bridge.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" onClick={() => { void handleAddPersona(); }} disabled={!newPersonaName.trim() || addPersonaSaving} style={{ flex: 1 }}>
                {addPersonaSaving ? 'Adding...' : 'Add'}
              </button>
              <button className="btn btn-ghost" onClick={() => { setShowAddPersona(false); setNewPersonaName(''); setAddPersonaError(''); }} disabled={addPersonaSaving} style={{ flex: 1 }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      )}

      {/* §6.2 §5 — Contact policy (guardian-only) */}
      {viewer === 'guardian' && (
        <div className="card section">
          <div className="section-title">Contact policy</div>
          {contactSettingsError && <p role="alert">{contactSettingsError}</p>}
          {contactPolicyConflicted && <p role="alert">Two devices saved different contact decisions at the same time. Contact invitations are paused. Choose a policy to resolve this.</p>}
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            Who can contact {activeDependant.displayName}?
          </p>
          {(['kin-only', 'approved', 'open'] as const).map(policy => (
            <button
              key={policy}
              className={`btn ${currentContactPolicy === policy ? 'btn-tile-selected' : 'btn-secondary'}`}
              style={{ width: '100%', marginBottom: 6 }}
              disabled={policyBusy}
              onClick={() => { void handleUpdateContactPolicy(policy); }}
            >
              {policy === 'kin-only' ? 'Close circle only' : policy === 'approved' ? 'Approved contacts' : 'Open'}
            </button>
          ))}
          <p className="field-hint">
            Close circle only admits effective Kin. Approved admits anyone you have approved, whatever their tier.
            Open lets anyone ask; the request still waits for a decision. Blocked always denies.
          </p>
        </div>
      )}

      {viewer === 'guardian' && (
        <div className="card section">
          <div className="section-title">{DEFAULT_CHILD_CEILING_SECTION_TITLE}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['ken', 'kith', 'kin', 'none'] as ContactCeilingTier[]).map(ceiling => (
              <button
                key={ceiling}
                className={`btn ${currentDefaultChildCeiling === ceiling ? 'btn-primary' : 'btn-secondary'}`}
                disabled={ceilingBusy}
                onClick={() => { void handleUpdateDefaultChildCeiling(ceiling); }}
              >
                {tierChipLabel(ceiling)}
              </button>
            ))}
          </div>
          <p className="field-hint">{defaultChildCeilingCopy(activeDependant.displayName)}</p>
        </div>
      )}

      {/* §6.2 §6 — Verification (read-only mirror, guardian-only) */}
      {viewer === 'guardian' && (
        <div className="card section">
          <div className="section-title">Verification</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {TIER_LABELS[ownerTier] ?? ownerTier} — inherited from your verification tier.
          </p>
        </div>
      )}

      {/* §7.7 — Recovery. Read-only on BOTH surfaces. A guardian-managed
          dependant has no separate recovery secret: the words that restore
          them are the guardian's own, and those restore the guardian root and
          every identity under it. There is no button here by design. */}
      <div className="card section">
        <div className="section-title">Recovery</div>
        {viewer === 'child' ? (
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Your guardian holds recovery for this Signet.
          </p>
        ) : (
          <>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Part of your own recovery words.
            </p>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
              Restoring your Signet restores {activeDependant.displayName} too. Your own recovery words cover this — see Security settings.
            </p>
          </>
        )}
      </div>

      {viewer === 'child' && (
        <div className="card section">
          <div className="section-title">Real identity — ask your guardian</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Your real name is set up on the phone that looks after your account, not on this one.
          </p>
        </div>
      )}

      {/* §6.2 §8 — Independence ceremony — guardian-only, shown when dependant is 18+ (or always if no DOB) */}
      {viewer === 'guardian' && onBeginCeremony && (!activeDependant.dateOfBirth || computeAge(activeDependant.dateOfBirth) >= 18) && (
        <div className="card section">
          <div className="section-title">Independence</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
            {activeDependant.dateOfBirth
              ? `${activeDependant.displayName} is ${computeAge(activeDependant.dateOfBirth)} years old. You can now begin the ceremony to transition them to an independent Signet identity.`
              : `Begin the ceremony to transition ${activeDependant.displayName} to an independent Signet identity.`}
          </p>
          <button
            className="btn btn-secondary"
            onClick={onBeginCeremony}
          >
            Begin independence ceremony
          </button>
        </div>
      )}

      {/* §6.2 §9 — Remove dependant moved to PersonaAdvanced > DepSettingsBlock
          (dep NP slot's cog page) per the Phase 2 redesign. */}

      {/* About */}
      <div style={{ textAlign: 'center', marginTop: 32, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
        <div>MySignet v{__APP_VERSION__}{import.meta.env.DEV ? '-dev' : ''}</div>
        <UpdateStatusLine />
        {import.meta.env.DEV && (
          <div style={{ fontSize: '0.7rem', opacity: 0.7 }}>
            {__BUILD_TIME__.replace('T', ' ').slice(0, 16)} &middot; {__GIT_SHA__}
          </div>
        )}
        <div>Open source identity verification</div>
      </div>
    </div>
  );
}
