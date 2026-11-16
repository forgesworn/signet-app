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

  it('has no raw page or scope setter to bypass history, the borrow or the entry parameter', () => {
    // useAppNavigation.test.ts pins the hook's whole surface; here, App must
    // not grow its own. A bare setPage(…) or setActiveDependantId(…) is how a
    // page used to be opened for a dependant without a history entry.
    expect(app).not.toMatch(/\bsetPage\(/);
    expect(app).not.toMatch(/\bsetActiveDependantId\b/);
    expect(app).not.toMatch(/\[\s*page\s*,\s*setPage\s*\]/);
    // The DEV harness's page jump is a replace, so its entry describes it.
    expect(app).toContain('setPage: (p: Page) => navigateReplace(p),');
  });

  it('locks the scope to child mode and reads ids against the live dependant list', () => {
    // History must never re-scope child mode (the same ref that pins hardware back).
    expect(app).toContain('isScopeLocked: () => childModeActiveRef.current,');
    expect(app).toContain('childModeActiveRef.current = carousel.childMode;');
    expect(app).toContain('isLive: id => dependants.some(d => d.id === id),');
    expect(app).toContain('needsDependant: p => !isPairedChild && !childDirect && pageNeedsDependant(p),');
    expect(app).toContain('isPageParamLive: (p, param) => isPageParamLive(p, param, { identity, dependants }),');
  });

  it('sets the dependant scope outright only where the user chooses it', () => {
    // Chosen scopes: sign-in landing (guardian, dependant), enter / exit /
    // restore child mode, "Back to me" on a management page, "Hand this phone
    // to …", "Switch back" on home. A page opened FOR a dependant uses
    // openDependantPage instead; if this count moved, check which it is.
    expect(count(/\bchooseDependantScope\(/g)).toBe(8);
    // The one borrow made on the page itself: a finished import.
    expect(count(/\bborrowActiveDependantId\(/g)).toBe(1);
  });

  it('opens the dependant management pages with openDependantPage', () => {
    expect(app).toContain("else if (opts?.dependantId) openDependantPage(p as Page, opts.dependantId);");
    expect(app).toContain("onPairDevice={(depId) => openDependantPage('pair-dependant-device', depId)}");
    expect(app).toContain("onSelect={(depId) => openDependantPage('settings', depId)}");
    expect(count(/\bopenDependantPage\(/g)).toBe(11);
  });

  it('carries the Advanced slot, the activation target and the handshake persona on the history entry', () => {
    // These were App state a later visit overwrote, so back showed one
    // identity's page under another's banner (src/lib/page-params.ts).
    for (const stale of ['pendingPersonaAdvancedTarget', 'pendingDependantActivation', 'activationReturnTo', 'pendingHandshake']) {
      expect(app).not.toContain(stale);
    }
    expect(app).toContain("openDependantPage('persona-advanced', route.depPubkey ?? null, route);");
    expect(app).toContain("if (page === 'persona-advanced' && identity && personaAdvancedRoute) {");
    // Every Advanced page opens through openPersonaAdvanced, never a bare navigateTo.
    expect(app).not.toContain("navigateTo('persona-advanced')");
    expect(count(/\bopenPersonaAdvanced\(/g)).toBe(4);
    expect(app).toContain("if (page === 'activate-real-identity' && identity && activationRoute?.dependantId && !isPairedChild) {");
    expect(app).not.toContain("navigateTo('activate-real-identity')");
    expect(app).toContain("if (page === 'contact-handshake' && handshakeRoute && encryptionKey) {");
  });

  it('ends a removed dependant as a scope on every removal path', () => {
    // The hook's remover is renamed away and called only inside the wrapper
    // that ends the scope; the four removal paths call the wrapper.
    expect(app).toContain('removeDependant: removeDependantRecord,');
    expect(count(/\bremoveDependantRecord\(/g)).toBe(1);
    expect(app).toMatch(/await removeDependantRecord\(dependantId\);\s*endDependantScope\(dependantId\);/);
    // The independence closure deletes the record before its sweep can fail.
    expect(app).toMatch(/endDependantScope\(dep\.id\);\s*\/\/ Sweep the existing signing\/approval state before returning\.\s*await finishClosure\(\);/);
    // A closure merged from another device's handover deletes the record too:
    // every private-vault job set is built with the scope ender.
    expect(count(/\bprivateVaultJobs\(\{/g)).toBe(4);
    expect(count(/onDependantClosed: endDependantScope,/g)).toBe(4);
  });
});
