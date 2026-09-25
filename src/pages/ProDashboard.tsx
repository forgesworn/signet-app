/**
 * Professional Dashboard — shown when the user has a verified role anchor.
 *
 * Includes:
 * - Firm header with Professional badge
 * - Profession-specific action placeholders
 * - Danger zone: Rotate lead key, Remove Professional role
 * - Tier-2 gated actions with double-confirm dialogs
 * - Registry drift detection banner
 *
 * Spec: the internal Pro-surface architecture design doc, §4.2, §8
 */

import { useState, useEffect } from 'react';
import type { ProRoleAnchorRecord, RegulatedEntityRecord } from '../lib/professional/types';
import { runProGate } from '../lib/professional/pro-gates';
import { buildLeadKeyRotationEvent, buildRosterRevocationEvent, buildRoleAnchorRevocationEvent } from '../lib/professional/role-anchor';
import { detectRegistryDrift } from '../lib/professional/verify-chain';
import { resolveIdentifier } from '../lib/professional/resolver';
import { invalidateProRegistryRecord } from '../lib/db';
import type { SigningBackend } from '../lib/signing-backend';

interface ConfirmAction {
  type: string;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
}

/**
 * Context passed when the dashboard is shown for a confirmed sub-role member
 * (chain-confirmed but not the lead — no kind-30201 anchor published by this user).
 * Spec: Phase 7, Task 16.
 */
export interface SubRoleContext {
  claimedFirm: string;
  claimedFirmKind: string;
  claimedRole: string;
}

interface Props {
  anchor: ProRoleAnchorRecord;
  /** Pro persona signing backend — all Pro-surface signing uses the Pro persona key (§4.5.6). */
  backend: SigningBackend | null;
  requestAuth: () => Promise<string | null>;
  requestFreshAuth: () => Promise<string | null>;
  /**
   * When present: the user is a confirmed sub-role, not the lead.
   * The dashboard shows sub-role actions (Scan to attest) instead of lead actions.
   * Phase 7, Task 16.
   */
  subRoleContext?: SubRoleContext;
  /**
   * Navigate to the confirmed-path scan flow (pro-attest).
   * Only relevant when subRoleContext is present.
   * Phase 7, Task 16.
   */
  onScanToAttest?: () => void;
  /**
   * Navigate to the Lead Add Staff scan flow (lead-add-staff).
   * Only relevant for the lead (no subRoleContext).
   * Phase 7, Task 17.
   */
  onAddStaff?: () => void;
  /**
   * Navigate to the delegate management page (lead-manage-delegates).
   * Only relevant for the lead (no subRoleContext) with a confirmed anchor.
   * Phase 5 (multi-lead + delegates).
   */
  onManageDelegates?: () => void;
  onBack: () => void;
  onRoleAnchorRemoved: () => void;
}

const PROFESSION_LABELS: Record<string, { leadRole: string; subRoleLabel: string; leadActions: string[]; subRoleActions: string[] }> = {
  'school': {
    leadRole: 'Head teacher',
    subRoleLabel: 'Teacher',
    leadActions: ['Sign register', 'Audit'],
    subRoleActions: [],
  },
  'gp-practice': {
    leadRole: 'Lead GP',
    subRoleLabel: 'Practice staff',
    leadActions: ['Issue referral', 'Verify patient', 'Audit'],
    subRoleActions: [],
  },
  'solicitor-firm': {
    leadRole: 'Senior partner',
    subRoleLabel: 'Associate',
    leadActions: ['Issue attestation', 'Verify client', 'Audit'],
    subRoleActions: [],
  },
};

