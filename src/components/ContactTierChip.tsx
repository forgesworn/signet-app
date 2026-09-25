import type { ContactCeilingTier, ContactTierSource } from '../types';
import { tierChipLabel, tierProvenanceSuffix } from '../lib/contacts-v2-copy';

const TIER_COLOUR: Record<ContactCeilingTier, string> = {
  kin: 'var(--brand-gold)',
  kith: 'var(--accent)',
  ken: 'var(--text-muted)',
  none: 'var(--text-muted)',
};

/**
 * Kin / Kith / Ken chip plus its provenance suffix and Blocked badge.
 *
 * The suffix is part of the chip rather than a separate line because spec
 * section 7.8 requires the provenance to travel with the tier wherever the
 * tier is shown — "Kin" and "Kin via Joe" are different facts.
 */
export function ContactTierChip({
  tier,
  source,
  guardianName = null,
  blocked = false,
  compact = false,
}: {
  tier: ContactCeilingTier;
  source?: ContactTierSource;
  guardianName?: string | null;
  blocked?: boolean;
  compact?: boolean;
}) {
  const suffix = source ? tierProvenanceSuffix(source, guardianName) : null;
  const fontSize = compact ? '0.62rem' : '0.68rem';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <span
        style={{
          display: 'inline-block', fontSize, fontWeight: 700, letterSpacing: '0.04em',
          padding: '1px 6px', borderRadius: 4, background: TIER_COLOUR[tier],
          color: 'var(--on-accent)', textTransform: 'uppercase',
        }}
      >
        {tierChipLabel(tier)}
      </span>
      {suffix && (
        <span style={{ fontSize, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{suffix}</span>
      )}
      {blocked && (
        <span
          style={{
            display: 'inline-block', fontSize, fontWeight: 700, letterSpacing: '0.04em',
            padding: '1px 6px', borderRadius: 4, background: 'var(--danger)',
            color: '#fff', textTransform: 'uppercase',
          }}
        >
          Blocked
        </span>
      )}
    </span>
  );
}
