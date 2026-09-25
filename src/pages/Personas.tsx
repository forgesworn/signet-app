import { useEffect, useRef, useState } from 'react';
import type { SignetIdentity, AppPreferences } from '../types';
import { NpubRow } from '../components/NpubRow';
import { Icon } from '../components/Icon';
import { resolveRealIdentityRow } from '../lib/real-identity-row';
/* Avatar Set/Change/Remove moved to the carousel SettingsCard.
   This page now renders names + add/import only. The avatar fields on each
   slot are still edited via `useIdentity.setPersonaAvatar` — just from a
   different host surface. */

interface Props {
  identity: SignetIdentity;
  /**
   * Kept on the prop interface for Phase 2 transitional compatibility — the
   * Switch › buttons that called this directly moved to PersonaAdvanced. App.tsx
   * still passes the handler so Phase 2F can rewire from PersonaAdvanced through
   * the existing path. See 2026-05-17 design Appendix B.
   */
  onSwitchPrimary: (target: 'natural-person' | 'persona') => Promise<void>;
  onAddPersona: (displayName: string) => Promise<void>;
  /**
   * Update the display name for a persona on the guardian's own identity.
   * Target is `'natural-person'`, `'persona'`, or an extra persona's
   * pubkey hex. Optional — if absent, rename rows are hidden.
   */
  onUpdateName?: (target: 'natural-person' | 'persona' | string, name: string) => Promise<void>;
  /**
   * Optional persona target to focus + start editing on mount. Pass
   * `'natural-person'`, `'persona'`, or an extra-persona pubkey hex.
   * Single-shot — `onConsumeFocus` is called once consumed so a
   * re-mount doesn't re-trigger. Mirrors the dep-side deep-link
   * pattern in GuardianSettings.
   */
  startEditPersona?: string | null;
  /** Called once `startEditPersona` has been consumed. */
  onConsumeFocus?: () => void;
  /**
   * Phase C.3 — post-onboarding nsec import. Caller wraps the
   * `useIdentity.addImportedPersona` call + provides the user-facing
   * backup-confirmation flow. Returns the resulting outcome so the modal
   * can render slot-specific collision errors.
   */
  onImportNostrAccount?: (nsec: string, displayName: string) => Promise<
    | { added: true; pubkey: string }
    | { added: false; collision: string; collisionDisplayName?: string }
  >;
  /**
   * Paired-child surface: the kid's app is running this Personas page over a
   * dep identity their guardian set up. In this mode editing UI is suppressed
   * (read-only §6.6.11 framing). Defaults to false (user's own surface).
   */
  pairedChildView?: boolean;
  /**
   * Start real-identity activation. Absent on the paired-child surface and
   * whenever `resolveRealIdentityRow` says the slot is `'unavailable'`.
   */
  onActivateRealIdentity?: () => void;
  /** Open the natural-person card's Advanced page (activated slots only). */
  onOpenRealIdentityAdvanced?: () => void;
  signingMode?: AppPreferences['signingMode'];
  onManagePersona?: (target: string) => void;
  onOpenPersona?: (target: string) => void;
}

type EditTarget = 'natural-person' | 'persona' | string;

/**
 * Thin list view of the user's personas. Editing (kind-0 profile fields,
 * publish toggle, advanced actions) lives on the carousel `SettingsCard`
 * for each persona — that is the single source of truth. This page exists
 * so users can see all their personas at a glance, rename them, add new
 * ones, and import an existing Nostr account.
 */
