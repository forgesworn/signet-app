import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * App.tsx is too large to render in a unit test, so this pins how the
 * guardian-only pages are refused in child mode: no PIN, one refusal page that
 * renders even when locked, and a Decline that signs and publishes nothing.
 */
const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8');
const idx = (needle: string) => {
  const i = app.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};

describe('child-mode guardian-page gate in App.tsx', () => {
  it('reads the three-way child mode through the same state phone apps use', () => {
    expect(app).toContain('const childModeNow = nip55ChildMode;');
    expect(app).toContain('const childModePage = childModePageDecision({ page, childMode: childModeNow });');
  });

  it('holds the page-auth prompt on it, with the dependency', () => {
    expect(app).toContain("if (childModePage !== 'allow') return;");
    expect(app).toContain('}, [page, encryptionKey, requestAuth, approveAuthHeld, childModePage]);');
    expect(idx("if (childModePage !== 'allow') return;")).toBeLessThan(idx('const pagePurpose = PAGE_AUTH_CONTEXTS[page];'));
  });

  it('the add-dependant router never asks for a PIN in child mode', () => {
    const start = idx("if (childModeNow === 'unknown') return;");
    const effect = app.slice(start, app.indexOf('}, [encryptionKey, pendingAddDependantRequest, page, requestAuth', start));
    expect(effect.indexOf("if (childModeNow === 'on')")).toBeGreaterThan(-1);
    expect(effect.indexOf("if (childModeNow === 'on')")).toBeLessThan(effect.indexOf('requestAuth('));
    expect(effect).toContain("navigateReplace('approve-add-dependant')");
    expect(app).toContain('preferences.signingMode, childModeNow]);');
  });

  it('renders one refusal before every guardian-page branch, locked or not', () => {
    const guard = idx("if (childModePage !== 'allow') {");
    expect(app).toContain('<ChildModeGuardianRefusal ');
    for (const branch of [
      "if (page === 'settings-advanced') {",
      "if (page === 'approve-companion-grant' && pendingPairingRequest && identity) {",
      "if (page === 'contacts-grant-approve' && pendingContactsGrantV2 && identity && !encryptionKey && !isPairedChild) {",
      "if (page === 'approve-add-dependant' && pendingAddDependantRequest && identity",
    ]) expect(guard, branch).toBeLessThan(idx(branch));
    const body = app.slice(guard, idx("if (page === 'venue-entry' && identity && !activeDependant && !npActive) {"));
    expect(body).not.toContain('encryptionKey');
    expect(body).not.toContain('requestAuth');
  });

  it('Decline signs and publishes nothing and never lands on a guardian page', () => {
    const start = idx('const declineChildModeGuardianPage = useCallback(() => {');
    const handler = app.slice(start, app.indexOf('}, [page,', start));
    expect(handler).toContain('handleDenyAddDependant()');
    expect(handler).toContain('setPendingPairingRequest(null)');
    expect(handler).toContain('setPendingContactsGrantV2(null)');
    expect(handler).toContain("navigateReplace('home')");
    expect(handler).not.toContain('companion-apps');
    expect(handler).not.toMatch(/sign|publish|requestAuth/i);
  });
});
