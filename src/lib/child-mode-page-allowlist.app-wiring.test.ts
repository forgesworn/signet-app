import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * App.tsx is too large to render in a unit test, so this pins how pages off
 * the child-mode allowlist are refused in child mode: no PIN, one refusal page that
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
    expect(app).toContain('const childModePage = childModePageDecision({');
    expect(app).toContain('page, childMode: childModeNow, live: carousel.childMode, stableChildId, activeDependantId,');
    expect(app).not.toContain('liveChild');
  });

  it('resolves the decision with whether the scope\'s dependant record is in hand', () => {
    expect(app).toContain('activeDependantResolved: !!activeDependant,');
  });

  it('the Settings page never renders the guardian\'s menu while child mode is on', () => {
    const settings = app.slice(idx("if (page === 'settings') {"));
    const guard = settings.indexOf("if (!activeDependant && childModeNow !== 'off') {");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(settings.indexOf("renderSettingsPage('settings', 'Settings'"));
  });

  it('a card page opens under the child in child mode, never the guardian scope', () => {
    expect(app).toContain("childModeNow !== 'off' ? stableChildId : resolved.isDependant ? resolved.dependantId ?? null : null;");
    expect(app).toContain("openDependantPage('contact-handshake', cardPageScopeId(resolved),");
    expect(app).toContain("openDependantPage(action === 'new' ? 'contact-new' : 'contacts', cardPageScopeId(resolved));");
    expect(app).toContain('openDependantPage(target, cardPageScopeId(current));');
    expect(app).not.toMatch(/openDependantPage\([^;]*isDependant \? [a-z]+\.dependantId \?\? null : null/);
  });

  it('clears the staged request state on any way off a refused page, not only Decline', () => {
    expect(app).toContain('page, decision: childModePage, locked: !encryptionKey,');
    expect(app).toContain('onLeave: () => clearChildModeStagedRequestsRef.current(),');
    const decline = app.slice(idx('const declineChildModeGuardianPage = useCallback(() => {'));
    expect(decline.indexOf('clearChildModeStagedRequestsRef.current();')).toBeGreaterThan(-1);
    expect(decline.indexOf('clearChildModeStagedRequestsRef.current();')).toBeLessThan(decline.indexOf("if (page === 'approve-add-dependant')"));
  });

  it('shows no banner that retries the guardian\'s signer on the sign-in and connect pages in child mode', () => {
    expect(app).toContain('<Layout title={approveAuthTitle(pendingAuthRequest)} showBack onBack={handleDenyAuth}>\n          {childModeNow !== \'off\' ? null : signerBanner}');
    expect(app).toContain('<Layout title="Connect" showBack onBack={handleConnectDone}>\n        {childModeNow !== \'off\' ? null : signerBanner}');
    expect(app).not.toMatch(/\n\s*\{signerBanner\}\n/);
  });

  it('the rate-limit banner, which names a dependant, is not shown on home in child mode', () => {
    expect(app).toContain("{rateLimitAlert && !showRepairBanner && childModeNow === 'off' && (");
  });

  it('a contact invite that arrives by link or hash is dropped in child mode, not parked for the exit', () => {
    expect(app).toContain('useDropInviteInChildMode({');
    expect(app).toContain('childMode: nip55ChildMode, pendingInvite: pendingContactInvite,');
    expect(app).toContain('{nativeLinkNothingToOpenBanner}{childModeInviteDroppedBanner}');
  });

  it('the dropped-invite notice shows on home beside the child-mode banner, and the PIN exit resets it', () => {
    const home = app.slice(idx('// Home (default) — card-swipe wallet carousel'));
    expect(home.indexOf('{childModeInviteDroppedBanner}')).toBeGreaterThan(-1);
    expect(home.indexOf('{childModeInviteDroppedBanner}')).toBeLessThan(home.indexOf('<Carousel'));
    const exit = app.slice(idx('const handleExitChildMode = useCallback(async () => {'));
    expect(exit.slice(0, exit.indexOf('}, [carousel.exitChildMode')).includes('setChildModeInviteDropped(false);')).toBe(true);
  });

  it('a PIN exit taken on a refused page clears what the child staged and lands home', () => {
    expect(app).toContain('const childModePageRef = useRef(childModePage);');
    const exit = app.slice(idx('const handleExitChildMode = useCallback(async () => {'));
    const body = exit.slice(0, exit.indexOf('}, [carousel.exitChildMode'));
    expect(body).toContain('leaveRefusedPageOnExit(childModePageRef.current, {');
    expect(body).toContain('clear: () => clearChildModeStagedRequestsRef.current(),');
    expect(body).toContain("goHome: () => navigateReplace('home'),");
    expect(body.indexOf('leaveRefusedPageOnExit(')).toBeGreaterThan(body.indexOf('if (!key) return;'));
    expect(body.indexOf('leaveRefusedPageOnExit(')).toBeLessThan(body.indexOf('carousel.exitChildMode();'));
  });

  it('the staged-request clear ignores a same-page lock-window flip', () => {
    expect(app).toContain('page, decision: childModePage, locked: !encryptionKey,');
  });

  it('the invite service tells a peer that needs the guardian apart from a blocked one', () => {
    expect(app).toContain("needsGuardian: async peer => await peerDecision(peer) === 'guardian-review',");
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
      "if (page === 'approve-verification' && pendingVerifyRequest) {",
      "if (page === 'approve-companion-grant' && pendingPairingRequest && identity) {",
      "if (page === 'contacts-grant-approve' && pendingContactsGrantV2 && identity && !encryptionKey && !isPairedChild) {",
      "if (page === 'approve-add-dependant' && pendingAddDependantRequest && identity",
    ]) expect(guard, branch).toBeLessThan(idx(branch));
    const body = app.slice(guard, idx("if (page === 'venue-entry' && identity && !activeDependant && !npActive) {"));
    expect(body).not.toContain('encryptionKey');
    expect(body).not.toContain('requestAuth');
  });

  it('Decline signs and publishes nothing and never lands on a guardian page', () => {
    const start = idx('const clearChildModeStagedRequests = () => {');
    const handler = app.slice(start, app.indexOf('}, [page,', idx('const declineChildModeGuardianPage = useCallback(() => {')));
    expect(handler).toContain('handleDenyAddDependant()');
    expect(handler).toContain('setPendingPairingRequest(null)');
    expect(handler).toContain('setPendingContactsGrantV2(null)');
    expect(handler).toContain("navigateReplace('home')");
    const declineStart = idx('const declineChildModeGuardianPage = useCallback(() => {');
    const decline = app.slice(declineStart, app.indexOf('}, [page,', declineStart));
    for (const code of [handler.slice(0, handler.indexOf('const declineChildModeGuardianPage')), decline]) {
      expect(code.replace(/\/\/.*$/gm, '')).not.toContain('companion-apps');
      expect(code).not.toMatch(/signEvent|publish\w*\(|requestAuth\(|activeBackend|Backend/);
      expect(code).not.toContain('publishVerifyRejectionToRelay');
    }
  });

  it('the verification decline clears the request and redirects like Deny, without the relay rejection', () => {
    const start = idx('const clearChildModeStagedRequests = () => {');
    const handler = app.slice(start, app.indexOf('}, [page,', idx('const declineChildModeGuardianPage = useCallback(() => {')));
    expect(handler).toContain("page === 'approve-verification'");
    expect(handler).toContain('setPendingVerifyRequest(null)');
    expect(handler).toContain('setVerifyArrivedViaUrl(false)');
    expect(handler).toContain('buildVerifyDeniedUrl(callback)');
    expect(app.slice(idx('const handleDenyVerification = useCallback(() => {'))).toContain('publishVerifyRejectionToRelay(');
  });

  it('Get Verified skips the backup phase, which would show the guardian\'s recovery words', () => {
    const start = idx('<GetVerified');
    expect(app.slice(start, app.indexOf('/>', start + 400))).toContain("skipBackup={childModeNow !== 'off'}");
  });

  it('the home backup card is hidden in child mode, so its button never leads to the guardian\'s Shamir split', () => {
    expect(app).toContain('{showBackupNudge && !signInChildMode && (');
    expect(idx('{showBackupNudge && !signInChildMode && (')).toBeGreaterThan(idx('const signInChildMode = carousel.childMode || !!savedChildMode;'));
    // the nudge itself is unchanged outside child mode
    expect(app).toContain('const showBackupNudge = !!identity && !!encryptionKey && shouldShowBackupNudge({');
  });

  it('the ready notice and both backup banners are withheld in child mode', () => {
    expect(app).toContain('readyNoticeFor={isPairedChild || signInChildMode ? undefined : (id) =>');
    expect(app).toContain('const privateVaultApprovalBanner = (!isPairedChild && !signInChildMode && privateVaultSupported');
    expect(app).toContain('const ownerAgainBanner = (!isPairedChild && !signInChildMode && ownerAgainOffer) ? (');
    const signIn = idx('const signInChildMode = carousel.childMode || !!savedChildMode;');
    expect(idx('const privateVaultApprovalBanner =')).toBeGreaterThan(signIn);
    expect(idx('const ownerAgainBanner =')).toBeGreaterThan(signIn);
    expect(idx('readyNoticeFor={isPairedChild || signInChildMode')).toBeGreaterThan(signIn);
  });

  it('app permission reads saved child mode too, not only the live carousel flag', () => {
    expect(app).toContain('guardianActingAsChild: signInChildMode,');
    expect(app).not.toContain('guardianActingAsChild: carousel.childMode');
    expect(app).toContain('childBunkerPersonasCsv, signInChildMode]);');
  });

  it('the contact-invite router waits for child mode and is declared after it (no TDZ)', () => {
    const effect = idx('if (nip55ChildMode !== \'off\') return;');
    expect(effect).toBeGreaterThan(idx('const nip55ChildMode = childModeState('));
    expect(app).toContain("navigateTo(isPairedChild ? 'child-contact-ask' : 'contact-invite-send');");
    expect(app.split("navigateTo(isPairedChild ? 'child-contact-ask' : 'contact-invite-send');").length).toBe(2);
    expect(app).toContain('pendingContactInvite, activeDependantId, nip55ChildMode]);');
  });

  it('the companion grant lists personas through the helper that skips a dormant real identity', () => {
    expect(app).toContain('const personas = companionGrantPersonas(identity);');
    expect(app).not.toContain("label: identity.naturalPerson.displayName || 'Natural Person'");
  });

  it('the paired-child request review and its count are never shown in child mode (live, saved or unknown)', () => {
    expect(app).toContain("{!isPairedChild && childModeNow === 'off' && <PairedChildRequestReview");
    expect(app).toContain("{!isPairedChild && childModeNow === 'off' && pendingGuardianChildRequests.pendingCount > 0 && <p role=\"status\"");
    expect(idx("childModeNow === 'off' && <PairedChildRequestReview")).toBeGreaterThan(idx('const childModeNow = nip55ChildMode;'));
  });

  it('the guardian\'s contact approval is withheld in child mode, and the page is told why', () => {
    expect(app).toContain("onApproveContact={childModeNow === 'off' && activeDependant && childSettingsMap.get(activeDependant.id)?.contactPolicy === 'approved' ? async peer => {");
    expect(app).toContain("guardianApproves={childModeNow !== 'off' && !!activeDependant && childSettingsMap.get(activeDependant.id)?.contactPolicy === 'approved'}");
  });

  it('the private-backups status (rail names, turn-off-relay) is never rendered in child mode', () => {
    expect(app).toContain("const privateVaultBanner = !isPairedChild && childModeNow === 'off' && encryptionKey ? <PrivateVaultStatus");
    expect(idx('const privateVaultBanner =')).toBeGreaterThan(idx('const childModeNow = nip55ChildMode;'));
    // every other use goes through that one banner, so the Settings warning and Security & Backup follow it
    expect(app.match(/<PrivateVaultStatus/g)).toHaveLength(1);
    expect(app).toContain('const settingsBackupWarning = privateVaultBanner && privateVaultWarning');
  });
});

