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

  it('asks for no PIN for a refused sign-in or connect, on the approval pages or on home', () => {
    expect(app).toContain("const approveAuthHeld = (page === 'approve-auth' || page === 'approve-connect') && childSignInHold;");
    expect(app).toContain('if (approveAuthHeld) return; // refused in child mode, sign-in or connect: no PIN');
    expect(app).toContain('if (childSignInHold) return; // refused in child mode: no PIN, and the refusal stays on home');
    // Scoped: the hold settling at start-up must not re-run another page's prompt.
    expect(app).toContain('}, [page, encryptionKey, requestAuth, approveAuthHeld]);');
    expect(app).toContain('}, [encryptionKey, pendingAuthRequest, urlAuthSiteName, page, requestAuth, cancelSignInReview, childSignInHold]);');
  });

  it('renders the refusal instead of the picker page and instead of the home sheet, declining through Deny', () => {
    expect(app).toContain("if (page === 'approve-auth' && pendingAuthRequest && childSignInHold) {");
    expect(app.indexOf("if (page === 'approve-auth' && pendingAuthRequest && childSignInHold) {"))
      .toBeLessThan(app.indexOf("if (page === 'approve-auth' && pendingAuthRequest && identity) {"));
    expect(count('<ChildSignInRefusal ')).toBe(3);
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
    expect(app).toContain('const childModeOffer = childModeApprovalOffer({ childMode: signInChildMode, dependant: signInChildDependant });');
    expect(app).toContain('childModeOnly: !childModeOffer.guardian,');
    expect(app).toContain("onActivateRealIdentity: preferences.signingMode === 'paired-child' || signInChildMode ? undefined");
  });

  it('refuses at approval time too, before anything is signed', () => {
    expect(app).toContain('if (childModeSelectionRefused({ ...signInChildModeRef.current, selection })) throw new Error(CHILD_MODE_SIGN_IN_COPY.onlyAsTheChild);');
    const guard = app.indexOf('if (childModeSelectionRefused(');
    const begin = app.indexOf('const began = authSettlementRef.current.beginApproval(key);');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(begin);
  });

  it('a connect, from every entry, gets the same refusal: before the connect page, no PIN, declined through the connect Deny', () => {
    // Every connect entry (a nostrconnect:// scanned on the carousel or the scan
    // page, a ?nostrconnect= link, the App Link) lands on 'approve-connect'.
    expect(count("navigateReplace('approve-connect');")).toBe(2);
    const refusal = "if (page === 'approve-connect' && pendingConnectRequest && childSignInHold) {";
    const picker = "if (page === 'approve-connect' && pendingConnectRequest && identity) {";
    expect(app).toContain(refusal);
    expect(app.indexOf(refusal)).toBeLessThan(app.indexOf(picker));
    const branch = app.slice(app.indexOf(refusal), app.indexOf(picker));
    expect(branch).toContain('child={childSignIn.child} onDecline={handleConnectDone} />');
    expect(branch).not.toContain('exitChildMode');
    expect(branch).not.toContain('requestAuth');
    expect(branch).not.toContain('bunkerApprovalOverlay');
  });

  it('the connect picker in child mode offers only the child-mode dependant, and a connect as anyone else is refused before anything is sent', () => {
    const picker = app.slice(app.indexOf("if (page === 'approve-connect' && pendingConnectRequest && identity) {"));
    expect(count('&& childModeOffer.offersDependant(d.id));')).toBe(2);
    expect(picker.indexOf('&& childModeOffer.offersDependant(d.id));')).toBeGreaterThan(0);
    expect(picker).toContain('childModeOnly={!childModeOffer.guardian}');
    expect(app).toContain('if (childModeSelectionRefused({ ...signInChildModeRef.current, selection: sel })) throw new Error(CHILD_MODE_SIGN_IN_COPY.connectOnlyAsTheChild);');
    const guard = app.indexOf('if (childModeSelectionRefused({ ...signInChildModeRef.current, selection: sel }))');
    const begin = app.indexOf('const began = connectSettlementRef.current.beginApproval(key);');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(begin);
  });

  it('the carousel step after an approval never leaves child mode', () => {
    const start = app.indexOf('const alignCarouselToApprovedSelection = useCallback(');
    const align = app.slice(start, app.indexOf('// Auto-clear the transient sign-in ack chip', start));
    expect(align).toContain("const childStep = childModeAlignStep({ childMode: carousel.childMode, childModeDependantId: carousel.childDependant?.id, selection });");
    expect(align).toContain("if (childStep === 'stay-put') return;");
    expect(align).toContain('const childRow = childRingRowFor(carousel.rows, selection.keypairType);');
    expect(align).not.toContain('exitChildMode');
    expect(align).not.toContain('clearChildModeSession');
  });

  it('phone apps (NIP-55) are refused in child mode, and neither they nor the relay sheet show', () => {
    expect(app).toContain('const nip55ChildMode = childModeState({ live: carousel.childMode, saved: savedChildMode });');
    expect(app).toContain('    childMode: nip55ChildMode,\n  });\n  refuseHeldNip55Ref.current = nip55.refuseHeld;');
    // Child mode as saved is read before the NIP-55 server is set up.
    expect(app.indexOf('const [savedChildMode, setSavedChildMode]')).toBeLessThan(app.indexOf('const nip55 = useNip55Server({'));
    expect(app).toContain("const nip55Overlay = nip55.pending && nip55ChildMode === 'off' && !showAuthPrompt && !bunkerPendingApproval ? (");
    expect(app).toContain('const bunkerApprovalOverlay = bunkerPanelOpen || signInChildMode ? null : (bunkerPendingApproval ? (');
  });

  it('a saved session that can never restore is cleared once unlocked and read with the key, lifting every restriction', () => {
    expect(app).toContain('loadedWithKey: dependantsLoadedWithKey,');
    const start = app.indexOf('if (!childModeSessionStale({');
    expect(start).toBeGreaterThan(0);
    const heal = app.slice(start, app.indexOf('}, [encryptionKey, dependantsLoadedWithKey, carousel.childMode, savedChildMode, dependants]);', start));
    expect(heal).toContain('unlocked: !!encryptionKey,');
    expect(heal).toContain('dependantsLoadedWithKey,');
    expect(heal).toContain('childModeLive: carousel.childMode,');
    expect(heal).toContain('sessionDependantId: savedChildMode?.id,');
    expect(heal).toContain('dependantIds: dependants.map(d => d.id),');
    expect(heal).toContain('clearChildModeSession().catch(() => {});');
    expect(heal).toContain('setSavedChildMode(null);');
    // Every restriction outside live child mode reads `savedChildMode`, so clearing it lifts them all.
    expect(app).toContain('const signInChildMode = carousel.childMode || !!savedChildMode;');
  });
});

