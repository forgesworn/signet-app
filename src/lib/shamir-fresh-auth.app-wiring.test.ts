import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * App.tsx is too large to render in a unit test, so this pins the Shamir page's
 * wiring. On a device run (2026-11-18) "Split my backup" asked for a fresh
 * unlock, but the page rendered no auth overlay, so the prompt never appeared
 * and the split waited forever.
 */
const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8');

describe('Shamir page fresh unlock', () => {
  it('passes the fresh-unlock request to the page and renders the prompt beside it', () => {
    const start = app.indexOf("if (page === 'shamir') {");
    expect(start).toBeGreaterThan(-1);
    const block = app.slice(start, app.indexOf('\n  }\n', start));
    expect(block).toContain('onRequestFreshAuth={requestFreshAuth}');
    expect(block).toMatch(/<\/Layout>[\s\S]*\{authOverlay\}/);
  });
});