export function ProDashboard({ anchor, backend: _backend, requestAuth, requestFreshAuth, subRoleContext, onScanToAttest, onAddStaff, onManageDelegates, onRoleAnchorRemoved }: Props) {
  const isSubRole = !!subRoleContext;
  const labels = PROFESSION_LABELS[anchor.professionKind] ?? {
    leadRole: anchor.professionKind,
    subRoleLabel: anchor.professionKind,
    leadActions: [],
    subRoleActions: [],
  };

  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [confirmWorking, setConfirmWorking] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [driftWarning, setDriftWarning] = useState<string | null>(null);
  const [reattesting, setReattesting] = useState(false);

  // Registry drift detection — runs on mount, non-fatal
  useEffect(() => {
    let cancelled = false;
    async function checkDrift() {
      if (!anchor) return;
      try {
        const liveRecord = await resolveIdentifier(
          anchor.identifier,
          anchor.professionKind,
          anchor.jurisdiction,
        );
        if (cancelled || !liveRecord) return;
        const cached: RegulatedEntityRecord = {
          professionKind: anchor.professionKind,
          jurisdiction: anchor.jurisdiction,
          registry: anchor.registry,
          identifier: anchor.identifier,
          identifierKind: anchor.identifierKind,
          name: anchor.entityName,
          status: 'Active',
          website: `https://${anchor.canonicalDomain}`,
          inferredCandidateWebsite: null,
          postcode: '',
          locality: '',
          tags: [],
          fetchedAt: anchor.verifiedAt,
        };
        const result = detectRegistryDrift(liveRecord, cached);
        if (result.drifted) {
          setDriftWarning(result.reason);
        }
      } catch {
        // Drift check failures are non-fatal — silently skip.
      }
    }
    void checkDrift();
    return () => { cancelled = true; };
  }, [anchor]);

  async function handleRotateLeadKey() {
    try {
      await runProGate('rotateLeadPubkey', { requestAuth, requestFreshAuth, payload: null }, async (_key) => {
        setConfirmAction({
          type: 'rotate-lead-key',
          title: 'Rotate lead key',
          body: 'This is irreversible. Old roster events remain valid for credentials signed before this point. Your organisation will need to re-verify with the new key.',
          confirmLabel: 'Yes, rotate my key',
          onConfirm: async () => {
            const ev = await buildLeadKeyRotationEvent(
              {
                identifier: { kind: anchor.identifierKind, value: anchor.identifier },
                professionKind: anchor.professionKind,
                canonicalUrl: `https://${anchor.canonicalDomain}`,
                firmName: anchor.entityName,
                previousHeadPubkeyHex: anchor.pubkey,
              },
              // In a full implementation, the new private key would be generated
              // and saved here. Placeholder uses a stub — real flow requires
              // generating a new keypair and persisting it.
              '0'.repeat(63) + '1',
            );
            void ev; // published in full implementation
          },
        });
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'auth-cancelled') return;
    }
  }

  async function handleRevokeSubRole(pubkey: string, subRole: string) {
    try {
      await runProGate('revokeSubRole', { requestAuth, requestFreshAuth, payload: null }, async (_key) => {
        setConfirmAction({
          type: 'revoke-sub-role',
          title: 'Revoke sub-role',
          body: `Remove ${subRole}? Any credentials they signed after this point will fail verification. Credentials signed before this are unaffected.`,
          confirmLabel: 'Yes, revoke',
          onConfirm: async () => {
            const ev = await buildRosterRevocationEvent(
              {
                identifier: { kind: anchor.identifierKind, value: anchor.identifier },
                professionKind: anchor.professionKind,
                remainingMembers: [],
                revokedPubkey: pubkey,
              },
              '0'.repeat(63) + '1',
            );
            void ev; // published in full implementation
          },
        });
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'auth-cancelled') return;
    }
  }
  // Reference handlers to avoid lint errors — buttons disabled pending follow-up implementation
  void handleRevokeSubRole;
  void handleRotateLeadKey;
  void handleRemoveRoleAnchor;

  async function handleRemoveRoleAnchor() {
    try {
      await runProGate('removeRoleAnchor', { requestAuth, requestFreshAuth, payload: null }, async (_key) => {
        setConfirmAction({
          type: 'remove-role-anchor',
          title: 'Remove Professional role',
          body: 'This will remove your Professional role from Signet. All sub-role members will lose access immediately. This action cannot be undone.',
          confirmLabel: 'Yes, remove my Professional role',
          onConfirm: async () => {
            const ev = await buildRoleAnchorRevocationEvent(
              { identifier: { kind: anchor.identifierKind, value: anchor.identifier }, professionKind: anchor.professionKind },
              '0'.repeat(63) + '1',
            );
            void ev; // published in full implementation
            onRoleAnchorRemoved();
          },
        });
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'auth-cancelled') return;
    }
  }

  async function handleConfirmAction() {
    if (!confirmAction) return;
    setConfirmWorking(true);
    setConfirmError(null);
    try {
      await confirmAction.onConfirm();
      setConfirmAction(null);
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setConfirmWorking(false);
    }
  }

  return (
    <div className="fade-in" style={{ padding: 24 }}>
      {/* Registry drift banner */}
      {driftWarning && (
        <div
          role="alert"
          style={{
            background: 'var(--warning-light)',
            border: '1px solid var(--warning)',
            borderRadius: 'var(--radius-sm)',
            padding: '12px 16px',
            marginBottom: 20,
          }}
        >
          <strong>Your registry record has changed.</strong>{' '}
          {driftWarning} Re-attest now to keep your Professional role active.
          <button
            className="btn btn-sm btn-primary"
            style={{ marginLeft: 12 }}
            disabled={reattesting}
            onClick={async () => {
              if (reattesting) return;
              setReattesting(true);
              try {
                const key = await requestAuth();
                if (!key) return;
                await invalidateProRegistryRecord(anchor.identifier, anchor.professionKind);
                const liveRecord = await resolveIdentifier(
                  anchor.identifier,
                  anchor.professionKind,
                  anchor.jurisdiction,
                );
                if (!liveRecord) return;
                const cached: RegulatedEntityRecord = {
                  professionKind: anchor.professionKind,
                  jurisdiction: anchor.jurisdiction,
                  registry: anchor.registry,
                  identifier: anchor.identifier,
                  identifierKind: anchor.identifierKind,
                  name: anchor.entityName,
                  status: 'Active',
                  website: anchor.canonicalDomain,
                  inferredCandidateWebsite: null,
                  postcode: '',
                  locality: '',
                  tags: [],
                  fetchedAt: anchor.verifiedAt,
                };
                const result = detectRegistryDrift(liveRecord, cached);
                if (result.drifted) {
                  setDriftWarning(result.reason);
                } else {
                  setDriftWarning(null);
                }
              } catch {
                // Network/resolver failure — leave banner up.
              } finally {
                setReattesting(false);
              }
            }}
          >
            {reattesting ? 'Checking…' : 'Re-attest'}
          </button>
        </div>
      )}

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>{anchor.entityName}</h2>
          <span style={{
            fontSize: '0.7rem',
            fontWeight: 700,
            padding: '2px 7px',
            borderRadius: 10,
            background: 'var(--accent)',
            color: 'var(--on-accent)',
            letterSpacing: '0.04em',
          }}>
            PRO
          </span>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
          {isSubRole ? (labels.subRoleLabel + ' — ' + (subRoleContext?.claimedRole ?? '')) : labels.leadRole}
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 4 }}>
          {isSubRole
            ? `Confirmed at ${anchor.entityName}`
            : `Anchored at ${anchor.canonicalDomain}/.well-known/signet.json`}
        </p>
      </div>

      {/* Primary actions */}
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 12 }}>
        Professional actions
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
        {/* Sub-role: Scan to attest (confirmed path — wired as real CTA) */}
        {isSubRole && (
          <button
            className="btn btn-primary"
            onClick={onScanToAttest}
            style={{ justifyContent: 'flex-start' }}
            data-testid="pro-dashboard-scan-to-attest"
          >
            Scan and attest
          </button>
        )}

        {/* Lead: Add staff (wired as real CTA) */}
        {!isSubRole && (
          <button
            className="btn btn-primary"
            onClick={onAddStaff}
            style={{ justifyContent: 'flex-start' }}
            data-testid="pro-dashboard-add-staff"
          >
            Add staff
          </button>
        )}

        {/* Lead: Manage delegates (Phase 5 — multi-lead + delegates) */}
        {!isSubRole && (
          <button
            className="btn btn-secondary"
            onClick={onManageDelegates}
            style={{ justifyContent: 'flex-start' }}
            data-testid="pro-dashboard-manage-delegates"
          >
            Manage delegates
          </button>
        )}

        {/* Remaining lead actions (coming soon) */}
        {!isSubRole && labels.leadActions.map(action => (
          <button
            key={action}
            className="btn btn-secondary"
            disabled
            style={{ opacity: 0.5, cursor: 'not-allowed', justifyContent: 'flex-start' }}
          >
            {action}
          </button>
        ))}

        {/* Sub-role additional actions (coming soon) */}
        {isSubRole && labels.subRoleActions.map(action => (
          <button
            key={action}
            className="btn btn-secondary"
            disabled
            style={{ opacity: 0.5, cursor: 'not-allowed', justifyContent: 'flex-start' }}
          >
            {action}
          </button>
        ))}
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 24, textAlign: 'center' }}>
        {isSubRole
          ? 'Additional professional actions will be available in a future update.'
          : 'Additional professional actions will be available in a future update.'}
      </p>

      {/* Danger zone */}
      <div style={{
        borderTop: '1px solid var(--border)',
        paddingTop: 20,
        marginTop: 8,
      }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Danger zone
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            className="btn btn-secondary"
            disabled
            style={{ opacity: 0.5, cursor: 'not-allowed' }}
            aria-label="Rotate lead key — coming soon"
          >
            Rotate lead key (coming soon)
          </button>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: -4, marginBottom: 4 }}>
            Lead-key rotation requires keypair management that ships in a follow-up.
          </p>
          <button
            className="btn btn-danger"
            disabled
            style={{ opacity: 0.5, cursor: 'not-allowed' }}
            aria-label="Remove Professional role — coming soon"
          >
            Remove Professional role (coming soon)
          </button>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: -4 }}>
            Removing your role anchor requires publishing a kind-30204 revocation and clearing local cache; ships in a follow-up.
          </p>
        </div>
      </div>

      {/* Double-confirm dialog */}
      {confirmAction && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--scrim)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 24,
          }}
        >
          <div style={{
            background: 'var(--bg-card)',
            borderRadius: 'var(--radius)',
            padding: 24,
            maxWidth: 360,
            width: '100%',
          }}>
            <h3 id="confirm-dialog-title" style={{ marginBottom: 12 }}>{confirmAction.title}</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20, lineHeight: 1.6 }}>
              {confirmAction.body}
            </p>

            {confirmError && (
              <p style={{ color: 'var(--error)', fontSize: '0.85rem', marginBottom: 12 }}>{confirmError}</p>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-ghost"
                style={{ flex: 1 }}
                onClick={() => { setConfirmAction(null); setConfirmError(null); }}
                disabled={confirmWorking}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                style={{ flex: 1 }}
                onClick={handleConfirmAction}
                disabled={confirmWorking}
              >
                {confirmWorking ? 'Working…' : confirmAction.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
