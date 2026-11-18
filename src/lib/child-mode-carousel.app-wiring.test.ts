import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * App.tsx is too large to render, so this pins how the carousel is locked down in
 * child mode: the ring is the child's, one stable child id decides which rows are
 * the child's, the QR / places / camera / handshake columns follow it.
 */
const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8');
const idx = (needle: string) => {
  const i = app.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};

describe('child-mode carousel wiring in App.tsx', () => {
  it('the ring is told child mode is on while the saved session is still waiting to restore', () => {
    expect(app).toContain('useCarousel(identity, dependants, botInventory, childCarouselAllowed, childCarouselBound, savedChildMode !== null)');
    // The saved read is state declared above the hook, or the argument would be a TDZ error.
    expect(idx('const [savedChildMode, setSavedChildMode]')).toBeLessThan(idx('useCarousel(identity, dependants'));
  });

  it('the carousel gets the stable child id, not its own child state', () => {
    expect(app).toContain('stableChildId={signInChildDependant?.id || null}');
  });

  it('the standing-invite card is never rendered in child mode', () => {
    const at = idx('renderInviteCard={(_row, resolved, renderPublicCard) =>');
    expect(app.slice(at, at + 200)).toContain('!signInChildMode &&');
  });

  it('the places column: foreign rows get nothing, the child gets Open only', () => {
    const start = idx('const knownPlacesColumn = (row: CarouselRow, resolved: ResolvedIdentity)');
    const body = app.slice(start, start + 2600);
    expect(body).toContain("childModeRowScope(row, carousel.childMode, signInChildDependant?.id ?? null)");
    expect(body).toContain("=== 'foreign') return null;");
    expect(body).toContain('readOnly={inChildMode}');
    expect(body).toContain('actions={inChildMode ? readOnlyPlaceActions(knownPlaceActions) : knownPlaceActions}');
  });

  it('a scanned contact invite is refused in child mode, before anything is parked for the guardian', () => {
    const start = idx('const handleCarouselQRScanned = useCallback(');
    const body = app.slice(start, start + 4200);
    const refuse = body.indexOf("case 'contact-invite':");
    expect(refuse).toBeGreaterThan(-1);
    expect(body.indexOf("if (childModeNow !== 'off') return CHILD_MODE_SCAN_INVITE_COPY;")).toBeGreaterThan(refuse);
    expect(body.indexOf("if (childModeNow !== 'off') return CHILD_MODE_SCAN_INVITE_COPY;")).toBeLessThan(body.indexOf('setPendingContactInvite('));
  });

  it('every other scan type still lands on a page or handler the allowlist decides', () => {
    const start = idx('const handleCarouselQRScanned = useCallback(');
    const body = app.slice(start, app.indexOf('const handleApproveFromCarousel', start));
    for (const [type, sink] of [
      ['verify', "navigateTo('approve-verification')"], ['companion-pair', "navigateTo('approve-companion-grant')"],
      ['contacts-pair-v2', "navigateTo('contacts-grant-approve')"], ['heartwood-operator-import', "navigateTo('settings-advanced')"],
    ] as const) {
      const at = body.indexOf(`case '${type}':`);
      expect(at, type).toBeGreaterThan(-1);
      expect(body.slice(at, at + 700), type).toContain(sink);
    }
    expect(body).toContain("navigateTo('web-verify')");
  });

  it('the handshake page carries the child-mode banner like the other child pages', () => {
    const at = idx('<Layout title={HANDSHAKE_COPY.title} showBack onBack={navigateBack}');
    expect(app.slice(at, at + 120)).toContain('{...guardianLayoutProps}');
  });
});
