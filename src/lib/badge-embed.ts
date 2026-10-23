export type BadgeStyle = 'shield' | 'pill' | 'banner';

/** Self-contained snapshot: no hosted image, lookup endpoint or verification claim. */
export function buildBadgeEmbed(style: BadgeStyle, npub: string, tier: number): string {
  if (!Number.isInteger(tier) || tier < 1 || tier > 4) throw new Error('Invalid badge tier');
  const title = `Signet badge snapshot: Tier ${tier}`;
  let size: string;
  let drawing: string;
  switch (style) {
    case 'shield':
      size = 'width="48" height="56" viewBox="0 0 48 56"';
      drawing = `<path d="M24 2L4 10v18c0 12.15 8.6 23.52 20 26 11.4-2.48 20-13.85 20-26V10L24 2z" fill="#0E2A47"/><text x="24" y="34" text-anchor="middle" fill="#fff" font-size="18" font-family="sans-serif">${tier}</text>`;
      break;
    case 'pill':
      size = 'width="160" height="32" viewBox="0 0 160 32"';
      drawing = `<rect width="160" height="32" rx="16" fill="#0E2A47"/><text x="80" y="21" text-anchor="middle" fill="#fff" font-size="13" font-family="sans-serif">Signet · Tier ${tier}</text>`;
      break;
    case 'banner':
      size = 'width="260" height="40" viewBox="0 0 260 40"';
      drawing = `<rect width="260" height="40" rx="8" fill="#0E2A47"/><text x="130" y="25" text-anchor="middle" fill="#fff" font-size="14" font-family="sans-serif">Signet badge · Tier ${tier}</text>`;
      break;
    default:
      throw new Error('Invalid badge style');
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" ${size} role="img" aria-label="${title}"><title>${title}</title>${drawing}</svg>`;
  return `<a href="nostr:${encodeURIComponent(npub)}" aria-label="Open Nostr identity">${svg}</a><small>Badge snapshot. Request a fresh Signet proof to verify.</small>`;
}
