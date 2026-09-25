import { useState } from 'react';
import type { CachedBadge } from '../lib/badge-fetch';

const SIGNET_BASE = 'https://signet.forgesworn.dev';

type BadgeStyle = 'shield' | 'pill' | 'banner';

interface BadgeConfig {
  style: BadgeStyle;
  label: string;
  description: string;
}

const BADGE_CONFIGS: BadgeConfig[] = [
  { style: 'shield', label: 'Shield', description: 'Minimal shield icon with tier number' },
  { style: 'pill', label: 'Pill', description: '"Signet Verified" pill badge with tier' },
  { style: 'banner', label: 'Banner', description: 'Full-width banner with name and tier' },
];

interface Props {
  npub: string;
  badge: CachedBadge | null;
}

function ShieldPreview({ tier }: { tier: number }) {
  return (
    <svg width="48" height="56" viewBox="0 0 48 56" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M24 2L4 10v18c0 12.15 8.6 23.52 20 26 11.4-2.48 20-13.85 20-26V10L24 2z"
        fill="var(--accent)"
      />
      <text
        x="24"
        y="34"
        textAnchor="middle"
        fill="#ffffff"
        fontSize="18"
        fontWeight="700"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
      >
        {tier}
      </text>
    </svg>
  );
}

function PillPreview({ tier }: { tier: number }) {
  return (
    <svg width="160" height="32" viewBox="0 0 160 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="160" height="32" rx="16" fill="var(--accent)" />
      <circle cx="16" cy="16" r="8" fill="rgba(255,255,255,0.25)" />
      <text
        x="16"
        y="20.5"
        textAnchor="middle"
        fill="#ffffff"
        fontSize="10"
        fontWeight="700"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
      >
        {tier}
      </text>
      <text
        x="90"
        y="20.5"
        textAnchor="middle"
        fill="#ffffff"
        fontSize="12"
        fontWeight="600"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
      >
        Signet Verified
      </text>
    </svg>
  );
}

function BannerPreview({ tier }: { tier: number }) {
  return (
    <svg width="260" height="40" viewBox="0 0 260 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="260" height="40" rx="8" fill="var(--accent)" />
      <rect x="0" y="0" width="48" height="40" rx="8" fill="rgba(0,0,0,0.15)" />
      <rect x="40" y="0" width="8" height="40" fill="rgba(0,0,0,0.15)" />
      <text
        x="24"
        y="26"
        textAnchor="middle"
        fill="#ffffff"
        fontSize="16"
        fontWeight="700"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
      >
        {tier}
      </text>
      <text
        x="160"
        y="25"
        textAnchor="middle"
        fill="#ffffff"
        fontSize="13"
        fontWeight="600"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
      >
        {`Signet Verified — Tier ${tier}`}
      </text>
    </svg>
  );
}

function buildEmbedCode(style: BadgeStyle, npub: string, _tier: number): string {
  // Encode npub in BOTH URLs (security audit 2026-06-15). The embed string is
  // pasted into the user's own page as HTML; bech32 npub can't break out of an
  // attribute today, but encoding consistently forecloses any injection if this
  // builder is ever reused with a non-bech32 value.
  const verifyUrl = `${SIGNET_BASE}/verify/${encodeURIComponent(npub)}`;
  // npub is in the URL so the hosted renderer can look up the live tier and
  // render a personalised badge. Alt text stays tier-neutral on purpose —
  // hardcoding a tier number rots as soon as the user's tier changes.
  const badgeUrl = `${SIGNET_BASE}/badges/${style}.svg?npub=${encodeURIComponent(npub)}`;
  const altText = 'Signet Verified';
  return `<a href="${verifyUrl}"><img src="${badgeUrl}" alt="${altText}"></a>`;
}

export function BadgeEmbed({ npub, badge }: Props) {
  const [copiedStyle, setCopiedStyle] = useState<BadgeStyle | null>(null);

  const tier = badge?.tier ?? 1;

  function handleCopy(style: BadgeStyle) {
    const code = buildEmbedCode(style, npub, tier);
    navigator.clipboard.writeText(code).then(() => {
      setCopiedStyle(style);
      setTimeout(() => setCopiedStyle(null), 2000);
    }).catch(() => {});
  }

  function renderPreview(style: BadgeStyle) {
    switch (style) {
      case 'shield': return <ShieldPreview tier={tier} />;
      case 'pill':   return <PillPreview tier={tier} />;
      case 'banner': return <BannerPreview tier={tier} />;
    }
  }

  return (
    <div className="fade-in" role="main">
      {/* Current status */}
      <div className="card section" style={{ marginBottom: 16 }}>
        <div className="section-title" style={{ marginBottom: 8 }}>Your Signet Status</div>
        <div style={{ display: 'flex', gap: 24 }}>
          <div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 2 }}>Verification Tier</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--accent)' }}>
              {badge ? `Tier ${badge.tier}` : '—'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 2 }}>Signet IQ</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--accent)' }}>
              {badge ? badge.score : '—'}
            </div>
          </div>
        </div>
        {!badge && (
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 8, marginBottom: 0 }}>
            Tier and score will appear once your badge has loaded from the relay.
          </p>
        )}
      </div>

      {/* Badge style cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {BADGE_CONFIGS.map(({ style, label, description }) => (
          <div key={style} className="card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12, gap: 8 }}>
              <div>
                <div style={{ fontWeight: 600 }}>{label}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2 }}>{description}</div>
              </div>
            </div>

            {/* Preview */}
            <div style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '16px 12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 12,
              minHeight: 72,
            }}>
              {renderPreview(style)}
            </div>

            {/* Embed code preview */}
            <div style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 12px',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.72rem',
              color: 'var(--text-secondary)',
              wordBreak: 'break-all',
              marginBottom: 10,
              lineHeight: 1.5,
            }}>
              {buildEmbedCode(style, npub, tier)}
            </div>

            <button
              className={`btn ${copiedStyle === style ? 'btn-secondary' : 'btn-primary'}`}
              onClick={() => handleCopy(style)}
              style={{ padding: '10px 16px', fontSize: '0.9rem' }}
            >
              {copiedStyle === style ? 'Copied!' : 'Copy embed code'}
            </button>
          </div>
        ))}
      </div>

      {/* Explainer */}
      <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 16, textAlign: 'center' }}>
        Paste the embed code into any website or profile to display your Signet badge.
      </p>
    </div>
  );
}
