import { useState } from 'react';
import type { SignetIdentity } from '../types';
import { shortNpub } from '../lib/signet';

interface Props {
  identity: SignetIdentity;
  onBack?: () => void;
}

export function IdentityBridge({ identity }: Props) {
  const [showComingSoon, setShowComingSoon] = useState(false);

  const npPubkey = identity.naturalPerson.publicKey;
  const personaPubkey = identity.persona.publicKey;
  const hasBothKeypairs = npPubkey.length > 0 && personaPubkey.length > 0;

  const npNpubShort = shortNpub(npPubkey);
  const personaNpubShort = shortNpub(personaPubkey);

  return (
    <div className="fade-in" role="main">
      {/* What is an identity bridge? */}
      <div className="card section">
        <div className="section-title">What is an Identity Bridge?</div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 0 }}>
          Link your real name and anonymous identities with a cryptographic proof
          that reveals nothing about which verified person you are. A ring
          signature proves your anonymous account is backed by a verified
          identity, without revealing which one.
        </p>
      </div>

      {/* Your identities */}
      <div className="card section">
        <div className="section-title">Your Identities</div>

        {/* Natural Person */}
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 6,
            }}
          >
            Natural Person
          </div>
          <div
            style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 14px',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: 4 }}>
              {identity.naturalPerson.displayName || 'Natural Person'}
            </div>
            <div
              style={{
                fontSize: '0.75rem',
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-muted)',
                wordBreak: 'break-all',
              }}
            >
              {npNpubShort}
            </div>
          </div>
        </div>

        {/* Persona */}
        <div>
          <div
            style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 6,
            }}
          >
            Anonymous Persona
          </div>
          <div
            style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 14px',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: 4 }}>
              {identity.persona.displayName || 'Anonymous Persona'}
            </div>
            <div
              style={{
                fontSize: '0.75rem',
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-muted)',
                wordBreak: 'break-all',
              }}
            >
              {personaNpubShort}
            </div>
          </div>
        </div>
      </div>

      {/* How it works */}
      <div className="card section">
        <div className="section-title">How It Works</div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 0 }}>
          This creates a ring signature proving your anonymous account is backed
          by a verified identity, without revealing which one. Your real name
          stays private — verifiers only see that someone in the verified group
          made the claim.
        </p>
      </div>

      {/* Action */}
      <div className="section">
        {!hasBothKeypairs ? (
          <div className="card" style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)' }}>
            <p style={{ fontSize: '0.9rem', marginBottom: 0 }}>
              Identity Bridge requires both a Natural Person and Persona keypair.
              Create a full account with backup words to use this feature.
            </p>
          </div>
        ) : !showComingSoon ? (
          <button
            className="btn btn-primary"
            style={{ width: '100%' }}
            onClick={() => setShowComingSoon(true)}
          >
            Learn more
          </button>
        ) : (
          <div
            className="card"
            style={{
              padding: '20px 18px',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                fontSize: '0.95rem',
                fontWeight: 700,
                color: 'var(--text-primary)',
                marginBottom: 8,
              }}
            >
              Coming soon
            </div>
            <p
              style={{
                fontSize: '0.85rem',
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
                marginBottom: 16,
              }}
            >
              Identity Bridge creation requires a relay with enough verified
              pubkeys to form an anonymity ring. This feature will be enabled
              in a future release.
            </p>
            <button
              className="btn btn-secondary"
              onClick={() => setShowComingSoon(false)}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
