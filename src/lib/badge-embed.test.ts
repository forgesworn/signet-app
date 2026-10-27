// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildBadgeEmbed, type BadgeStyle } from './badge-embed';

describe('Self-contained badge embeds', () => {
  it.each<BadgeStyle>(['shield', 'pill', 'banner'])('renders %s without fetching an image or a verification service', style => {
    const host = document.createElement('div');
    host.innerHTML = buildBadgeEmbed(style, 'npub1example', 3);
    expect(host.querySelector('svg')).not.toBeNull();
    expect(host.querySelector('a')?.getAttribute('href')).toBe('nostr:npub1example');
    expect(host.querySelector('[src],image,use,script')).toBeNull();
    expect(host.textContent).toContain('Badge snapshot. Request a fresh Signet proof to verify.');
  });

  it('keeps identity text inside the URI rather than interpreting it as HTML', () => {
    const host = document.createElement('div');
    host.innerHTML = buildBadgeEmbed('pill', '\"><script>alert(1)</script>', 2);
    expect(host.querySelector('script')).toBeNull();
    expect(decodeURIComponent(host.querySelector('a')!.getAttribute('href')!.slice(6))).toBe('\"><script>alert(1)</script>');
    expect(() => buildBadgeEmbed('pill', 'npub1example', NaN)).toThrow('Invalid badge tier');
  });
});
