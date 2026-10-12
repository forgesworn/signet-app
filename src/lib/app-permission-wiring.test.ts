/**
 * The App.tsx wiring of `?action=app-permission` has no unit seam, so the
 * properties that matter are checked on the source (as
 * `answer-seal-pass.reach.test.ts` does): the order of the native URL
 * consumers, that consuming a link never decides child-or-adult, and where
 * the gate's pass-forward entry is named.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = readFileSync(resolve(__dirname, '..', 'App.tsx'), 'utf8');
const between = (from: string, to: string) => {
  const a = app.indexOf(from);
  const b = app.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} … ${to}`);
  return app.slice(a, b);
};

describe('app-permission wiring in App.tsx', () => {
  it('the native root-carrier tries add-dependant, then app-permission, before the nostrconnect fallback', () => {
    const carrier = between("case 'root-carrier': {", "case 'none':");
    const i = (s: string) => carrier.indexOf(s);
    expect(i('consumeVerifyUrl(search)')).toBeGreaterThan(-1);
    expect(i('consumeAddDependantUrl(search)')).toBeGreaterThan(i('consumeVerifyUrl(search)'));
    expect(i('consumeAppPermissionUrl(search)')).toBeGreaterThan(i('consumeAddDependantUrl(search)'));
    expect(i('consumeNostrConnectUrl(search, true)')).toBeGreaterThan(i('consumeAppPermissionUrl(search)'));
  });

  it('the web mount runs the consumer, and the native callback lists it as a dependency', () => {
    expect(app).toContain('consumeAppPermissionUrl(window.location.search);');
    expect(between('const handleNativeUrl = useCallback(', 'useEffect(() => {\n    if (!isNativeApp()) return;')).toContain('consumeAppPermissionUrl, consumeNostrConnectUrl');
  });

  it('consuming a link clears the URL and only stashes: it never reads the signing mode', () => {
    const consume = between('const consumeAppPermissionUrl = useCallback(', '  useEffect(() => {\n    consumeAppPermissionUrl(');
    expect(consume).toContain('window.history.replaceState');
    expect(consume).toContain('setPendingAppPermissionRequest(url.request)');
    expect(consume).not.toMatch(/signingMode|childDirect|isPairedChild|preferences/);
  });

  it('routing waits for loaded preferences and identity', () => {
    const effect = between('// After unlock, show a pending app-permission request.', 'const handleSetupComplete = useCallback(');
    expect(effect).toContain('if (prefsLoading || identityLoading) return;');
    expect(effect.indexOf('if (prefsLoading || identityLoading) return;')).toBeLessThan(effect.indexOf("navigateReplace('approve-app-permission')"));
  });

  it('only the app-permission approval hands the gate\'s pass-forward entry to anything', () => {
    const lines = app.split('\n').filter(l => l.includes('forwardPassed'));
    expect(lines).toHaveLength(1);
    const approve = between('const handleApproveAppPermission = useCallback(', '// ── Third-party add-dependant approval');
    expect(approve).toContain('forwardPassed: (r) => childGateRef.current.forwardPassed(r)');
  });

  it('a single wrap is built per approval and never inside the publish retry', () => {
    const approve = between('const handleApproveAppPermission = useCallback(', '// ── Third-party add-dependant approval');
    expect([...approve.matchAll(/giftWrap\(/g)]).toHaveLength(1);
    const publish = between('const publishAppPermissionAnswer = useCallback(', 'const declineAppPermission = useCallback(');
    expect(publish).not.toMatch(/giftWrap\(/);
  });

  it('I1: only the guardian\'s own No declines; every other failure rethrows and sends nothing', () => {
    const approve = between('const handleApproveAppPermission = useCallback(', '// ── Third-party add-dependant approval');
    const c = approve.slice(approve.indexOf('} catch (e) {'));
    expect(c).toContain('classifyAppPermissionFailure(e)');
    expect(c).toMatch(/if \(failure\.kind === 'guardian-denied' && stillOpen\(\)\) \{\s*declineAppPermission\(req/);
    expect([...c.matchAll(/declineAppPermission\(/g)]).toHaveLength(1);
    expect(c).toContain("if (failure.kind === 'retry') throw new Error(failure.message);");
  });
});

