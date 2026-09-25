import { useState } from 'react';
import type { SignetIdentity } from '../types';
import type { CachedBadge } from '../lib/badge-fetch';
import { TierBadge } from '../components/TierBadge';

interface Props {
  identity: SignetIdentity;
  onUpdateName: (name: string) => Promise<void>;
  onUpdatePhoto: () => void;
  ownBadge: CachedBadge | null;
  connectedSiteCount: number;
  onNavigateConnections: () => void;
  onNavigateBadgeEmbed: () => void;
  /** Navigate to the Professional gateway page. Omit to hide the section (e.g. the paired-child surface). */
  onGoToProfessional?: () => void;
  /** Save an updated Professional persona display name and re-publish kind-0. */
  onSaveProName?: (name: string) => void;
}

export function Profile({
  identity,
  onUpdateName,
  onUpdatePhoto,
  ownBadge,
  connectedSiteCount,
  onNavigateConnections,
  onNavigateBadgeEmbed,
  onGoToProfessional,
  onSaveProName,
}: Props) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(identity.naturalPerson.displayName);
  const [busy, setBusy] = useState(false);

  const tierLocked = (ownBadge?.tier ?? 0) >= 3;
  const handleSaveName = async () => {
    if (!nameDraft.trim() || nameDraft === identity.naturalPerson.displayName) {
      setEditingName(false);
      return;
    }
    setBusy(true);
    try {
      await onUpdateName(nameDraft.trim());
      setEditingName(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fade-in" role="main">
      <div className="card section">
        <div className="section-title">Display</div>

        <div className="row">
          <span>Name</span>
          {tierLocked ? (
            <span className="row-meta">{identity.naturalPerson.displayName} (locked)</span>
          ) : editingName ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input input-sm"
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                maxLength={100}
                autoFocus
                disabled={busy}
              />
              <button className="btn btn-ghost btn-sm" onClick={handleSaveName} disabled={busy}>Save</button>
            </div>
          ) : (
            <button className="btn btn-ghost btn-sm" onClick={() => { setNameDraft(identity.naturalPerson.displayName); setEditingName(true); }}>
              {identity.naturalPerson.displayName} ›
            </button>
          )}
        </div>

        <div className="row">
          <span>Photo</span>
          <button className="btn btn-ghost btn-sm" onClick={onUpdatePhoto}>
            {identity.photoHash ? 'Change ›' : 'Set ›'}
          </button>
        </div>

        <div className="row">
          <span>Badge tier</span>
          <span className="row-meta">{ownBadge ? <TierBadge tier={ownBadge.tier} /> : '—'}</span>
        </div>
      </div>

      <div className="card section">
        <div className="section-title">Sites</div>
        <button className="row row-button" onClick={onNavigateConnections} style={{ width: '100%' }}>
          <span>Connected sites</span>
          <span className="row-meta">{connectedSiteCount} ›</span>
        </button>
        <button className="row row-button" onClick={onNavigateBadgeEmbed} style={{ width: '100%' }}>
          <span>Get your badge embed</span>
          <span className="row-meta">›</span>
        </button>
      </div>

      {onGoToProfessional && (
        <div className="card section">
          <div className="section-title">Professional</div>
          <button className="row row-button" onClick={onGoToProfessional} style={{ width: '100%' }}>
            <span>Professional</span>
            <span className="row-meta">›</span>
          </button>
          {identity.professionalPersona && (
            <div className="row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
              <label className="text-sm text-zinc-500 dark:text-zinc-400" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Professional name</label>
              <input
                type="text"
                defaultValue={identity.professionalPersona.displayName}
                maxLength={100}
                className="input input-sm"
                style={{ width: '100%' }}
                onBlur={(e) => onSaveProName?.(e.target.value.trim())}
              />
            </div>
          )}
        </div>
      )}

    </div>
  );
}
