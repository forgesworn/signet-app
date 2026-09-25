import { shortNpub } from '../lib/signet';
/**
 * ProAttest — confirmed-path daily attestation scan.
 *
 * Shown when the user is a chain-confirmed sub-role (their Pro persona pubkey
 * IS in the current kind-30202 roster). Credentials are issued as 'confirmed'
 * immediately — no 30-day pending window.
 *
 * Contrast with SelfCertIssue (pending path): used when no roster confirmation
 * exists yet; credentials issued as 'pending'.
 *
 * The scan + preview + credential-type picker is shared with SelfCertIssue via
 * ProScanPicker. This file owns the signing and storage path only.
 *
 * Spec: Phase 7, Task 16.
 * 2026-04-25-pro-surface-architecture-design.md §4.2, §6.10
 */

import { useState } from 'react';
import { ProScanPicker } from './ProScanPicker';
import type { ProScanPickerResult, ProScanPickerCredentialOption } from './ProScanPicker';
import type { SigningBackend } from '../lib/signing-backend';
import type { StoredCredential } from '../types';
import { publishEvent } from '../lib/relay-service';
import { PRO_CREDENTIAL } from '../lib/professional/kinds';
import { SUB_ROLE_TOKENS } from '../lib/professional/cold-start';
import type { SubRoleToken } from '../lib/professional/cold-start';
import type { PurposeContext } from '../lib/auth-purposes';

// ── Confirmed credential event builder ────────────────────────────────────────

export interface ConfirmedCredentialParams {
  recipientPubkey: string;
  credentialType: string;
  firmIdentifier: string;
  firmKind: string;
  issuerRole: string;
}

/**
 * Build a kind-29999 EventTemplate for a chain-confirmed credential.
 * Distinct from buildSelfCertCredentialEvent:
 *   - no 'self-cert': 'true' tag
 *   - no 'pending-issued-at' tag
 * The credential is confirmed at issuance — verifierStatus is written as
 * 'confirmed' by the caller.
 */
export function buildConfirmedCredentialEvent(params: ConfirmedCredentialParams): {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
} {
  const now = Math.floor(Date.now() / 1000);
  return {
    kind: PRO_CREDENTIAL,
    created_at: now,
    tags: [
      ['p', params.recipientPubkey],
      ['credential-type', params.credentialType],
      ['claimed-firm', params.firmIdentifier],
      ['claimed-firm-kind', params.firmKind],
      ['claimed-role', params.issuerRole],
    ],
    content: '',
  };
}

// ── Profession-specific credential + role option tables ───────────────────────

const PROFESSION_CREDENTIAL_TYPES: Record<string, ProScanPickerCredentialOption[]> = {
  school: [
    { value: 'parent-of-pupil', label: 'Parent of pupil' },
    { value: 'parent-of-pupil-8B', label: 'Parent of pupil in 8B' },
    { value: 'pupil-identity', label: 'Pupil identity' },
  ],
  'gp-practice': [
    { value: 'patient-of-practice', label: 'Patient of practice' },
    { value: 'patient-referral', label: 'Patient referral' },
  ],
  'solicitor-firm': [
    { value: 'client-of-firm', label: 'Client of firm' },
    { value: 'client-attestation', label: 'Client attestation' },
  ],
};

const PROFESSION_FIRM_KIND: Record<string, string> = {
  school: 'URN',
  'gp-practice': 'CQC-ProviderID',
  'solicitor-firm': 'SRA-FirmNumber',
};

const SUB_ROLE_LABELS: Record<string, string> = {
  'form-tutor': 'Form tutor',
  'class-teacher': 'Class teacher',
  'nqt': 'NQT',
  'practice-gp': 'Practice GP',
  'nurse': 'Nurse',
  'associate': 'Associate',
  'paralegal': 'Paralegal',
  'trainee-solicitor': 'Trainee solicitor',
};

// ── Component ─────────────────────────────────────────────────────────────────

type SignStep = 'pick' | 'signing' | 'done' | 'error';

interface Props {
  professionKind: string;
  /** Pre-filled when navigating from the confirmed sub-role dashboard. */
  prefilledFirm?: string;
  prefilledFirmKind?: string;
  prefilledRole?: string;
  proBackend: SigningBackend;
  proPersonaPubkey: string;
  /** Tier 2 fresh PIN gate — required for confirmed-path issuance. */
  requestFreshAuth: (ctx?: PurposeContext) => Promise<string | null>;
  onComplete: (credId: string) => void;
  onSave: (cred: StoredCredential) => Promise<void>;
  onBack: () => void;
}

