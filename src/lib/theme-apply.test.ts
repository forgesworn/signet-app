// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { THEME_COLOUR, applyTheme } from './theme-apply';

function metaTags() {
  document.head.innerHTML = `
    <meta name="theme-color" content="#FAF7ED" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#081B2D" media="(prefers-color-scheme: dark)" />`;
  return Array.from(document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
}

describe('applyTheme', () => {
  beforeEach(() => document.documentElement.removeAttribute('data-theme'));

  it('sets data-theme and both theme-color metas for Light', () => {
    const metas = metaTags();
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(metas.map(m => m.content)).toEqual([THEME_COLOUR.light, THEME_COLOUR.light]);
  });

  it('sets them for Dark', () => {
    const metas = metaTags();
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(metas.map(m => m.content)).toEqual([THEME_COLOUR.dark, THEME_COLOUR.dark]);
  });

  it('System drops the attribute and restores each meta to its own scheme colour', () => {
    const metas = metaTags();
    applyTheme('dark');
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(metas.map(m => m.content)).toEqual([THEME_COLOUR.light, THEME_COLOUR.dark]);
  });

  it('matches the colours index.html declares', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync('index.html', 'utf8');
    expect(html).toContain(`content="${THEME_COLOUR.light}" media="(prefers-color-scheme: light)"`);
    expect(html).toContain(`content="${THEME_COLOUR.dark}" media="(prefers-color-scheme: dark)"`);
  });
});
