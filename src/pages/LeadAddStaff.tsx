import { shortNpub } from '../lib/signet';
/**
 * LeadAddStaff — Lead "Add staff via QR scan" flow.
 *
 * Allows the lead (head teacher / lead GP / senior partner) to scan a staff
 * member's Pro persona QR code, append their pubkey to the current roster,
 * sign an updated kind-30202 roster event, and publish it to the relay.
 *
 * Steps:
 *   1. Open scanner
 *   2. Scan staff member's Pro persona QR (pubkey or JSON payload)
 *   3. Preview staff member's identity (pubkey display)
 *   4. Optional: pick a sub-role label (pubkey-only roster per §4.5 model)
 *   5. Tier 2 fresh PIN gate + double-confirm dialog
 *   6. Sign updated kind-30202 roster event with proBackend
 *   7. Publish to relay
 *   8. Confirm + return to Pro Dashboard
 *
 * Spec: 2026-04-25-pro-surface-architecture-design.md §4.2, §6.9
 * Phase 7, Task 17.
 */

import { useState } from 'react';
import { QRScanner } from '../components/QRScanner';
import { buildRosterAppendEvent } from '../lib/professional/roster-append';
import { runProGate } from '../lib/professional/pro-gates';
import { PRO_ROSTER } from '../lib/professional/kinds';
import type { AnchorContext, RosterMember } from '../lib/professional/role-anchor';
import type { SigningBackend } from '../lib/signing-backend';
import { publishEvent, fetchEvents } from '../lib/relay-service';
import { verifiedAuthoredEvent } from '../lib/event-verify';

const SUB_ROLE_OPTIONS = [
  { value: '', label: '— Unspecified —' },
  { value: 'form-tutor', label: 'Form tutor' },
  { value: 'class-teacher', label: 'Class teacher' },
  { value: 'nqt', label: 'NQT' },
  { value: 'practice-gp', label: 'Practice GP' },
  { value: 'nurse', label: 'Nurse' },
  { value: 'associate', label: 'Associate' },
  { value: 'paralegal', label: 'Paralegal' },
  { value: 'trainee-solicitor', label: 'Trainee solicitor' },
];

/**
 * Re-fetch the latest kind-30202 roster for this firm's d-tag, verified as
 * genuinely signed by the lead. Returns `null` (not `[]`) on any failure —
 * fetch error, no event found, or a signature/author mismatch — so the
 * caller can distinguish "confirmed empty roster" from "couldn't confirm"
 * and fall back to its own snapshot rather than silently treating an
 * unreachable relay as "the roster is now empty."
 *
 * Exported for the M6 compare-and-swap regression test.
 */
export async function fetchLatestRosterMembers(
  anchorContext: AnchorContext,
  leadPubkey: string,
): Promise<RosterMember[] | null> {
  const dTagValue = `${anchorContext.registry}:${anchorContext.identifier}`;
  try {
    const events = await fetchEvents([{
      kinds: [PRO_ROSTER],
      authors: [leadPubkey],
      '#d': [dTagValue],
      limit: 1,
    }]);
    if (events.length === 0) return [];
    const raw = events[0] as unknown as { pubkey: string; sig: string; id: string; tags: string[][] };
    const rosterEvent = verifiedAuthoredEvent(raw, leadPubkey);
    if (!rosterEvent) return null;
    return rosterEvent.tags
      .filter(t => t[0] === 'p' && typeof t[1] === 'string')
      .map(t => ({ pubkey: t[1], role: t[2] ?? '', scope: t[3] }));
  } catch {
    return null;
  }
}

type Step = 'scan' | 'preview' | 'confirm' | 'signing' | 'done' | 'error';

interface Props {
  /** Anchor context for the lead's firm — drives the roster d-tag. */
  anchorContext: AnchorContext;
  /** Current roster members (read from relay before entering this page). */
  currentRosterMembers: RosterMember[];
  /** Pro persona signing backend for the lead. */
  proBackend: SigningBackend;
  requestAuth: () => Promise<string | null>;
  requestFreshAuth: () => Promise<string | null>;
  onComplete: () => void;
  onBack: () => void;
}

