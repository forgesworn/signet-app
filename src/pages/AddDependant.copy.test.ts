import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Spec §7.6 / §12. The first field names the child's PERSONA, not their legal
 * name, and the form must say so. Source-scan rather than RTL — this repo has
 * no component-test harness for pages of this shape.
 */
const file = join(dirname(fileURLToPath(import.meta.url)), 'AddDependant.tsx');
const text = readFileSync(file, 'utf8');

describe('AddDependant copy', () => {
  it('asks for a name or handle', () => {
    expect(text).toContain('Their name or handle');
    expect(text).not.toMatch(/>\s*Their name\s*</);
  });

  it('says the value names their first persona', () => {
    expect(text).toContain('This names their first persona. You can add their real identity later when they need it.');
  });

  it('keeps date of birth optional and unchanged', () => {
    expect(text).toContain('Date of birth');
    expect(text).toContain('(optional)');
  });

  it('never synthesises an "(anonymous)" name', () => {
    expect(text).not.toContain('(anonymous)');
  });
});