export function Personas({
  identity,
  onAddPersona,
  onUpdateName,
  startEditPersona,
  onConsumeFocus,
  onImportNostrAccount,
  pairedChildView = false,
  onActivateRealIdentity,
  onOpenRealIdentityAdvanced,
  signingMode,
  onManagePersona,
  onOpenPersona,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState('');

  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState('');

  // Phase C.3 — post-onboarding nsec import modal state.
  const [importingNostr, setImportingNostr] = useState(false);
  const [importNsecInput, setImportNsecInput] = useState('');
  const [importDisplayName, setImportDisplayName] = useState('');
  const [importBackupConfirmed, setImportBackupConfirmed] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');

  function closeImport() {
    setImportingNostr(false);
    setImportNsecInput('');
    setImportDisplayName('');
    setImportBackupConfirmed(false);
    setImportError('');
  }

  async function handleImportNostrSubmit() {
    if (!onImportNostrAccount) return;
    if (!importNsecInput.trim().startsWith('nsec1')) {
      setImportError("Paste your nsec key. It starts with 'nsec1'.");
      return;
    }
    if (!importDisplayName.trim()) {
      setImportError('Pick a display name.');
      return;
    }
    if (!importBackupConfirmed) {
      setImportError('Confirm your nsec is backed up separately.');
      return;
    }
    setImportBusy(true);
    setImportError('');
    try {
      const result = await onImportNostrAccount(importNsecInput.trim(), importDisplayName.trim());
      if (result.added) {
        // Success — reset + close modal.
        setImportingNostr(false);
        setImportNsecInput('');
        setImportDisplayName('');
        setImportBackupConfirmed(false);
      } else {
        const slotName = result.collisionDisplayName ? `"${result.collisionDisplayName}"` : 'an existing slot';
        if (result.collision === 'natural-person') {
          setImportError(`This Nostr account is already your Natural Person key — edit it via Settings → Personas → Natural Person.`);
        } else if (result.collision === 'persona') {
          setImportError(`This Nostr account is already your default Persona — edit it via Settings → Personas → ${slotName}.`);
        } else if (result.collision === 'professional-persona') {
          setImportError(`This Nostr account is already your Professional Persona — edit it via Settings → Professional.`);
        } else if (result.collision === 'extra-imported') {
          setImportError(`This Nostr account is already imported as ${slotName}. Edit it via Settings → Personas.`);
        } else {
          setImportError(`This Nostr account is already one of your personas: ${slotName}. Edit it via Settings → Personas.`);
        }
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Could not import. Please try again.');
    } finally {
      setImportBusy(false);
    }
  }

  const editorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!startEditPersona) return;
    let target: EditTarget;
    let currentName: string;
    if (startEditPersona === 'natural-person') {
      target = 'natural-person';
      currentName = identity.naturalPerson.displayName;
    } else if (startEditPersona === 'persona') {
      target = 'persona';
      currentName = identity.persona.displayName;
    } else {
      const ep = identity.extraPersonas?.find(e => e.publicKey === startEditPersona);
      if (!ep) {
        onConsumeFocus?.();
        return;
      }
      target = ep.publicKey;
      currentName = ep.displayName;
    }
    setEditing(target);
    setNameDraft(currentName);
    setNameError('');
    onConsumeFocus?.();
    requestAnimationFrame(() => {
      editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [startEditPersona, identity, onConsumeFocus]);

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setAddError('');
    try {
      await onAddPersona(newName.trim());
      setNewName('');
      setAdding(false);
    } catch (err) {
      // In bunker mode (§11.1.8) the persona is derived on the Heartwood
      // signer, so "device off" / "no room left" are real, user-fixable
      // failures — they have to be shown, not swallowed as an unhandled
      // rejection. Same surfacing AddCard already does.
      setAddError(err instanceof Error && err.message ? err.message : 'Could not add persona. Try again.');
    } finally {
      setBusy(false);
    }
  };

  function startEdit(target: EditTarget, currentName: string) {
    setEditing(target);
    setNameDraft(currentName);
    setNameError('');
  }

  function cancelEdit() {
    setEditing(null);
    setNameDraft('');
    setNameError('');
  }

  async function saveEdit() {
    if (!editing || !onUpdateName) return;
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    if (trimmed.length > 100) {
      setNameError('Name must be 100 characters or fewer.');
      return;
    }
    setNameSaving(true);
    setNameError('');
    try {
      await onUpdateName(editing, trimmed);
      setEditing(null);
      setNameDraft('');
    } catch {
      setNameError('Failed to save name. Please try again.');
    } finally {
      setNameSaving(false);
    }
  }

  function isImportedExtra(target: EditTarget): boolean {
    if (target === 'natural-person' || target === 'persona') return false;
    const ep = identity.extraPersonas?.find(e => e.publicKey === target);
    return !!ep?.imported;
  }

  /** R10 — never render a dangling " · " when the persona has no display
      name; show the base label alone plus a muted "(unnamed)" hint. */
  function renderPersonaLabel(baseLabel: string, displayName: string) {
    if (displayName) {
      return <>{baseLabel} &middot; {displayName}</>;
    }
    return (
      <>
        {baseLabel} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(unnamed)</span>
      </>
    );
  }

  function renderNameRow(target: EditTarget, label: string) {
    if (editing === target) {
      return (
        <div className="row" ref={editorRef}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
            <input
              className="input input-sm"
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              maxLength={100}
              autoFocus
              disabled={nameSaving}
            />
            {nameError && (
              <div style={{ fontSize: '0.75rem', color: 'var(--danger)', marginTop: 4 }}>{nameError}</div>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button className="btn btn-ghost btn-sm" onClick={saveEdit} disabled={nameSaving || !nameDraft.trim()}>
                {nameSaving ? 'Saving…' : 'Save'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={cancelEdit} disabled={nameSaving}>Cancel</button>
            </div>
          </div>
        </div>
      );
    }
    return null;
  }

  function keyLocation(target: string): string {
    const slot = target === 'natural-person' ? identity.naturalPerson
      : target === 'persona' ? identity.persona
      : target === 'professional-persona' ? identity.professionalPersona
      : identity.extraPersonas?.find(persona => persona.publicKey === target);
    if (isImportedExtra(target)) return 'Imported key on this device · separate backup needed';
    if (!signingMode || signingMode === 'local') return 'Key stored on this device';
    if (identity.encrypted) return 'Unlock to check where this key is stored';
    if (slot?.privateKey) return 'Key stored on this device';
    if (signingMode === 'nip07') return target === 'natural-person'
      ? 'Key held by your browser extension' : 'Signing key unavailable on this device';
    return 'Key held by your paired signer';
  }

  function personaActions(target: string, pubkey: string, hidden = false) {
    return (
      <div style={{ padding: '0 16px 16px' }}>
        <NpubRow key={pubkey} pubkey={pubkey} />
        <p style={{ fontSize: '1rem', color: 'var(--text-secondary)' }}>{keyLocation(target)}</p>
        {hidden && <p>Hidden from your cards and sign-in choices.</p>}
        {!pairedChildView && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {onOpenPersona && !hidden && target !== 'professional-persona' && (
              <button type="button" className="btn btn-secondary btn-sm" style={{ width: 'auto' }} onClick={() => onOpenPersona(target)}>Open identity</button>
            )}
            {onManagePersona && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ width: 'auto' }} onClick={() => onManagePersona(target)}>Manage identity</button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="fade-in" role="main">
      <div className="block" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
        Each identity has its own public address (npub). Open an identity to use its card, or manage its profile, backup and visibility.
      </div>

      {/* Always rendered: `resolveRealIdentityRow` covers the no-key (nsec
          import) shape itself, with copy that says why activation is absent,
          so no outer key guard is needed here. */}
      <div className="card section">
        <div className="section-title">Real identity</div>
        {(() => {
          const state = resolveRealIdentityRow(identity);

          if (state === 'unavailable') {
            return (
              <>
                <div className="row">
                  <div className="row-main">
                    <span className="row-label" style={{ fontWeight: 600 }}>
                      Real identity — needs recovery words
                    </span>
                  </div>
                </div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
                  Identities imported from an nsec can&rsquo;t add a real identity. Restore from
                  recovery words to get one.
                </p>
              </>
            );
          }

          if (state === 'dormant') {
            return (
              <>
                <button
                  className="row"
                  onClick={onActivateRealIdentity}
                  disabled={!onActivateRealIdentity}
                  style={{ width: '100%', background: 'none', border: 'none', textAlign: 'left', padding: 0, cursor: onActivateRealIdentity ? 'pointer' : 'default' }}
                >
                  <div className="row-main">
                    <span className="row-label" style={{ fontWeight: 600 }}>
                      Real identity — Not set up ›
                    </span>
                    <span className="row-sub">Set it up when something needs your legal name</span>
                  </div>
                </button>
              </>
            );
          }

          return (
            <button
              className="row"
              onClick={onOpenRealIdentityAdvanced}
              disabled={!onOpenRealIdentityAdvanced}
              style={{ width: '100%', background: 'none', border: 'none', textAlign: 'left', padding: 0, cursor: onOpenRealIdentityAdvanced ? 'pointer' : 'default' }}
            >
              <div className="row-main">
                <span className="row-label" style={{ fontWeight: 600 }}>
                  Real identity — {identity.naturalPerson.displayName} ›
                </span>
                {identity.primaryKeypair === 'natural-person' && (
                  <span className="row-sub">Default identity</span>
                )}
              </div>
            </button>
          );
        })()}
        {renderNameRow('natural-person', 'Real identity name')}
        {resolveRealIdentityRow(identity) === 'active'
          && personaActions('natural-person', identity.naturalPerson.publicKey)}
      </div>

      <div className="card section">
        <div className="section-title">Anonymous keypairs</div>

        {identity.persona.publicKey && (<>
        <div className="row">
          <div className="row-main">
            <span className="row-label" style={{ fontWeight: 600 }}>
              {renderPersonaLabel('Default persona', identity.persona.displayName)}
            </span>
            {identity.primaryKeypair === 'persona' && (
              <span className="row-sub">Default identity</span>
            )}
          </div>
          {onUpdateName && editing !== 'persona' && !pairedChildView && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => startEdit('persona', identity.persona.displayName)}
            >
              Rename ›
            </button>
          )}
        </div>
        {renderNameRow('persona', 'Default persona name')}
        {personaActions('persona', identity.persona.publicKey)}
        </>)}

        {(identity.extraPersonas ?? []).map(extra => (
          <div key={extra.publicKey}>
            <div className="row">
              <div className="row-main">
                <span className="row-label" style={{ fontWeight: 600 }}>
                  {extra.displayName || 'Unnamed Persona'}
                  {isImportedExtra(extra.publicKey) && (
                    <span
                      style={{
                        marginLeft: 8,
                        padding: '2px 8px',
                        fontSize: '0.7rem',
                        background: 'var(--bg-secondary)',
                        color: 'var(--text-muted)',
                        border: '1px solid var(--border)',
                        borderRadius: 12,
                        fontWeight: 400,
                      }}
                      title="This Nostr account isn't derived from your Signet seed phrase. Make sure your nsec is backed up separately — Signet's recovery-words restore won't bring this persona back."
                    >
                      Imported — not in your seed phrase
                    </span>
                  )}
                </span>
              </div>
              {onUpdateName && editing !== extra.publicKey && !pairedChildView && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => startEdit(extra.publicKey, extra.displayName || '')}
                >
                  Rename ›
                </button>
              )}
            </div>
            {renderNameRow(extra.publicKey, 'Persona name')}
            {personaActions(extra.publicKey, extra.publicKey, extra.hidden)}
          </div>
        ))}

        {!pairedChildView && (
          adding ? (
            <>
              <div className="row">
                <input className="input input-sm" placeholder="Persona name" value={newName} onChange={e => setNewName(e.target.value)} maxLength={100} autoFocus disabled={busy} />
                <button className="btn btn-ghost btn-sm" onClick={handleAdd} disabled={busy || !newName.trim()}>{busy ? 'Adding…' : 'Add'}</button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setAdding(false); setNewName(''); setAddError(''); }} disabled={busy}>Cancel</button>
              </div>
              {addError && (
                <div style={{ fontSize: '0.75rem', color: 'var(--danger)', marginTop: 4 }}>{addError}</div>
              )}
            </>
          ) : (
            <>
              <button className="btn btn-secondary" onClick={() => setAdding(true)} style={{ width: '100%', marginTop: 8 }}>+ Add persona</button>
              {onImportNostrAccount && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setImportingNostr(true)}
                  style={{ width: '100%', marginTop: 6 }}
                >
                  Import an existing Nostr account
                </button>
              )}
            </>
          )
        )}
      </div>

      {identity.professionalPersona && (
        <div className="card section">
          <div className="section-title">Professional identity</div>
          <div className="row"><strong>{identity.professionalPersona.displayName}</strong></div>
          {personaActions('professional-persona', identity.professionalPersona.publicKey)}
        </div>
      )}

      {/* Phase C.3 — post-onboarding nsec import modal */}
      {importingNostr && onImportNostrAccount && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 2000,
            background: 'var(--scrim)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16,
          }}
          onClick={(e) => { if (e.target === e.currentTarget && !importBusy) closeImport(); }}
        >
          <div role="dialog" aria-modal="true" aria-label="Import an existing Nostr account" className="card section" style={{ maxWidth: 480, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ marginTop: 0, marginBottom: 8 }}>Import an existing Nostr account</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
              Paste your nsec key. We'll add it as a Persona alongside your existing personas.
            </p>

            {importError && (
              <div role="alert" style={{
                padding: '10px 12px',
                background: 'var(--danger-light)',
                color: 'var(--danger)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '0.85rem',
                marginBottom: 12,
              }}>{importError}</div>
            )}

            <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Nsec key</label>
            <textarea
              className="input"
              rows={2}
              placeholder="nsec1..."
              value={importNsecInput}
              onChange={e => setImportNsecInput(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', resize: 'none', marginTop: 4, marginBottom: 12 }}
              disabled={importBusy}
            />

            <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Display name</label>
            <input
              className="input"
              placeholder="What should we call this persona?"
              value={importDisplayName}
              onChange={e => setImportDisplayName(e.target.value)}
              maxLength={100}
              style={{ marginTop: 4, marginBottom: 14 }}
              disabled={importBusy}
            />

            <div className="card section" style={{ background: 'var(--danger-light)', borderColor: 'var(--danger)', marginBottom: 14 }}>
              <p style={{ fontSize: '0.85rem', lineHeight: 1.5, margin: '0 0 8px' }}>
                <Icon name="alertTriangle" size={14} className="icon-inline" /><strong>This Nostr account isn't derived from your Signet seed phrase.</strong>
              </p>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.5, margin: '0 0 10px' }}>
                If you lose this device and restore Signet from your recovery words, this imported persona won't come back — your normal Signet personas will, but this one is a separate keypair.
                Make sure you have your nsec backed up somewhere safe (a password manager, a written copy) before importing.
              </p>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.85rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={importBackupConfirmed}
                  onChange={e => setImportBackupConfirmed(e.target.checked)}
                  style={{ marginTop: 3 }}
                  disabled={importBusy}
                />
                <span>I've backed up my nsec separately.</span>
              </label>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={closeImport} disabled={importBusy} style={{ flex: 1 }}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={handleImportNostrSubmit}
                disabled={importBusy || !importBackupConfirmed || !importNsecInput.trim() || !importDisplayName.trim()}
                style={{ flex: 1 }}
              >
                {importBusy ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="block">
        Choose a separate persona for sites that don't need your real-name identity. Imported accounts need their own backup.
      </div>
    </div>
  );
}
