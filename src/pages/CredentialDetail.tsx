import { shortNpub } from '../lib/signet';
import { useEffect, useState } from 'react';
import type { StoredCredential } from '../types';
import { useNostrEvents } from '../hooks/useNostrEvents';
import { VerifierProfile } from '../components/VerifierProfile';
import { TierBadge } from '../components/TierBadge';
import { verifyProChain } from '../lib/professional/verify-chain';
import type { VerifyChainResult } from '../lib/professional/verify-chain';
import { SELF_CERT_LAPSE_DAYS } from '../lib/professional/cold-start';

interface Props {
  credential: StoredCredential;
  userPubkey?: string;
  tier?: 1 | 2 | 3 | 4 | null;
  onBack?: () => void;
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function CredentialDetail({ credential, userPubkey, tier, onBack }: Props) {
  const { credentials: relayCredentials } = useNostrEvents(userPubkey);

  // Confirmed if relay has the event, or stored status already says confirmed.
  // relayCredentials only contains signature-verified events (RelayClient verifyEvents:true).
  const isConfirmed =
    relayCredentials.some(e => e.id === credential.id) ||
    credential.verifierStatus === 'confirmed';

  const isExpiredPending = credential.verifierStatus === 'expired-pending';

  // Extract self-cert tags from the event for pending/expired-pending display (§6.10.7, §6.10.8).
  const selfCertTags = (() => {
    try {
      const ev = JSON.parse(credential.event) as { tags?: string[][] };
      const tags = ev.tags ?? [];
      const isSelfCert = tags.some(t => t[0] === 'self-cert' && t[1] === 'true');
      if (!isSelfCert) return null;
      return {
        claimedFirm: tags.find(t => t[0] === 'claimed-firm')?.[1] ?? '',
        claimedFirmKind: tags.find(t => t[0] === 'claimed-firm-kind')?.[1] ?? '',
        claimedRole: tags.find(t => t[0] === 'claimed-role')?.[1] ?? '',
        pendingIssuedAt: Number(tags.find(t => t[0] === 'pending-issued-at')?.[1] ?? '0') || null,
      };
    } catch {
      return null;
    }
  })();

  // Compute lapse date for pending self-cert credentials.
  const lapseDateStr = selfCertTags?.pendingIssuedAt
    ? formatDate(selfCertTags.pendingIssuedAt + SELF_CERT_LAPSE_DAYS * 86400)
    : null;

  const [proChain, setProChain] = useState<VerifyChainResult | null>(null);

  useEffect(() => {
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
        .catch(() => { /* fail-silent; chain result stays null */ });
    } catch {
      // malformed event JSON — no pro chain
    }
    return () => { cancelled = true; };
  }, [credential.event]);

  return (
    <div className="fade-in" role="main">
      {/* Verification status badge */}
      <div className="section" style={{ textAlign: 'center', paddingTop: 24 }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 20px',
            borderRadius: 24,
            background: isConfirmed
              ? 'var(--success-light)'
              : isExpiredPending
                ? 'var(--danger-light)'
                : 'var(--warning-light)',
            border: `1px solid ${isConfirmed ? 'var(--success)' : isExpiredPending ? 'var(--danger)' : 'var(--warning)'}`,
            color: isConfirmed
              ? 'var(--success)'
              : isExpiredPending
                ? 'var(--danger)'
                : 'var(--warning)',
            fontWeight: 700,
            fontSize: '1rem',
          }}
        >
          {isConfirmed ? '✓ Verified' : isExpiredPending ? '✗ Lapsed' : '⏳ Pending'}
        </div>
      </div>

      {/* Trust tier — shown when badge data is available */}
      {tier != null && (
        <div className="section" style={{ textAlign: 'center' }}>
          <TierBadge tier={tier} />
        </div>
      )}

