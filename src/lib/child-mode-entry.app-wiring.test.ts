import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * App.tsx is too large to render in a unit test, so this pins how the entry
 * points that bypass the page decision read the three-state child-mode signal
 * (child-mode allowlist design, B3): the guardian's own NIP-46 routes, the
 * Bunker tab and approval overlay, and native notifications.
 */
const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8');
const count = (needle: string) => app.split(needle).length - 1;

describe('childModeNow is defined once, beside nip55ChildMode', () => {
  it('has a single definition, straight after nip55ChildMode and before the contacts scope', () => {
    expect(count('const childModeNow = ')).toBe(1);
    const nip55 = app.indexOf('const nip55ChildMode = childModeState(');
    const now = app.indexOf('const childModeNow = nip55ChildMode;');
    const scope = app.indexOf('const contactsScope = useMemo(');
    expect(nip55).toBeGreaterThan(-1);
    expect(now).toBeGreaterThan(nip55);
    expect(scope).toBeGreaterThan(now);
  });

  it('feeds the contacts scope and the child-contacts gate from childModeNow', () => {
    const start = app.indexOf('const contactsScope = useMemo(');
    const end = app.indexOf('const contactsIdentityLists', start);
    const block = app.slice(start, end);
    expect(block).toContain('childModeNow,');
    expect(block).not.toContain('nip55ChildMode');
    expect(app).toContain('const childContactsMode = !isPairedChild && childModeNow !== \'off\';');
  });
});

describe('NIP-46 owner routes', () => {
  it('the bunker server reads the signal fresh, through a ref, at request time', () => {
    expect(app).toContain('const childModeNowRef = useRef(childModeNow);');
    expect(app).toContain('childModeNowRef.current = childModeNow;');
    const start = app.indexOf('useBunkerServer({');
    const block = app.slice(start, start + 2500);
    expect(block).toContain('childModeNow: () => childModeNowRef.current,');
  });
});

describe('Bunker tab and approval overlay', () => {
  it('hide while child mode is on or still unknown', () => {
    const start = app.indexOf('<AppShell\n');
    const block = app.slice(start, start + 800);
    expect(block).toContain("isDependantContext={!!activeDependant || preferences.signingMode === 'paired-child' || childModeNow !== 'off'}");
    // The panel itself (family asks, signing controls) never opens either, however it was asked for.
    expect(app).toContain("{bunkerPanelOpen && childModeNow === 'off' && !isBarHiddenPage(page) && (");
    expect(app).toContain("if (bunkerPanelOpen && childModeNow !== 'off') setBunkerPanelOpen(false);");
    expect(app).toContain("const bunkerApprovalOverlay = bunkerPanelOpen || childModeNow !== 'off' ? null :");
  });
});

describe('native notifications', () => {
  it('escalation, pending-approval and child-ask notifications go through the generic child-mode line', () => {
    expect(count('notificationForChildMode(childModeNowRef.current,')).toBe(3);
    const esc = app.indexOf('const handleLiveEscalationNotice = useCallback');
    expect(app.slice(esc, esc + 600)).toContain('notificationForChildMode(childModeNowRef.current, escalationNotificationText(');
  });
});
