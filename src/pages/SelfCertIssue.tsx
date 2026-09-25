/**
 * SelfCertIssue — issuance flow for a self-cert credential (pending path).
 *
 * Steps:
 *   1–3. Scan recipient QR → declare firm + role → confirm (via ProScanPicker)
 *   4. Tier 1 PIN gate (requestAuth)
 *   5. Build self-cert credential event via buildSelfCertCredentialEvent
 *   6. Sign with proBackend
 *   7. Publish to relay
 *   8. Store in IDB with verifierStatus: 'pending', pendingIssuedAt: now
 *   9. Success message
 *
 * The scan + preview + credential-type picker UI is shared with ProAttest (confirmed path)
 * via ProScanPicker. This file owns only the signing and storage path.
 *
 * Spec: 2026-04-25-pro-surface-architecture-design.md §6.10.4, §6.10.10
 */

import { useState } from 'react';
import { ProScanPicker } from './ProScanPicker';
import type { ProScanPickerResult, ProScanPickerCredentialOption } from './ProScanPicker';
import { buildSelfCertCredentialEvent, SUB_ROLE_TOKENS } from '../lib/professional/cold-start';
import type { SubRoleToken } from '../lib/professional/cold-start';
import type { SigningBackend } from '../lib/signing-backend';
import type { StoredCredential } from '../types';
import { publishEvent } from '../lib/relay-service';

const PROFESSION_CREDENTIAL_TYPES: Record<string, Array<{ value: string; label: string }>> = {
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

type SignStep = 'pick' | 'signing' | 'done' | 'error';

interface Props {
  professionKind: string;
  /** Pre-filled when navigating from SubRoleProDashboard — already declared firm. */
  prefilledFirm?: string;
  prefilledFirmKind?: string;
  prefilledRole?: string;
  proBackend: SigningBackend;
  proPersonaPubkey: string;
  requestAuth: () => Promise<string | null>;
  onComplete: (credId: string) => void;
  onSave: (cred: StoredCredential) => Promise<void>;
  onBack: () => void;
}

export function SelfCertIssue({
  professionKind,
  prefilledFirm,
  prefilledFirmKind,
  prefilledRole,
  proBackend,
  proPersonaPubkey,
  requestAuth,
  onComplete,
  onSave,
  onBack,
}: Props) {
  const [signStep, setSignStep] = useState<SignStep>('pick');
  const [errorMsg, setErrorMsg] = useState('');
  const [issuedCredId, setIssuedCredId] = useState('');

  const credentialOptions: ProScanPickerCredentialOption[] =
    PROFESSION_CREDENTIAL_TYPES[professionKind] ?? [{ value: 'credential', label: 'Credential' }];

  const roleOptions: ProScanPickerCredentialOption[] = SUB_ROLE_TOKENS.map(token => ({
    value: token,
    label: SUB_ROLE_LABELS[token as SubRoleToken] ?? token,
  }));

  async function handleConfirmed(result: ProScanPickerResult) {
    setSignStep('signing');

    // Tier 1 auth gate — PIN or biometric required (§6.10.10).
    const authKey = await requestAuth();
    if (!authKey) {
      setSignStep('pick');
      setErrorMsg('Authentication cancelled. Please try again.');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const template = buildSelfCertCredentialEvent({
      recipientPubkey: result.recipientPubkey,
      credentialType: result.credentialType,
      claimedFirm: result.claimedFirm,
      claimedFirmKind: result.claimedFirmKind,
      claimedRole: result.claimedRole as SubRoleToken,
      pendingIssuedAt: now,
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

    // Publish to relay.
    try {
      await publishEvent(signedEvent);
    } catch {
      // Publish failure is non-fatal — credential is still stored locally.
    }

    // Store in IDB with verifierStatus: 'pending' and pendingIssuedAt.
    const cred: StoredCredential = {
      id: signedEvent.id,
      documentId: '',
      keypairType: 'professional' as StoredCredential['keypairType'],
      event: JSON.stringify(signedEvent),
      verifierPubkey: proPersonaPubkey,
      verifiedAt: now,
      verifierStatus: 'pending',
      pendingIssuedAt: now,
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
            Credential issued. It will confirm once your head signs the roster (within 30 days), or it will lapse.
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

  // signStep === 'pick' — delegate scan + preview + picker to shared component
  return (
    <ProScanPicker
      professionKind={professionKind}
      prefilledFirm={prefilledFirm}
      prefilledFirmKind={prefilledFirmKind}
      prefilledRole={prefilledRole}
      credentialOptions={credentialOptions}
      roleOptions={roleOptions}
      defaultFirmKind={PROFESSION_FIRM_KIND[professionKind] ?? 'URN'}
      statusLabel="Pending — self-certified"
      statusColor="var(--warning)"
      statusNote="This credential will be signed with your Professional Persona key and published as pending. It will confirm once your head signs the roster (within 30 days), or it will lapse."
      onConfirmed={handleConfirmed}
      onBack={onBack}
    />
  );
}
