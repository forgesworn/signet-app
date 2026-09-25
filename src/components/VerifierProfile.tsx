import { useVerifierProfile, isTrustedDomain } from '../hooks/useVerifierProfile';
import { shortNpub } from '../lib/signet';
import { Icon } from './Icon';

interface Props {
  verifierPubkey: string;
}

function RegistryBadge({ registry, registryUrl }: { registry: string; registryUrl: string | null }) {
  const style: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 10px',
    borderRadius: 12,
    fontSize: '0.8rem',
    fontWeight: 600,
    background: 'var(--accent-light)',
    color: 'var(--accent-text)',
    border: '1px solid var(--accent)',
    textDecoration: 'none',
  };

  if (registryUrl) {
    return (
      <a
        href={registryUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={style}
        aria-label={`Registry entry: ${registry}`}
      >
        ✓ {registry}
      </a>
    );
  }

  return (
    <span style={style} aria-label={`Registry entry: ${registry}`}>
      ✓ {registry}
    </span>
  );
}

function DomainBadge({ domain }: { domain: string }) {
  const trusted = isTrustedDomain(domain);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 10px',
        borderRadius: 12,
        fontSize: '0.8rem',
        fontWeight: 600,
        background: trusted ? 'var(--success-light)' : 'var(--bg-secondary)',
        color: trusted ? 'var(--success)' : 'var(--text-secondary)',
        border: `1px solid ${trusted ? 'var(--success)' : 'var(--border)'}`,
      }}
      aria-label={`Domain anchor: ${domain}`}
    >
      <Icon name={trusted ? 'landmark' : 'globe'} size={13} />{domain}
    </span>
  );
}

export function VerifierProfile({ verifierPubkey }: Props) {
  const { profile, loading, error } = useVerifierProfile(verifierPubkey);

  const labelStyle: React.CSSProperties = {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 2,
  };

  const valueStyle: React.CSSProperties = {
    fontWeight: 600,
  };

  if (loading) {
    return (
      <div className="card section" aria-busy="true" aria-label="Loading verifier profile">
        <div className="section-title">Verifier</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Loading verifier details…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card section">
        <div className="section-title">Verifier</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          {shortNpub(verifierPubkey)}
        </div>
      </div>
    );
  }

  if (!profile) {
    // No verifier event found — show truncated pubkey only
    return (
      <div className="card section">
        <div className="section-title">Verifier</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          {shortNpub(verifierPubkey)}
        </div>
      </div>
    );
  }

  const displayName = profile.name ?? shortNpub(verifierPubkey);
  const hasBadges = profile.registry !== null || profile.hasDomainAnchor;

  return (
    <div className="card section">
      <div className="section-title">Verifier</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Name */}
        <div>
          <div style={labelStyle}>Name</div>
          <div style={valueStyle}>{displayName}</div>
        </div>

        {/* Profession */}
        {profile.profession && (
          <div>
            <div style={labelStyle}>Profession</div>
            <div style={valueStyle}>{profile.profession}</div>
          </div>
        )}

        {/* Tenure */}
        {profile.activeSinceYear !== null && (
          <div>
            <div style={labelStyle}>Tenure</div>
            <div style={valueStyle}>Active since {profile.activeSinceYear}</div>
          </div>
        )}

        {/* Issuance count */}
        {profile.issuanceCount > 0 && (
          <div>
            <div style={labelStyle}>Credentials issued</div>
            <div style={valueStyle}>{profile.issuanceCount.toLocaleString()}</div>
          </div>
        )}

        {/* Trust indicators */}
        {hasBadges && (
          <div>
            <div style={labelStyle}>Trust indicators</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {profile.registry !== null && (
                <RegistryBadge
                  registry={profile.registry}
                  registryUrl={profile.registryUrl}
                />
              )}
              {profile.domain !== null && (
                <DomainBadge domain={profile.domain} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
