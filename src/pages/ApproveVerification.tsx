import { useEffect, useState } from 'react';
import type { VerifyRequest } from '../lib/presentation';
import type { StoredCredential } from '../types';
import { verifyProChain } from '../lib/professional/verify-chain';
import type { VerifyChainResult } from '../lib/professional/verify-chain';

interface Props {
  request: VerifyRequest;
  credential: StoredCredential | null;
  onApprove: () => void;
  onDeny: () => void;
  onNavigateGetVerified?: () => void;
}

function safeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.hostname.slice(0, 64) || origin.slice(0, 64);
  } catch {
    return origin.slice(0, 64);
  }
}

const TIER_LABEL: Record<string, string> = {
  '1': 'Tier 1 — self-declared',
  '2': 'Tier 2 — peer-vouched',
  '3': 'Tier 3 — document-backed',
  '4': 'Tier 4 — child safeguarding',
};

function extractTierLabel(credential: StoredCredential | null): string | null {
  if (!credential) return null;
  try {
    const event = JSON.parse(credential.event) as { tags?: string[][] };
    const tag = event.tags?.find(t => t[0] === 'tier')?.[1];
    if (!tag) return null;
    return TIER_LABEL[tag] ?? null;
  } catch {
    return null;
  }
}

export function ApproveVerification({ request, credential, onApprove, onDeny, onNavigateGetVerified }: Props) {
  const [approving, setApproving] = useState(false);
  const [proChain, setProChain] = useState<VerifyChainResult | null>(null);

  useEffect(() => {
    if (!credential) return;
    let cancelled = false;
    try {
      const event = JSON.parse(credential.event) as {
        pubkey?: string;
        tags?: string[][];
        sig?: string;
        id?: string;
        kind?: number;
        created_at?: number;
        content?: string;
      };
      const identifierTag = event.tags?.find(t => t[0] === 'identifier');
      const professionTag = event.tags?.find(t => t[0] === 'profession');
      const jurisdictionTag = event.tags?.find(t => t[0] === 'jurisdiction');
      const rosterTag = event.tags?.find(t => t[0] === 'roster_event');
      if (!identifierTag || !professionTag || !jurisdictionTag || !rosterTag) return;
      const rosterEvent = JSON.parse(rosterTag[1]);
      const credEvent = event as Parameters<typeof verifyProChain>[0];
      verifyProChain(credEvent, rosterEvent, professionTag[1] as never, jurisdictionTag[1] as never)
        .then(r => { if (!cancelled) setProChain(r); })
        .catch(() => { /* fail-silent */ });
    } catch {
      // malformed event JSON — no pro chain
    }
    return () => { cancelled = true; };
  }, [credential]);
  const VALID_AGE_RANGES = ['0-3', '4-7', '8-12', '13-17', '18+'];
  const safeAgeRange = VALID_AGE_RANGES.includes(request.requiredAgeRange)
    ? request.requiredAgeRange
    : 'unknown';
  const originDisplay = request.origin ? safeOrigin(request.origin) : 'A website';

  if (!credential) {
    return (
      <div className="fade-in" role="main">
        <div className="section">
          <h2 style={{ marginBottom: 8 }}>Age Verification Request</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
            {originDisplay} wants to verify you are {safeAgeRange}.
          </p>

          <div
            className="card"
            style={{
              background: 'var(--warning-light)',
              borderColor: 'var(--warning)',
              marginBottom: 20,
            }}
          >
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
              You need to get verified first before you can prove your age to websites.
            </p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {onNavigateGetVerified && (
              <button className="btn btn-primary" onClick={onNavigateGetVerified}>
                Get Verified
              </button>
            )}
            <button className="btn btn-ghost" onClick={onDeny}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  const tierLabel = extractTierLabel(credential);

  return (
    <div className="fade-in" role="main">
      <div className="section">
        <h2 style={{ marginBottom: 8 }}>Age Verification Request</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
          A website wants to verify you are {safeAgeRange}.
        </p>
        {tierLabel && (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: -12, marginBottom: 20 }}>
            Verified by {tierLabel}
          </p>
        )}
        {proChain && proChain.ok && (
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 18px',
                borderRadius: 20,
                background: 'var(--brand-gold-light)',
                border: '1px solid var(--brand-gold)',
                color: 'var(--brand-gold-text)',
                fontWeight: 700,
                fontSize: '0.95rem',
              }}
            >
              Pro — Verified
            </div>
            <div style={{ marginTop: 8, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              {proChain.firmName}{proChain.role ? ` · ${proChain.role}` : ''}
            </div>
          </div>
        )}
        {proChain && !proChain.ok && proChain.reason === 'domain-mismatch' && (
          <div
            className="card"
            style={{ background: 'var(--warning-light)', borderColor: 'var(--warning)', marginBottom: 16 }}
          >
            <p style={{ fontSize: '0.9rem', color: 'var(--warning)', marginBottom: 0 }}>
              This firm&apos;s published Signet identity has changed since you last verified. The firm&apos;s lead needs to re-attest.
            </p>
          </div>
        )}
        {proChain && !proChain.ok && proChain.reason !== 'domain-mismatch' && (
          <div
            className="card"
            style={{ background: 'var(--danger-light)', borderColor: 'var(--danger)', marginBottom: 16 }}
          >
            <p style={{ fontSize: '0.9rem', color: 'var(--danger)', marginBottom: 0 }}>
              Pro verification failed: {proChain.reason}.
            </p>
          </div>
        )}
      </div>

      <div className="card section">
        <div className="section-title">What will be shared</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[
            { label: `Your age range (${safeAgeRange})`, shared: true },
            { label: 'Your verification tier', shared: true },
            { label: 'Your name', shared: false },
            { label: 'Your date of birth', shared: false },
            { label: 'Your document details', shared: false },
          ].map(({ label, shared }) => (
            <div
              key={label}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                fontSize: '0.9rem',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: shared ? 'var(--success-light)' : 'var(--danger-light)',
                  border: `1px solid ${shared ? 'var(--success)' : 'var(--danger)'}`,
                  color: shared ? 'var(--success)' : 'var(--danger)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                }}
                aria-label={shared ? 'will be shared' : 'will not be shared'}
              >
                {shared ? '✓' : '✗'}
              </span>
              <span style={{ color: shared ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                {label}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button className="btn btn-primary" disabled={approving} onClick={() => { if (approving) return; setApproving(true); onApprove(); }}>
          Approve
        </button>
        <button className="btn btn-ghost" onClick={onDeny}>
          Deny
        </button>
      </div>
    </div>
  );
}