export function ProAttest({
  professionKind,
  prefilledFirm,
  prefilledFirmKind,
  prefilledRole,
  proBackend,
  proPersonaPubkey,
  requestFreshAuth,
  onComplete,
  onSave,
  onBack,
}: Props) {
  const [signStep, setSignStep] = useState<SignStep>('pick');
  const [errorMsg, setErrorMsg] = useState('');
  const [issuedCredId, setIssuedCredId] = useState('');

  const credentialOptions = PROFESSION_CREDENTIAL_TYPES[professionKind] ?? [
    { value: 'credential', label: 'Credential' },
  ];

  const roleOptions: ProScanPickerCredentialOption[] = SUB_ROLE_TOKENS.map(token => ({
    value: token,
    label: SUB_ROLE_LABELS[token as SubRoleToken] ?? token,
  }));

  async function handleConfirmed(result: ProScanPickerResult) {
    setSignStep('signing');

    // Tier 2 fresh PIN gate — confirmed-path issuance is a significant act.
    // Pass purpose context so the prompt names the firm, recipient, and
    // credential type — confirmed credentials present immediately.
    const credentialLabel =
      credentialOptions.find(o => o.value === result.credentialType)?.label
      ?? result.credentialType;
    const recipientShort = shortNpub(result.recipientPubkey);
    const firmDisplayName = prefilledFirm || result.claimedFirm || 'your firm';
    const authKey = await requestFreshAuth({
      purpose: 'issue-professional-credential-confirmed',
      firmName: firmDisplayName,
      recipientShort,
      credentialType: credentialLabel,
    });
    if (!authKey) {
      setSignStep('pick');
      setErrorMsg('Authentication cancelled. Please try again.');
      return;
    }

    const template = buildConfirmedCredentialEvent({
      recipientPubkey: result.recipientPubkey,
      credentialType: result.credentialType,
      firmIdentifier: result.claimedFirm,
      firmKind: result.claimedFirmKind,
      issuerRole: result.claimedRole,
    });

    type SignedEvent = {
      id: string;
      pubkey: string;
      sig: string;
      kind: number;
      created_at: number;
      tags: string[][];
      content: string;
    };

    let signedEvent: SignedEvent;
    try {
      signedEvent = await proBackend.signEvent({
        ...template,
        pubkey: proPersonaPubkey,
      }) as SignedEvent;
    } catch {
      setSignStep('error');
      setErrorMsg('Signing failed. Please try again.');
      return;
    }

    try {
      await publishEvent(signedEvent);
    } catch {
      // Publish failure is non-fatal — credential stored locally.
    }

    // Store with verifierStatus: 'confirmed' — no pendingIssuedAt.
    const now = Math.floor(Date.now() / 1000);
    const cred: StoredCredential = {
      id: signedEvent.id,
      documentId: '',
      keypairType: 'professional' as StoredCredential['keypairType'],
      event: JSON.stringify(signedEvent),
      verifierPubkey: proPersonaPubkey,
      verifiedAt: now,
      verifierStatus: 'confirmed',
      confirmationAt: now,
      // No pendingIssuedAt — this is a directly confirmed credential.
    };

    try {
      await onSave(cred);
    } catch {
      setSignStep('error');
      setErrorMsg('Failed to save credential locally. Please try again.');
      return;
    }

    setIssuedCredId(signedEvent.id);
    setSignStep('done');
  }

  if (signStep === 'signing') {
    return (
      <div className="fade-in" style={{ padding: 24, textAlign: 'center' }}>
        <p style={{ color: 'var(--text-secondary)', marginTop: 48 }}>Signing credential…</p>
      </div>
    );
  }

  if (signStep === 'done') {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <div style={{ textAlign: 'center', marginBottom: 24, marginTop: 24 }}>
          <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>✓</div>
          <h2 style={{ marginBottom: 8 }}>Credential issued</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6 }}>
            Credential issued and confirmed. Signed with your Professional Persona key.
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => onComplete(issuedCredId)}
          style={{ width: '100%' }}
        >
          Done
        </button>
      </div>
    );
  }

  if (signStep === 'error') {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <button className="btn btn-ghost" onClick={onBack} style={{ marginBottom: 16 }}>
          ← Back
        </button>
        <p style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>
          {errorMsg || 'An error occurred. Please try again.'}
        </p>
        <button
          className="btn btn-secondary"
          onClick={() => { setSignStep('pick'); setErrorMsg(''); }}
          style={{ width: '100%', marginTop: 16 }}
        >
          Start again
        </button>
      </div>
    );
  }

  // step === 'pick'
  return (
    <ProScanPicker
      professionKind={professionKind}
      prefilledFirm={prefilledFirm}
      prefilledFirmKind={prefilledFirmKind}
      prefilledRole={prefilledRole}
      credentialOptions={credentialOptions}
      roleOptions={roleOptions}
      defaultFirmKind={PROFESSION_FIRM_KIND[professionKind] ?? 'URN'}
      statusLabel="Confirmed — chain-verified"
      statusColor="var(--success)"
      statusNote="This credential is signed with your Professional Persona key and confirmed immediately. Your head has signed you into the roster."
      onConfirmed={handleConfirmed}
      onBack={onBack}
    />
  );
}
