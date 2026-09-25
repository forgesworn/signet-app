import { shortNpub } from '../lib/signet';
/**
 * SubRoleProDashboard — slim "pending chain" Pro surface.
 *
 * Shown when the user has a Pro persona but their head hasn't signed a
 * roster including their pubkey yet (or when chain-confirmed but sub-role).
 * Displays the self-cert pending state with a hand-off CTA to help the head
 * onboard, or the confirmed state with direct "Scan to attest" CTA.
 *
 * Spec: 2026-04-25-pro-surface-architecture-design.md §6.10.9
 * Phase 7: added isChainConfirmed, "Show my QR" for lead-scan, onAttest callback.
 */

import { useState } from 'react';
import { QRCode } from '../components/QRCode';

const PROFESSION_SUB_ROLE_LABELS: Record<string, Record<string, string>> = {
  school: {
    'form-tutor': 'Form tutor',
    'class-teacher': 'Class teacher',
    'nqt': 'NQT',
  },
  'gp-practice': {
    'practice-gp': 'Practice GP',
    'nurse': 'Nurse',
  },
  'solicitor-firm': {
    'associate': 'Associate',
    'paralegal': 'Paralegal',
    'trainee-solicitor': 'Trainee solicitor',
  },
};

const PROFESSION_ORG_NOUN: Record<string, string> = {
  school: 'school',
  'gp-practice': 'practice',
  'solicitor-firm': 'firm',
};

const PROFESSION_HEAD_NOUN: Record<string, string> = {
  school: 'head',
  'gp-practice': 'lead GP',
  'solicitor-firm': 'senior partner',
};

interface Props {
  claimedFirm: string;
  claimedFirmKind: string;
  claimedRole: string;
  professionKind: string;
  pendingCredentialCount: number;
  proPersonaPubkey: string;
  /**
   * True when the user's Pro persona pubkey has been confirmed in the
   * kind-30202 roster (chain-confirmed). When true, "Scan to attest" routes
   * to the confirmed-path ProAttest page. Phase 7, Task 16.
   */
  isChainConfirmed?: boolean;
  onIssueSelfCert: () => void;
  /** Navigate to ProAttest (confirmed path). Only called when isChainConfirmed. */
  onAttest?: () => void;
  onBack: () => void;
}

