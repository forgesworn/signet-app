interface TierConfig {
  label: string;
  colour: string;
  background: string;
  border: string;
}

const TIER_CONFIG: Record<1 | 2 | 3 | 4, TierConfig> = {
  1: {
    label: 'Self-declared',
    colour: 'var(--text-secondary)',
    background: 'var(--bg-secondary)',
    border: 'var(--border)',
  },
  2: {
    label: 'Peer vouched',
    colour: 'var(--accent)',
    background: 'var(--accent-light)',
    border: 'var(--accent)',
  },
  3: {
    label: 'Professionally verified',
    colour: 'var(--success)',
    background: 'var(--success-light)',
    border: 'var(--success)',
  },
  4: {
    label: 'Professional + child safety',
    colour: 'var(--guardian-text)',
    background: 'var(--guardian-light)',
    border: 'var(--guardian-hover)',
  },
};

interface Props {
  tier: 1 | 2 | 3 | 4;
  compact?: boolean;
}

export function TierBadge({ tier, compact = false }: Props) {
  const config = TIER_CONFIG[tier];

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: compact ? 4 : 6,
        padding: compact ? '3px 8px' : '6px 12px',
        borderRadius: 100,
        border: `1px solid ${config.border}`,
        background: config.background,
        color: config.colour,
        fontWeight: 600,
        fontSize: compact ? '0.75rem' : '0.85rem',
      }}
      aria-label={`Trust tier ${tier}: ${config.label}`}
    >
      {/* Shield SVG */}
      <svg
        width={compact ? 12 : 14}
        height={compact ? 14 : 16}
        viewBox="0 0 14 16"
        fill="none"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      >
        <path
          d="M7 0L0 3v5c0 4 3 6.5 7 8 4-1.5 7-4 7-8V3L7 0z"
          fill={config.colour}
          opacity="0.2"
        />
        <path
          d="M7 0L0 3v5c0 4 3 6.5 7 8 4-1.5 7-4 7-8V3L7 0z"
          stroke={config.colour}
          strokeWidth="1.2"
          fill="none"
        />
        <text
          x="7"
          y="11"
          textAnchor="middle"
          fontSize="7"
          fontWeight="700"
          fill={config.colour}
        >
          {tier}
        </text>
      </svg>
      {config.label}
    </div>
  );
}
