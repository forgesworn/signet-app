import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * App.tsx is too large to render in a unit test, so this pins how child mode
 * becomes the child acting on contacts (R-CHILD-MODE reversed 2026-11-18): one
 * scope-only actor, the saved child-mode state read by the scope, and every
 * guardian-data surface switched off.
 */
const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8');
const idx = (needle: string) => { const i = app.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
const between = (from: string, to: string) => app.slice(idx(from), app.indexOf(to, idx(from)));

describe('contacts scope reads the three-state child-mode signal', () => {
  it('feeds the scope the saved-aware state and the live child id, from below their declarations', () => {
    expect(app).toContain('    childModeNow,\n    childDependantId: carousel.childDependant?.id ?? null,');
    expect(app).toContain('childDependantId: carousel.childDependant?.id ?? null,');
    expect(app).not.toContain('childMode: carousel.childMode,\n    dependantCount');
    // No TDZ: the saved state and nip55ChildMode are declared before the scope memo reads them.
    const scope = idx('const contactsScope = useMemo(() => resolveContactsScope({');
    expect(idx('const [savedChildMode, setSavedChildMode]')).toBeLessThan(scope);
    expect(idx('const nip55ChildMode = childModeState({ live: carousel.childMode, saved: savedChildMode });')).toBeLessThan(scope);
    expect(idx('const childModeNow = nip55ChildMode;')).toBeLessThan(scope);
  });
});

describe('scope-only actor pubkey', () => {
  it('leaves contactsActorPubkey as the install-wide guardian identity', () => {
    expect(app).toContain("const contactsActorPubkey = isPairedChild ? (identity?.id?.toLowerCase() ?? '') : (stableActorPubkey(identity) ?? '');");
    // Every install-wide use still reads it.
    for (const site of [
      'activeGuardianPubkeys: contactsActorPubkey ? [contactsActorPubkey] : [],',
      "? { actorPubkey: contactsActorPubkey, actorRole: 'guardian', actorDeviceId: preferences.contactsDeviceId }",
      'buildManagerRows(familyContacts.directories, { actorPubkey: contactsActorPubkey })',
      'actorPubkey: contactsActorPubkey || null,',
      'actorPubkey: contactsActorPubkey, actorDeviceId, existingOps, now: Date.now(),',
    ]) expect(app, site).toContain(site);
  });

  it('feeds the scope actor to the contacts hook, the detail rights, own-block checks and both lists', () => {
    const hook = between('const contactsV2 = useContactsV2({', 'onMutated: bumpContactsV2,');
    expect(hook).toContain('encryptionKey && contactsScopeActor && preferences.contactsDeviceId');
    expect(hook).toContain('actorPubkey: contactsScopeActor,');
    expect(hook).toContain('actorRole: contactsScope.actorRole,');
    const detail = between("if (page === 'contact-detail' && selectedContactId) {", "if (page === 'contact-new')");
    expect(detail).toContain('actorPubkey: contactsScopeActor,\n    }, contactsActiveGuardianPubkeys);');
    expect(detail).toContain('ownBlocks(record, contactsScopeActor)');
    expect(detail).toContain('actorPubkey={contactsScopeActor}');
    expect(detail).not.toContain('contactsActorPubkey');
    const rolodex = between('onRefreshPictures={', 'subjectName={contactsScope.subjectName}');
    expect(rolodex).toContain('actorPubkey={contactsScopeActor}');
    expect(rolodex).not.toContain('contactsActorPubkey');
  });
});

describe('guardian data stays out of child mode', () => {
  it('shows the guardian name only outside child mode, on the detail page and the Rolodex', () => {
    expect(app.split('guardianName={activeDependant && !childContactsMode ? (identity?.naturalPerson.displayName || null) : null}').length).toBe(3);
    expect(app).not.toContain('guardianName={activeDependant ? (identity?.naturalPerson.displayName || null) : null}');
  });

  it('does not list the guardian\'s real-name key among the child\'s own keys on the confirm sheet', () => {
    const own = between('ownPubkeys={[...new Set([', 'onStartExchange=');
    expect(own).toContain('...(!childContactsMode && identity?.naturalPerson?.publicKey ? [identity.naturalPerson.publicKey.toLowerCase()] : [])');
    expect(own).not.toContain('...(identity?.naturalPerson?.publicKey');
  });

  it('matches no legacy members or kens, offers no own picture, and hides Refresh pictures', () => {
    const detail = between("if (page === 'contact-detail' && selectedContactId) {", "if (page === 'contact-new')");
    expect(detail).toContain('const legacyContact = childContactsMode ? undefined : members.find(');
    expect(detail).toContain('hasKenEntry: !childContactsMode && kens.some(');
    expect(detail).toContain('const pictureBackupEnv = encryptionKey && !childContactsMode');
    expect(app).toContain('onRefreshPictures={!isPairedChild && !childContactsMode && encryptionKey');
    expect(app).toContain("const childContactsMode = !isPairedChild && childModeNow !== 'off';");
  });
});

describe('writers that bypass the scope follow it', () => {
  it('stamps invite completion from the exchange, and starts child-mode exchanges as the child', () => {
    expect(app).toContain('actor: exchangeCompletionActor({ directoryId, exchange, guardianPubkey: owner, actorDeviceId }) });');
    expect(app).not.toContain("actorRole: directoryId === 'owner' ? 'owner' : 'guardian', actorDeviceId } });");
    expect(app).toContain("const scopeActsAsChild = !isPairedChild && contactsScope.actorRole === 'dependant';");
    expect(app).toContain("makeInviteService(contactsScope.directoryId ?? 'owner', () => true, undefined, scopeActsAsChild)");
    expect(app).toContain("makeInviteService(contactsScope.directoryId ?? 'owner', valid, undefined, scopeActsAsChild)");
    // Background and guardian-review services are not the child.
    expect(app).toContain("makeInviteService('owner', () => true)");
    expect(app).toContain('makeInviteService(`dependant:${child}`, guardianChildReviewCurrent,');
  });

  it('never lets the handshake page fall back to the owner invites while child mode has no child', () => {
    const handshake = between("if (page === 'contact-handshake' && handshakeRoute && encryptionKey) {", 'const route = handshakeRoute;');
    expect(handshake).toContain("if (childContactsMode && !contactsScope.directoryId) { navigateReplace('home'); return null; }");
  });

  it('writes a scanned npub and a recognised key through the scope-bound v2 hook only', () => {
    const scanned = between('const addScannedContact = useCallback(', '[contactsV2.recogniseContact, navigateTo]);');
    expect(scanned).toContain('contactsV2.recogniseContact(');
    const kenAdd = between("if (page === 'ken-add' && identity) {", "if (page === 'ken-detail'");
    expect(kenAdd).toContain('contactsV2.recogniseContact(entry.pubkey');
    expect(kenAdd).not.toContain('addKenEntry');
    expect(kenAdd).not.toContain('contactsActorPubkey');
  });
});
