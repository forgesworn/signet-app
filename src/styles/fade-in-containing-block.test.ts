import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Regression: a forwards/both fill on `.fade-in` (whose keyframes end on
// `transform: translateY(0)`) leaves a permanent transform on the page wrapper.
// A transform makes the wrapper the containing block for `position: fixed`, so
// every modal inside a page (e.g. PersonaAdvanced's publish confirm) centred
// itself in the full page height and sat off-screen below a dimmed page.
describe('.fade-in animation', () => {
  const css = readFileSync(resolve(__dirname, 'global.css'), 'utf8');

  it('does not hold its final transform after it ends', () => {
    const rule = /\.fade-in\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    const decl = /animation\s*:\s*([^;]+);/.exec(rule![1]);
    expect(decl).not.toBeNull();
    expect(decl![1]).not.toMatch(/\b(forwards|both)\b/);
  });
});
