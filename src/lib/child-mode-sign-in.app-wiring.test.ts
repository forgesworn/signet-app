import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * App.tsx is too large to render in a unit test, so this pins how sign-in
 * requests are gated in child mode (device run 2026-11-17, F12): a child who
 * signs in on their own phone gets a refusal with no PIN on every surface, and
 * no child-mode sign-in ever offers the guardian's identities.
 */
const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8');
const count = (needle: string) => app.split(needle).length - 1;

describe('child-mode sign-in gate in App.tsx', () => {
  it('reads child mode as last saved without the key, and drops it once child mode is live', () => {
    expect(app).toContain('.then(session => (session ? loadDependantSignInFacts(session.activeDependantId) : null))');
    expect(app).toContain('if (carousel.childMode) setSavedChildMode(null);');
    // Held through a lock, when dependants empty for a moment.
    expect(app).toContain('else if (carousel.childDependant) childModeDependantRef.current = carousel.childDependant;');
    expect(app).toContain('carousel.childMode ? childModeDependantRef.current : savedChildMode ?? null;');
    expect(app).toContain('const signInChildMode = carousel.childMode || !!savedChildMode;');
    expect(app).toContain('const childSignIn = childModeSignInRefusal({ childMode: signInChildMode, dependant: signInChildDependant });');
    expect(app).toContain("const childSignInHold = !!childSignIn || savedChildMode === undefined;");
  });

  it('asks for no PIN for a refused sign-in, on the approval page or on home', () => {
    expect(app).toContain("const approveAuthHeld = page === 'approve-auth' && childSignInHold;");
    expect(app).toContain('if (approveAuthHeld) return; // refused in child mode: no PIN');
    expect(app).toContain('if (childSignInHold) return; // refused in child mode: no PIN, and the refusal stays on home');
    // Scoped: the hold settling at start-up must not re-run another page's prompt.
    expect(app).toContain('}, [page, encryptionKey, requestAuth, approveAuthHeld]);');
    expect(app).toContain('}, [encryptionKey, pendingAuthRequest, urlAuthSiteName, page, requestAuth, cancelSignInReview, childSignInHold]);');
  });

  it('renders the refusal instead of the picker page and instead of the home sheet, declining through Deny', () => {
    expect(app).toContain("if (page === 'approve-auth' && pendingAuthRequest && childSignInHold) {");
    expect(app.indexOf("if (page === 'approve-auth' && pendingAuthRequest && childSignInHold) {"))
      .toBeLessThan(app.indexOf("if (page === 'approve-auth' && pendingAuthRequest && identity) {"));
    expect(count('<ChildSignInRefusal ')).toBe(2);
    expect(count('child={childSignIn.child} onDecline={handleDenyAuth} />')).toBe(2);
    expect(app).toContain("{pendingAuthRequest && page === 'home' && identity && !childSignInHold && !savedChildMode && (() => {");
  });

  it('never leaves child mode on the way to a refusal', () => {
    const start = app.indexOf("if (page === 'approve-auth' && pendingAuthRequest && childSignInHold) {");
    const branch = app.slice(start, app.indexOf("if (page === 'approve-auth' && pendingAuthRequest && identity) {"));
    expect(branch).not.toContain('exitChildMode');
    expect(branch).not.toContain('requestAuth');
  });

  it('the picker in child mode offers only the child-mode dependant, never the guardian', () => {
    expect(app).toContain('&& (!signInChildMode || d.id === signInChildDependant?.id));');
    expect(app).toContain('childModeOnly: signInChildMode,');
    expect(app).toContain("onActivateRealIdentity: preferences.signingMode === 'paired-child' || signInChildMode ? undefined");
  });

  it('refuses at approval time too, before anything is signed', () => {
    expect(app).toContain('if (childModeSelectionRefused({ ...signInChildModeRef.current, selection })) throw new Error(CHILD_MODE_SIGN_IN_COPY.onlyAsTheChild);');
    const guard = app.indexOf('if (childModeSelectionRefused(');
    const begin = app.indexOf('const began = authSettlementRef.current.beginApproval(key);');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(begin);
  });
});
