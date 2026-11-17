import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * App.tsx is too large to render in a unit test, so this pins how the home
 * page is wired to the approval sheets. On a device run (2026-11-17) a direct-
 * paired child's ask reached the guardian's "Family asks" list and nothing
 * else: home never rendered the sheet, so the child waited until the guardian
 * happened to open the Bunker panel.
 */
const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8');
const count = (needle: string) => app.split(needle).length - 1;

describe('home page approval sheet', () => {
  it('home renders the sheet, once, after the auth and phone-app overlays', () => {
    expect(app).toMatch(/<\/Carousel>\s*\{authOverlay\}\{nip55Overlay\}\{homeApprovalOverlay\}/);
    expect(count('{homeApprovalOverlay}')).toBe(1);
  });

  it('never shows the approve UI in child mode or under a dependant scope, nor over the guardian\'s own sign-in', () => {
    // A child holding the guardian's phone sits on home in child mode.
    expect(app).toContain('const homeApprovalOverlay = carousel.childMode || activeDependant || pendingAuthRequest ? null');
  });

  it('a child\'s ask is never shown in child mode, on any page (Settings stays reachable there)', () => {
    expect(app).toContain(') : sheetChildAsks.length > 0 && !showAuthPrompt && !carousel.childMode ? (');
  });

  it('a phone app\'s request goes before a child\'s ask; a relay request keeps its place before both', () => {
    expect(app).toContain(': bunkerPendingApproval || !nip55.pending ? bunkerApprovalOverlay : null;');
  });
});
