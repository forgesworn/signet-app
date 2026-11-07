import { describe, expect, it } from 'vitest';
import { staticPageRedirect } from './static-page-redirect';

describe('staticPageRedirect', () => {
  it('forwards /guide with or without a trailing slash', () => {
    expect(staticPageRedirect('/guide', '', '')).toBe('/about/guide/');
    expect(staticPageRedirect('/guide/', '', '')).toBe('/about/guide/');
  });

  it('keeps the fragment and query', () => {
    expect(staticPageRedirect('/guide/', '', '#paths')).toBe('/about/guide/#paths');
    expect(staticPageRedirect('/guide', '?a=1', '#x')).toBe('/about/guide/?a=1#x');
  });

  it('leaves the app root and other paths alone', () => {
    expect(staticPageRedirect('/', '?auth=1', '')).toBeNull();
    expect(staticPageRedirect('/guidebook', '', '')).toBeNull();
    expect(staticPageRedirect('/about/guide/', '', '')).toBeNull();
  });
});