describe('child-mode page allowlist wiring', () => {
  it('the stable child id is the lock-proof one, not the carousel\'s', () => {
    expect(app).toContain('const stableChildId = signInChildDependant?.id || null;');
    expect(idx('const stableChildId = ')).toBeGreaterThan(idx('const signInChildDependant: ChildModeSignInDependant | null ='));
    expect(idx('const stableChildId = ')).toBeLessThan(idx('const childModePage = childModePageDecision({'));
    const call = app.slice(idx('const childModePage = childModePageDecision({'), idx('const cancelSignInReview'));
    expect(call).not.toContain('carousel.childDependant');
  });

  it('Decline clears every piece of request state a navigation to a refused page can stage', () => {
    const start = idx('const clearChildModeStagedRequests = () => {');
    const handler = app.slice(start, app.indexOf('}, [page,', idx('const declineChildModeGuardianPage = useCallback(() => {')));
    for (const setter of [
      'setPendingPublicProfileTarget(null)', 'setPendingPersonaFocus(null)', 'setPendingSecurityFocus(null)',
      'setSelectedContactId(null)', 'setSelectedKenPubkey(null)', 'setSelectedCredential(null)',
      'setPendingOperatorImportText(null)', 'setPendingOwnerChoice(null)', 'setPendingBotContacts(undefined)',
      'setPendingContactInvite(undefined)', 'setPendingInviteSender(undefined)', 'setFamilyContactsUnlocked(false)',
      'setPendingPairingRequest(null)', 'setPendingContactsGrantV2(null)', 'setHeldContactsGrantV2(null)',
    ]) expect(handler, setter).toContain(setter);
    // clearing is not conditional on the page: it runs before the page-specific answers
    expect(handler.indexOf('clearChildModeStagedRequestsRef.current();')).toBeLessThan(handler.indexOf("if (page === 'approve-add-dependant')"));
    expect(handler).toContain("navigateReplace('home')");
  });

  it('the start-up read of the saved session fails closed', () => {
    expect(app).toContain('readSavedChildMode({ loadSession: loadChildModeSession, loadFacts: loadDependantSignInFacts })');
    const start = idx('readSavedChildMode({ loadSession');
    const read = app.slice(start, app.indexOf('return () => { live = false; };', start));
    expect(read).not.toContain('.catch');
    expect(read).not.toContain('setSavedChildMode(null); });');
  });

  it('the PIN exit clears a saved (or unresolved) child mode, and the banner offers it then', () => {
    const start = idx('const handleExitChildMode = useCallback(async () => {');
    const handler = app.slice(start, app.indexOf('}, [carousel.exitChildMode', start));
    expect(handler.indexOf('requestFreshAuth')).toBeLessThan(handler.indexOf('setSavedChildMode(null)'));
    expect(handler).toContain('childModeRestoredRef.current = true;');
    expect(app).toContain('childModeSavedExitable={!carousel.childMode && (savedChildMode === CHILD_MODE_UNRESOLVED || (!!savedChildMode && !!encryptionKey))}');
  });

  it('the child viewer of Settings has no Verification photo row and no signer banner', () => {
    const start = idx("if (page === 'settings') {");
    const block = app.slice(start, app.indexOf('return renderSettingsPage(', start));
    expect(block).toContain("onUpdatePhoto={carousel.childMode ? undefined : () => navigateTo('photo-capture')}");
    expect(block).toContain('{carousel.childMode ? topBannersWithoutSigner : topBanners}');
    expect(app).toContain('const topBannersFor = (signer: React.ReactNode)');
    expect(app).toContain('const topBannersWithoutSigner = topBannersFor(null);');
  });
});
