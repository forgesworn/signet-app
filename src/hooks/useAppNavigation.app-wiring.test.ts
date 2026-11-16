import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * App.tsx is too large to render in a unit test, so this pins how it is wired
 * to useAppNavigation (whose behaviour useAppNavigation.test.ts covers). It
 * reads the source: a management page opened with a plain setter, or a
 * navigation that bypasses the scope, brings back the missing-Bunker-tab bug.
 */
const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8');
const count = (pattern: RegExp) => (app.match(pattern) ?? []).length;

describe('App.tsx dependant-scope wiring', () => {
  it('takes the page and history from useAppNavigation, never useNavigation or its own page state', () => {
    expect(count(/\buseAppNavigation\(/g)).toBe(1);
    expect(count(/\buseNavigation\(/g)).toBe(0);
    expect(count(/useState<Page>/g)).toBe(0);
  });

  it('locks the scope to child mode and reads ids against the live dependant list', () => {
    // History must never re-scope child mode (the same ref that pins hardware back).
    expect(app).toContain('isScopeLocked: () => childModeActiveRef.current,');
    expect(app).toContain('childModeActiveRef.current = carousel.childMode;');
    expect(app).toContain('isLive: id => dependants.some(d => d.id === id),');
    expect(app).toContain('needsDependant: p => !isPairedChild && !childDirect && pageNeedsDependant(p),');
  });

  it('sets the dependant scope outright only where the user chooses it', () => {
    // Chosen scopes: sign-in landing (guardian, dependant), enter / exit /
    // restore child mode, "Back to me" on a management page, "Hand this phone
    // to …", "Switch back" on home. A page opened FOR a dependant uses
    // openDependantPage instead; if this count moved, check which it is.
    expect(count(/\bsetActiveDependantId\(/g)).toBe(8);
    // The one borrow made on the page itself: a finished import.
    expect(count(/\bborrowActiveDependantId\(/g)).toBe(1);
  });

  it('opens the dependant management pages with openDependantPage', () => {
    expect(app).toContain("if (opts?.dependantId) openDependantPage(p as Page, opts.dependantId);");
    expect(app).toContain("onPairDevice={(depId) => openDependantPage('pair-dependant-device', depId)}");
    expect(app).toContain("onSelect={(depId) => openDependantPage('settings', depId)}");
    expect(count(/\bopenDependantPage\(/g)).toBe(9);
  });
});