describe('sign-in picker offers Heartwood-held dependants (auth page only)', () => {
  it('the auth filter asks approvalDependantSignable, with the signing mode and router state', () => {
    expect(app).toContain('approvalDependantSignable(d, {');
    expect(app).toContain("signingMode: preferences.signingMode,\n        routerUnsupported: routerProbeState === 'unsupported',");
    expect(count('approvalDependantSignable(d, {')).toBe(1);
  });

  it('the connect page stays local-key-only', () => {
    expect(count('!d.encrypted && isValidHexKey(resolveDependantCardSlot(d).slot.privateKey)')).toBe(1);
    const connect = app.indexOf('!d.encrypted && isValidHexKey(resolveDependantCardSlot(d).slot.privateKey)');
    expect(app.slice(connect, connect + 200)).toContain('childModeOffer.offersDependant(d.id)');
  });
});

describe('a sign-in as a dependant hands no bunker', () => {
  it('both delivery paths pass the selection to the handoff decision and skip the URI lookup', () => {
    expect(count("signInBunkerHandoff({ childDirect, dependantSelected: selection.source === 'dependant', remoteBunkerUri, inPageServer:")).toBe(2);
    expect(count("remoteBunkerUri = childDirect || selection.source === 'dependant' ? undefined : await resolveBunkerHandoffUri(")).toBe(2);
  });
});
