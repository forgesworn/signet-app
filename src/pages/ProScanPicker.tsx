import { shortNpub } from '../lib/signet';
/**
 * ProScanPicker — shared scan + preview + credential-type picker UI.
 *
 * Used by both:
 *   - SelfCertIssue (pending path): scans recipient → declares firm → issues pending credential
 *   - ProAttest (confirmed path): scans recipient → picks type → issues confirmed credential
 *
 * This component owns steps 1–3 (scan, preview/declare, confirm). Signing/storage
 * is delegated back to the parent via onConfirmed().
 *
 * Spec: Phase 7, Task 16 — factored shared UI.
 */

import { useState } from 'react';
import { QRScanner } from '../components/QRScanner';

export interface ProScanPickerCredentialOption {
  value: string;
  label: string;
}

export interface ProScanPickerResult {
  recipientPubkey: string;
  credentialType: string;
  claimedFirm: string;
  claimedFirmKind: string;
  claimedRole: string;
}

interface Props {
  professionKind: string;
  /** Pre-filled when entering from a known firm context (sub-role dashboard). */
  prefilledFirm?: string;
  prefilledFirmKind?: string;
  prefilledRole?: string;
  credentialOptions: ProScanPickerCredentialOption[];
  roleOptions: ProScanPickerCredentialOption[];
  defaultFirmKind: string;
  /** Shown in the confirm step to describe the issuance type. */
  statusLabel: string;
  statusColor: string;
  statusNote: string;
  /** Called when the user taps "Sign and issue" with their selections. */
  onConfirmed: (result: ProScanPickerResult) => void;
  onBack: () => void;
}

type Step = 'scan' | 'declare' | 'confirm';

export function ProScanPicker({
  prefilledFirm,
  prefilledFirmKind,
  prefilledRole,
  credentialOptions,
  roleOptions,
  defaultFirmKind,
  statusLabel,
  statusColor,
  statusNote,
  onConfirmed,
  onBack,
}: Props) {
  const [step, setStep] = useState<Step>('scan');
  const [recipientPubkey, setRecipientPubkey] = useState('');
  const [claimedFirm, setClaimedFirm] = useState(prefilledFirm ?? '');
  const [claimedFirmKind] = useState(prefilledFirmKind ?? defaultFirmKind);
  const [claimedRole, setClaimedRole] = useState(
    prefilledRole ?? roleOptions[0]?.value ?? '',
  );
  const [credentialType, setCredentialType] = useState(
    credentialOptions[0]?.value ?? 'credential',
  );
  const [errorMsg, setErrorMsg] = useState('');

  function handleScan(data: string) {
    let pubkey = '';
    if (/^[0-9a-f]{64}$/.test(data.trim())) {
      pubkey = data.trim();
    } else {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        const candidate =
          typeof parsed.pubkey === 'string' ? parsed.pubkey :
          typeof parsed.naturalPersonPubkey === 'string' ? parsed.naturalPersonPubkey :
          '';
        if (/^[0-9a-f]{64}$/.test(candidate)) {
          pubkey = candidate;
        }
      } catch {
        // not JSON
      }
    }
    if (!pubkey) {
      setErrorMsg('QR code did not contain a valid public key. Try again.');
      return;
    }
    setRecipientPubkey(pubkey);
    setStep('declare');
  }

  function handleDeclareNext() {
    if (!claimedFirm.trim()) {
      setErrorMsg('Please enter your organisation identifier.');
      return;
    }
    setErrorMsg('');
    setStep('confirm');
  }

  function handleSignAndIssue() {
    onConfirmed({
      recipientPubkey,
      credentialType,
      claimedFirm: claimedFirm.trim(),
      claimedFirmKind,
      claimedRole,
    });
  }

  if (step === 'scan') {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <button
          className="btn btn-ghost"
          onClick={onBack}
          style={{ marginBottom: 16 }}
        >
          ← Back
        </button>
        <h2 style={{ marginBottom: 8 }}>Scan recipient QR</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
          Ask the parent / student / patient / client to show their Signet QR code.
        </p>
        {errorMsg && (
          <p style={{ color: 'var(--danger)', fontSize: '0.9rem', marginBottom: 12 }}>{errorMsg}</p>
        )}
        <QRScanner onScan={handleScan} active data-testid="pro-attest-scanner" />
      </div>
    );
  }

  if (step === 'declare') {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <button
          className="btn btn-ghost"
          onClick={() => { setStep('scan'); setErrorMsg(''); }}
          style={{ marginBottom: 16 }}
        >
          ← Back
        </button>
        <h2 style={{ marginBottom: 8 }}>Issue credential</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 4 }}>
          Recipient npub:
        </p>
        <p style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.75rem',
          wordBreak: 'break-all',
          color: 'var(--text-muted)',
          marginBottom: 20,
        }}>
          {shortNpub(recipientPubkey)}
        </p>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
            Credential type
          </label>
          <select
            value={credentialType}
            onChange={e => setCredentialType(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: '0.9rem' }}
          >
            {credentialOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {roleOptions.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
              Your sub-role
            </label>
            <select
              value={claimedRole}
              onChange={e => setClaimedRole(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: '0.9rem' }}
            >
              {roleOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        )}

        {!prefilledFirm && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
              Organisation identifier ({claimedFirmKind})
            </label>
            <input
              type="text"
              value={claimedFirm}
              onChange={e => setClaimedFirm(e.target.value)}
              placeholder={claimedFirmKind === 'URN' ? 'e.g. 100000' : 'e.g. RXL'}
              maxLength={64}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: '0.9rem', boxSizing: 'border-box' }}
            />
          </div>
        )}

        {errorMsg && (
          <p style={{ color: 'var(--danger)', fontSize: '0.9rem', marginBottom: 12 }}>{errorMsg}</p>
        )}

        <button className="btn btn-primary" onClick={handleDeclareNext} style={{ width: '100%' }}>
          Review and sign
        </button>
      </div>
    );
  }

  // step === 'confirm'
  const credTypeLabel = credentialOptions.find(o => o.value === credentialType)?.label ?? credentialType;
  const roleLabel = roleOptions.find(o => o.value === claimedRole)?.label ?? claimedRole;

  return (
    <div className="fade-in" style={{ padding: 24 }}>
      <button
        className="btn btn-ghost"
        onClick={() => { setStep('declare'); setErrorMsg(''); }}
        style={{ marginBottom: 16 }}
      >
        ← Back
      </button>
      <h2 style={{ marginBottom: 16 }}>Confirm and sign</h2>

      <div className="card" style={{ padding: 16, marginBottom: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Credential type</span>
            <p style={{ fontWeight: 600, marginBottom: 0 }}>{credTypeLabel}</p>
          </div>
          {claimedRole && (
            <div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Your role</span>
              <p style={{ fontWeight: 600, marginBottom: 0 }}>{roleLabel}</p>
            </div>
          )}
          <div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Organisation ({claimedFirmKind})</span>
            <p style={{ fontWeight: 600, marginBottom: 0 }}>{claimedFirm}</p>
          </div>
          <div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</span>
            <p style={{ fontWeight: 600, marginBottom: 0, color: statusColor }}>{statusLabel}</p>
          </div>
        </div>
      </div>

      <div
        className="card"
        style={{ padding: '10px 14px', marginBottom: 20 }}
      >
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
          {statusNote}
        </p>
      </div>

      <button
        className="btn btn-primary"
        onClick={handleSignAndIssue}
        style={{ width: '100%' }}
        data-testid="pro-scan-picker-sign-btn"
      >
        Sign and issue
      </button>
    </div>
  );
}