export function LeadAddStaff({
  anchorContext,
  currentRosterMembers,
  proBackend,
  requestAuth,
  requestFreshAuth,
  onComplete,
}: Props) {
  const [step, setStep] = useState<Step>('scan');
  const [scannedPubkey, setScannedPubkey] = useState('');
  const [selectedRole, setSelectedRole] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  // Double-confirm dialog state
  const [showDoubleConfirm, setShowDoubleConfirm] = useState(false);
  const [doubleConfirmWorking, setDoubleConfirmWorking] = useState(false);
  const [doubleConfirmError, setDoubleConfirmError] = useState<string | null>(null);

  function handleScan(data: string) {
    let pubkey = '';
    if (/^[0-9a-f]{64}$/.test(data.trim())) {
      pubkey = data.trim();
    } else {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        // Accept pubkey, proPersonaPubkey, or naturalPersonPubkey field.
        const candidate =
          typeof parsed.pubkey === 'string' ? parsed.pubkey :
          typeof parsed.proPersonaPubkey === 'string' ? parsed.proPersonaPubkey :
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
    setScannedPubkey(pubkey);
    setStep('preview');
  }

  async function handlePreviewNext() {
    if (!scannedPubkey) return;
    setErrorMsg('');

    // Tier 2 gate: requestFreshAuth (fresh PIN, even if unlocked).
    try {
      await runProGate(
        'addStaffMember',
        { requestAuth, requestFreshAuth, payload: null },
        async () => {
          // Auth passed — show double-confirm dialog.
          setStep('confirm');
          setShowDoubleConfirm(true);
        },
      );
    } catch (e) {
      if (e instanceof Error && e.message === 'auth-cancelled') {
        setErrorMsg('Authentication cancelled. Please try again.');
      } else {
        setErrorMsg('Authentication failed. Please try again.');
      }
    }
  }

  async function handleDoubleConfirm() {
    setDoubleConfirmWorking(true);
    setDoubleConfirmError(null);

    // M6 compare-and-swap guard: `currentRosterMembers` is a snapshot taken
    // when this page was entered — the lead may have sat on the scan/
    // preview/confirm screens for a while, or another device may have
    // appended a DIFFERENT staff member in the meantime. Re-fetch the
    // latest roster immediately before publish and build the append
    // against THAT instead of the stale snapshot, so a concurrent change
    // is merged rather than silently clobbered when this event replaces
    // the roster at the relay (kind-30202 is parameterised-replaceable).
    // Best-effort: falls back to the snapshot if the fresh fetch fails —
    // proceeding on a slightly stale base beats blocking the whole flow
    // on a relay hiccup (matches the initial-load fallback in App.tsx).
    const freshMembers = await fetchLatestRosterMembers(anchorContext, proBackend.activePublicKeyHex);
    const baseMembers = freshMembers ?? currentRosterMembers;

    const template = buildRosterAppendEvent(
      anchorContext,
      baseMembers,
      scannedPubkey,
      selectedRole,
    );

    try {
      setShowDoubleConfirm(false);
      setStep('signing');

      type SignedEvent = {
        id: string;
        pubkey: string;
        sig: string;
        kind: number;
        created_at: number;
        tags: string[][];
        content: string;
      };

      const signedEvent = await proBackend.signEvent({
        ...template,
        pubkey: proBackend.activePublicKeyHex,
      }) as SignedEvent;

      await publishEvent(signedEvent);

      setStep('done');
    } catch (e) {
      setDoubleConfirmError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      setStep('confirm');
      setShowDoubleConfirm(true);
    } finally {
      setDoubleConfirmWorking(false);
    }
  }

  // ── Scan step ──────────────────────────────────────────────────────────────
  if (step === 'scan') {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <h2 style={{ marginBottom: 8 }}>Scan staff QR</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
          Ask the staff member to open their Signet app and show their Pro persona QR code.
        </p>
        {errorMsg && (
          <p style={{ color: 'var(--danger)', fontSize: '0.9rem', marginBottom: 12 }}>{errorMsg}</p>
        )}
        <QRScanner onScan={handleScan} active data-testid="lead-add-staff-scanner" />
      </div>
    );
  }

  // ── Preview step ───────────────────────────────────────────────────────────
  if (step === 'preview') {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <button
          className="btn btn-ghost"
          onClick={() => { setStep('scan'); setErrorMsg(''); }}
          style={{ marginBottom: 16 }}
        >
          ← Back
        </button>
        <h2 style={{ marginBottom: 8 }}>Add to roster</h2>

        <div className="card" style={{ padding: 16, marginBottom: 20 }}>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
            Staff professional identity npub
          </p>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', wordBreak: 'break-all', color: 'var(--text-primary)', marginBottom: 0 }}>
            {shortNpub(scannedPubkey)}
          </p>
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
            Sub-role (optional)
          </label>
          <select
            value={selectedRole}
            onChange={e => setSelectedRole(e.target.value)}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: '0.9rem' }}
            data-testid="lead-add-staff-role-picker"
          >
            {SUB_ROLE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 4, marginBottom: 0 }}>
            The staff member self-claims their role; assigning it here adds it to the roster for reference.
          </p>
        </div>

        {errorMsg && (
          <p style={{ color: 'var(--danger)', fontSize: '0.9rem', marginBottom: 12 }}>{errorMsg}</p>
        )}

        <button
          className="btn btn-primary"
          onClick={handlePreviewNext}
          style={{ width: '100%' }}
          data-testid="lead-add-staff-confirm-btn"
        >
          Add to roster
        </button>
      </div>
    );
  }

  // ── Confirm step — shows double-confirm dialog overlay ────────────────────
  if (step === 'confirm') {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        {/* Background content (dimmed by overlay) */}
        <button className="btn btn-ghost" onClick={() => { setStep('preview'); setDoubleConfirmError(null); }} style={{ marginBottom: 16 }}>
          ← Back
        </button>
        <h2 style={{ marginBottom: 8, opacity: 0.4 }}>Add to roster</h2>

        {/* Double-confirm dialog overlay */}
        {showDoubleConfirm && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-staff-confirm-title"
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
              borderRadius: 12,
              padding: 24,
              maxWidth: 360,
              width: '100%',
            }}>
              <h3 id="add-staff-confirm-title" style={{ marginBottom: 12 }}>
                Confirm roster update
              </h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 4, lineHeight: 1.6 }}>
                Add this staff member to your roster?
              </p>
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', wordBreak: 'break-all', color: 'var(--text-muted)', marginBottom: 12 }}>
                {shortNpub(scannedPubkey)}
              </p>
              {selectedRole && (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
                  Role: {SUB_ROLE_OPTIONS.find(o => o.value === selectedRole)?.label ?? selectedRole}
                </p>
              )}
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5 }}>
                A new kind-30202 roster event will be signed and published. Staff members added here can
                issue confirmed credentials immediately.
              </p>

              {doubleConfirmError && (
                <p style={{ color: 'var(--error)', fontSize: '0.85rem', marginBottom: 12 }}>
                  {doubleConfirmError}
                </p>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-ghost"
                  style={{ flex: 1 }}
                  onClick={() => {
                    setShowDoubleConfirm(false);
                    setStep('preview');
                    setDoubleConfirmError(null);
                  }}
                  disabled={doubleConfirmWorking}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  onClick={handleDoubleConfirm}
                  disabled={doubleConfirmWorking}
                  data-testid="lead-add-staff-double-confirm-btn"
                >
                  {doubleConfirmWorking ? 'Signing…' : 'Yes, add staff'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Signing step ───────────────────────────────────────────────────────────
  if (step === 'signing') {
    return (
      <div className="fade-in" style={{ padding: 24, textAlign: 'center' }}>
        <p style={{ color: 'var(--text-secondary)', marginTop: 48 }}>Signing roster update…</p>
      </div>
    );
  }

  // ── Done step ──────────────────────────────────────────────────────────────
  if (step === 'done') {
    return (
      <div className="fade-in" style={{ padding: 24 }}>
        <div style={{ textAlign: 'center', marginBottom: 24, marginTop: 24 }}>
          <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>✓</div>
          <h2 style={{ marginBottom: 8 }}>Staff added to roster</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6 }}>
            Roster updated and published. The staff member's Pro persona credentials will confirm on their next unlock.
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={onComplete}
          style={{ width: '100%' }}
        >
          Back to dashboard
        </button>
      </div>
    );
  }

  // ── Error step ─────────────────────────────────────────────────────────────
  return (
    <div className="fade-in" style={{ padding: 24 }}>
      <p style={{ color: 'var(--danger)', fontSize: '0.9rem' }}>
        {errorMsg || 'An error occurred. Please try again.'}
      </p>
      <button
        className="btn btn-secondary"
        onClick={() => { setStep('scan'); setErrorMsg(''); }}
        style={{ width: '100%', marginTop: 16 }}
      >
        Start again
      </button>
    </div>
  );
}
