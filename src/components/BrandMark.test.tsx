// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { BrandMark } from './BrandMark';

describe('BrandMark', () => {
  it('defaults to the emblem, auto tone, size 40, with alt text', () => {
    const { container } = render(<BrandMark />);
    const imgs = container.querySelectorAll('img');
    // auto tone renders both the on-light and on-dark marks; CSS picks one.
    expect(imgs).toHaveLength(2);
    for (const img of Array.from(imgs)) {
      expect(img).toHaveAttribute('alt', 'MySignet');
      expect(img).toHaveAttribute('height', '40');
    }
    // Vite inlines these small SVGs as data URIs under test — assert on the
    // geometry each source actually differs by (navy vs. ivory inner stroke)
    // rather than a filename, which the inlined src no longer carries.
    const srcs = Array.from(imgs).map((img) => decodeURIComponent(img.getAttribute('src') ?? ''));
    expect(srcs.some((s) => s.includes('#0E2A47'))).toBe(true); // on-light (navy)
    expect(srcs.some((s) => s.includes('#FAF7ED'))).toBe(true); // on-dark (ivory)
  });

  it('renders decorative marks with alt="" and aria-hidden', () => {
    const { container } = render(<BrandMark decorative />);
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    for (const img of Array.from(imgs)) {
      expect(img).toHaveAttribute('alt', '');
      expect(img).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('tone="on-light" renders a single navy mark, not the reversed one', () => {
    const { container } = render(<BrandMark tone="on-light" variant="horizontal" />);
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    // Above Vite's inline-asset size threshold these resolve to real URLs
    // (unlike the small emblem, which inlines as a data URI in tests).
    const src = imgs[0].getAttribute('src') ?? '';
    expect(src).toContain('mysignet-logo-horizontal');
    expect(src).not.toContain('reversed');
  });

  it('tone="on-dark" renders a single reversed mark', () => {
    const { container } = render(<BrandMark tone="on-dark" variant="stacked" />);
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    const src = imgs[0].getAttribute('src') ?? '';
    expect(src).toContain('mysignet-logo-stacked-reversed');
  });

  it('honours a custom size', () => {
    const { container } = render(<BrandMark tone="on-light" size={72} />);
    expect(container.querySelector('img')).toHaveAttribute('height', '72');
  });
});