      {/* Pending self-cert context block — §6.10.8 */}
      {selfCertTags && !isConfirmed && !isExpiredPending && (
        <div
          data-testid="credential-detail-pending-selfcert"
          className="card section"
          style={{ background: 'var(--warning-light)', borderColor: 'var(--warning)' }}
        >
          <p style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: 6, color: 'var(--warning)' }}>
            Awaiting confirmation
          </p>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            {shortNpub(credential.verifierPubkey)} has self-certified this credential.
            The organisation ({selfCertTags.claimedFirmKind}: {selfCertTags.claimedFirm}) has not yet
            published their Signet identity anchor.
          </p>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
            Once the organisation&apos;s head completes setup, this credential will automatically confirm.
            {lapseDateStr && (
              <> If nothing changes by {lapseDateStr} it will lapse and you&apos;ll need to ask for re-attestation.</>
            )}
          </p>
        </div>
      )}

      {/* Expired-pending self-cert context block — §6.10.8 */}
      {isExpiredPending && selfCertTags && (
        <div
          data-testid="credential-detail-expired-pending-selfcert"
          className="card section"
          style={{ background: 'var(--danger-light)', borderColor: 'var(--danger)' }}
        >
          <p style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: 6, color: 'var(--danger)' }}>
            Credential lapsed
          </p>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            {shortNpub(credential.verifierPubkey)} issued this credential but it lapsed because the
            {' '}{selfCertTags.claimedFirmKind}: {selfCertTags.claimedFirm} organisation did not complete
            chain anchoring within {SELF_CERT_LAPSE_DAYS} days. It is no longer valid for verification purposes.
          </p>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
            Re-attestation is needed. Ask {shortNpub(credential.verifierPubkey)} to issue a new credential
            once their organisation has completed Signet setup.
          </p>
        </div>
      )}

      {/* Pro chain result */}
      {proChain && proChain.ok && (
        <div className="section" style={{ textAlign: 'center' }}>
          <div
            data-testid="credential-detail-pro-badge"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 18px',
              borderRadius: 20,
              background: 'var(--accent-light)',
              border: '1px solid var(--accent)',
              color: 'var(--accent-text)',
              fontWeight: 700,
              fontSize: '0.95rem',
            }}
          >
            Pro — Verified
          </div>
          <div
            data-testid="credential-detail-firm-name"
            style={{ marginTop: 8, fontSize: '0.85rem', color: 'var(--text-secondary)' }}
          >
            {proChain.firmName}{proChain.role ? ` · ${proChain.role}` : ''}
          </div>
        </div>
      )}
      {proChain && !proChain.ok && proChain.reason === 'domain-mismatch' && (
        <div
          data-testid="credential-detail-domain-mismatch-warning"
          className="card section"
          style={{ background: 'var(--warning-light)', borderColor: 'var(--warning)' }}
        >
          <p style={{ fontSize: '0.9rem', color: 'var(--warning)', marginBottom: 0 }}>
            This firm&apos;s published Signet identity has changed since you last verified. The firm&apos;s lead needs to re-attest.
          </p>
        </div>
      )}
      {proChain && !proChain.ok && proChain.reason !== 'domain-mismatch' && (
        <div
          className="card section"
          style={{ background: 'var(--danger-light)', borderColor: 'var(--danger)' }}
        >
          <p style={{ fontSize: '0.9rem', color: 'var(--danger)', marginBottom: 0 }}>
            Pro verification failed: {proChain.reason}.
          </p>
        </div>
      )}

      {/* Credential details */}
      <div className="card section">
        <div className="section-title">Credential Details</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
              Keypair type
            </div>
            <div style={{ fontWeight: 600 }}>
              {credential.keypairType === 'natural-person' ? 'Natural Person' : 'Persona'}
            </div>
          </div>

          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
              Issued
            </div>
            <div style={{ fontWeight: 600 }}>
              {formatDate(credential.verifiedAt)}
            </div>
          </div>

          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
              Status
            </div>
            <div
              style={{
                display: 'inline-block',
                padding: '2px 10px',
                borderRadius: 12,
                fontSize: '0.85rem',
                fontWeight: 600,
                background: isConfirmed
                  ? 'var(--success-light)'
                  : isExpiredPending
                    ? 'var(--danger-light)'
                    : 'var(--warning-light)',
                color: isConfirmed
                  ? 'var(--success)'
                  : isExpiredPending
                    ? 'var(--danger)'
                    : 'var(--warning)',
              }}
            >
              {isConfirmed ? 'Confirmed' : isExpiredPending ? 'Lapsed' : 'Pending verification'}
            </div>
          </div>
        </div>
      </div>

      {/* Verifier credibility */}
      <VerifierProfile verifierPubkey={credential.verifierPubkey} />

      {/* Credential ID */}
      <div className="card section">
        <div className="section-title">Credential ID</div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.8rem',
            color: 'var(--text-secondary)',
            wordBreak: 'break-all',
          }}
        >
          {credential.id}
        </div>
      </div>

      {!isConfirmed && !isExpiredPending && !selfCertTags && (
        <div
          className="card section"
          style={{
            background: 'var(--warning-light)',
            borderColor: 'var(--warning)',
          }}
        >
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
            Your credential is waiting for the verifier to publish their confirmation event to the
            Nostr network. This typically completes within a few minutes.
          </p>
        </div>
      )}

      {onBack && (
        <div className="section">
          <button
            className="btn btn-secondary"
            onClick={onBack}
            aria-label="Go back"
          >
            Back
          </button>
        </div>
      )}
    </div>
  );
}