export function SubRoleProDashboard({
  claimedFirm,
  claimedFirmKind,
  claimedRole,
  professionKind,
  pendingCredentialCount,
  proPersonaPubkey,
  isChainConfirmed,
  onIssueSelfCert,
  onAttest,
}: Props) {
  const [showHandoff, setShowHandoff] = useState(false);
  const [showMyQR, setShowMyQR] = useState(false);
  const [copied, setCopied] = useState(false);

  // QR payload for the lead to scan when adding this sub-role to the roster (Task 17).
  const proQrPayload = JSON.stringify({
    proPersonaPubkey,
    claimedFirm,
    claimedFirmKind,
    claimedRole,
  });

  const orgNoun = PROFESSION_ORG_NOUN[professionKind] ?? 'organisation';
  const headNoun = PROFESSION_HEAD_NOUN[professionKind] ?? 'head';
  const roleLabels = PROFESSION_SUB_ROLE_LABELS[professionKind] ?? {};
  const roleLabel = roleLabels[claimedRole] ?? claimedRole;

  const deepLink = `https://mysignet.app/?pro=1&kind=${encodeURIComponent(professionKind)}&identifier=${encodeURIComponent(claimedFirm)}`;

  const handoffMessage =
    `Hi — I've been using Signet to issue credentials for my ${orgNoun} (${claimedFirmKind}: ${claimedFirm}). ` +
    `To complete the process, the ${orgNoun} needs to publish a short identity file online (takes about 5 minutes with the webmaster). ` +
    `Here's a link that pre-fills everything: ${deepLink}. If you need any help, I'm happy to walk you through it.`;

  function handleCopy() {
    navigator.clipboard.writeText(handoffMessage).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    });
  }

  return (
    <div className="fade-in">
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ marginBottom: 4 }}>
          {roleLabel} at {claimedFirm} ({claimedFirmKind})
        </h2>
        {isChainConfirmed ? (
          <span
            style={{
              display: 'inline-block',
              padding: '3px 12px',
              borderRadius: 12,
              fontSize: '0.8rem',
              fontWeight: 600,
              background: 'var(--success-light)',
              color: 'var(--success)',
              border: '1px solid var(--success)',
              marginBottom: 8,
            }}
          >
            Chain-confirmed ✓
          </span>
        ) : (
          <span
            style={{
              display: 'inline-block',
              padding: '3px 12px',
              borderRadius: 12,
              fontSize: '0.8rem',
              fontWeight: 600,
              background: 'var(--warning-light)',
              color: 'var(--warning)',
              border: '1px solid var(--warning)',
              marginBottom: 8,
            }}
          >
            Self-certified — pending confirmation
          </span>
        )}
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, marginTop: 8 }}>
          {isChainConfirmed
            ? `Your ${headNoun} has confirmed you on the ${orgNoun} roster. Credentials you issue are confirmed immediately.`
            : `Your ${orgNoun} hasn't completed Signet setup yet. Credentials you issue are pending until your ${headNoun} publishes the ${orgNoun}'s Signet anchor.`}
        </p>
      </div>

      {/* Pending credentials count (only shown when not yet confirmed) */}
      {!isChainConfirmed && pendingCredentialCount > 0 && (
        <div
          className="card"
          style={{
            marginBottom: 20,
            padding: '12px 16px',
            background: 'var(--warning-light)',
            borderColor: 'var(--warning)',
          }}
        >
          <p style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: 2 }}>
            {pendingCredentialCount} issued credential{pendingCredentialCount !== 1 ? 's' : ''} awaiting confirmation
          </p>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
            Once your {headNoun} completes setup, all pending credentials will confirm automatically.
          </p>
        </div>
      )}

      {/*
        Primary CTA — Scan to attest
        Confirmed path: navigates to ProAttest (verifierStatus: 'confirmed')
        Pending path: navigates to SelfCertIssue (verifierStatus: 'pending')
      */}
      <button
        className="btn btn-primary"
        onClick={isChainConfirmed ? (onAttest ?? onIssueSelfCert) : onIssueSelfCert}
        style={{ width: '100%', marginBottom: 12 }}
        data-testid="sub-role-scan-to-attest"
      >
        Scan to attest
      </button>

      {/* Show my QR — for the lead to scan when adding this sub-role to the roster (Task 17) */}
      <button
        className="btn btn-secondary"
        onClick={() => setShowMyQR(v => !v)}
        style={{ width: '100%', marginBottom: 12 }}
        data-testid="sub-role-show-my-qr"
      >
        Show my QR
      </button>

      {showMyQR && (
        <div
          className="card"
          style={{ padding: 16, marginBottom: 16, textAlign: 'center' }}
          data-testid="sub-role-my-qr-sheet"
        >
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
            Ask your {headNoun} to scan this QR to add you to the roster.
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
            <QRCode data={proQrPayload} size={200} />
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all', marginBottom: 0 }}>
            {shortNpub(proPersonaPubkey)}
          </p>
        </div>
      )}

      {/* Secondary CTA — Help your head onboard (only shown when not yet confirmed) */}
      {!isChainConfirmed && (
        <>
          <button
            className="btn btn-secondary"
            onClick={() => setShowHandoff(v => !v)}
            style={{ width: '100%', marginBottom: 24 }}
            data-testid="sub-role-help-head-onboard"
          >
            Help your {headNoun} onboard
          </button>

          {/* Head onboarding hand-off sheet */}
          {showHandoff && (
            <div
              className="card"
              style={{ padding: 16, marginBottom: 24 }}
              data-testid="sub-role-handoff-sheet"
            >
              <h3 style={{ fontSize: '1rem', marginBottom: 12 }}>
                Onboard your {headNoun} — about 5 minutes
              </h3>

              <div style={{ marginBottom: 16 }}>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
                  Share this link with your {headNoun} — it pre-fills the {orgNoun}&apos;s details:
                </p>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.8rem',
                    wordBreak: 'break-all',
                    padding: '8px 12px',
                    background: 'var(--surface-2)',
                    borderRadius: 6,
                    color: 'var(--text-primary)',
                    marginBottom: 8,
                  }}
                >
                  {deepLink}
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
                  Or copy this message for WhatsApp / email:
                </p>
                <div
                  style={{
                    fontSize: '0.85rem',
                    padding: '10px 12px',
                    background: 'var(--surface-2)',
                    borderRadius: 6,
                    color: 'var(--text-primary)',
                    lineHeight: 1.5,
                    marginBottom: 8,
                  }}
                >
                  {handoffMessage}
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={handleCopy}
                  style={{ fontSize: '0.85rem' }}
                >
                  {copied ? 'Copied!' : 'Copy message'}
                </button>
              </div>

              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 0 }}>
                Your professional identity npub:{' '}
                <span style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                  {shortNpub(proPersonaPubkey)}
                </span>
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
