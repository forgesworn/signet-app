import type { AppPreferences } from '../types';

/** The browser-chrome colours index.html declares for each scheme. */
export const THEME_COLOUR = { light: '#FAF7ED', dark: '#081B2D' } as const;

/**
 * Put a theme preference on the document: the `data-theme` attribute the
 * stylesheet reads, and every `meta[name="theme-color"]` the browser colours
 * its chrome from. index.html carries one meta per scheme, each behind a
 * `prefers-color-scheme` media query, which follows the OS and so is wrong for
 * a user who chose Light or Dark in the app. A chosen theme therefore sets
 * both metas to its own colour; `system` removes the attribute and puts each
 * meta back to the colour its media query names.
 */
export function applyTheme(theme: AppPreferences['theme'], doc: Document = document): void {
  const root = doc.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);

  doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(meta => {
    if (theme === 'system') {
      meta.content = (meta.getAttribute('media') ?? '').includes('dark') ? THEME_COLOUR.dark : THEME_COLOUR.light;
    } else {
      meta.content = THEME_COLOUR[theme];
    }
  });
}
