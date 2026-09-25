import { describe, it, expect } from 'vitest';
import { sanitizeWireText } from '@forgesworn/signet-contacts/wire';
import { sanitizeDisplayName, sanitizeNote } from './text-sanitize';

describe('sanitizeDisplayName', () => {
  it('strips control characters and bidi overrides, then trims', () => {
    expect(sanitizeDisplayName('  Sam  ', 100)).toBe('Sam');
    expect(sanitizeDisplayName('Ada‮eda', 100)).toBe('Adaeda');
    expect(sanitizeDisplayName('Sam\x00name', 100)).toBe('Samname');
  });

  it('caps at maxLen for ordinary text', () => {
    expect(sanitizeDisplayName('x'.repeat(50), 10)).toBe('x'.repeat(10));
    expect(sanitizeDisplayName('short', 10)).toBe('short');
  });

  it('never splits a surrogate pair at the cap boundary', () => {
    // `.slice` counts UTF-16 code UNITS, so a cap landing between the halves
    // of an astral character leaves a lone surrogate: not valid UTF-8, renders
    // as a replacement character, and — because the SDK's `sanitizeWireText`
    // slices by code point — makes producer and parser disagree about one
    // string, which is the thing R-6 exists to prevent.
    const boundary = `${'x'.repeat(9)}\u{1F702}yyyy`;  // 9 chars, then one astral char
    const out = sanitizeDisplayName(boundary, 10);
    expect(out).toBe(`${'x'.repeat(9)}\u{1F702}`);
    // No lone surrogate survived.
    for (const unit of out) expect(unit.codePointAt(0)).toBeDefined();
    expect(Array.from(out)).toHaveLength(10);
  });

  it('agrees with the SDK’s own wire sanitiser at the same cap', () => {
    for (const input of [
      '  Sam  ', 'Ada‮eda', `${'x'.repeat(9)}\u{1F702}yyyy`, 'x'.repeat(200), '', '   ',
      '\u{1F702}'.repeat(20),
    ]) {
      expect(sanitizeDisplayName(input, 10)).toBe(sanitizeWireText(input, 10));
    }
  });

  it('is byte-identical to a code-unit slice for BMP-only input', () => {
    // Every fixture and frozen vector in this codebase is BMP-only, so the
    // change is a no-op for all of them.
    for (const input of ['Ada', 'x'.repeat(500), 'a b c', 'Ünïcödé but BMP']) {
      expect(sanitizeDisplayName(input, 12))
        .toBe(input.replace(/[\x00-\x1f]/g, '').trim().slice(0, 12));
    }
  });
});

describe('sanitizeNote', () => {
  it('keeps newlines and tabs, which a display name would glue together', () => {
    expect(sanitizeNote('line\nbreak\ttab', 100)).toBe('line\nbreak\ttab');
    expect(sanitizeDisplayName('line\nbreak', 100)).toBe('linebreak');
  });

  it('caps by code point too', () => {
    const out = sanitizeNote(`${'x'.repeat(9)}\u{1F702}zz`, 10);
    expect(Array.from(out)).toHaveLength(10);
    expect(out.endsWith('\u{1F702}')).toBe(true);
  });
});
