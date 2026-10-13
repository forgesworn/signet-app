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

  it('only the app-permission approval and the child\'s relay-mode sign-in (Part B) hand the gate\'s pass-forward entry to anything', () => {
    const lines = app.split('\n').filter(l => l.includes('forwardPassed'));
    expect(lines).toHaveLength(2);
    const approve = between('const handleApproveAppPermission = useCallback(', '// ── Third-party add-dependant approval');
    expect(approve).toContain('forwardPassed: (r) => childGateRef.current.forwardPassed({ ...r, abort: withdraw.signal })');
    const signIn = between('if (childDirectRelaySignIn) {', 'const { authEvent } = await signAuthChallenge(');
    expect(signIn).toContain('forwardPassed: (r) => childGateRef.current.forwardPassed(r).then(touched)');
    expect(lines.filter(l => approve.includes(l) || signIn.includes(l))).toHaveLength(2);
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

  it('M2: Cancel withdraws the held ask before answering; both gate entries carry the signal', () => {
    const approve = between('const handleApproveAppPermission = useCallback(', '// ── Third-party add-dependant approval');
    expect(approve).toContain('authorise: (r) => childGateRef.current.authorise({ ...r, abort: withdraw.signal })');
    expect(approve).toContain('appPermissionWithdrawRef.current.set(req, withdraw)');
    const cancel = between('const handleCancelAppPermission = useCallback(', 'const handleApproveAppPermission = useCallback(');
    expect(cancel.indexOf('appPermissionWithdrawRef.current.get(req)?.abort()')).toBeGreaterThan(-1);
    expect(cancel.indexOf('appPermissionWithdrawRef.current.get(req)?.abort()')).toBeLessThan(cancel.indexOf('declineAppPermission(req)'));
  });

  it('M4: a second link while one is open is refused: nothing stashed, the first untouched, a banner shown', () => {
    const consume = between('const consumeAppPermissionUrl = useCallback(', '  useEffect(() => {\n    consumeAppPermissionUrl(');
    const guard = consume.indexOf('if (pendingAppPermissionRef.current) {');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(consume.indexOf('setPendingAppPermissionRequest(url.request)'));
    const refused = consume.slice(guard, consume.indexOf('}', guard));
    expect(refused).toContain('setAppPermissionNotice(APP_PERMISSION_COPY.anotherOpen)');
    expect(refused).toContain('return true');
    expect(refused).not.toMatch(/setPendingAppPermissionRequest|declineAppPermission|giftWrap|publish/);
  });

  it('M4: the page is keyed by its request, and the notice banner shows over it', () => {
    const branch = between("if (page === 'approve-app-permission' && pendingAppPermissionRequest", '// Approve third-party Add Dependant');
    expect(branch).toContain('key={appPermissionRequestKey(pendingAppPermissionRequest)}');
    expect(branch).toContain('{appPermissionNoticeBanner}');
  });

  it('M5: the handler refuses an unconfirmed real-name identity before anything is marked or signed', () => {
    const approve = between('const handleApproveAppPermission = useCallback(', '// ── Third-party add-dependant approval');
    const check = approve.indexOf('appPermissionNeedsRealIdentityConfirm(route, identity, requireNpConfirmation) && opts?.realIdentityConfirmed !== true');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(approve.indexOf("marks.set(req, 'approving')"));
    const branch = between("if (page === 'approve-app-permission' && pendingAppPermissionRequest", '// Approve third-party Add Dependant');
    expect(branch).toContain('confirmRealIdentity={appPermissionNeedsRealIdentityConfirm(appPermissionRoute, identity, requireNpConfirmation)}');
  });

  it('M9: on a paired-child install, routing also waits for the paired-child record to load', () => {
    const effect = between('// After unlock, show a pending app-permission request.', 'const handleSetupComplete = useCallback(');
    const wait = "if (preferences.signingMode === 'paired-child' && pairedChildLoadedFor !== identity?.id) return;";
    expect(effect).toContain(wait);
    expect(effect.indexOf(wait)).toBeLessThan(effect.indexOf("navigateReplace('approve-app-permission')"));
    expect(effect).toMatch(/\}, \[[^\]]*pairedChildLoadedFor[^\]]*\]\);/);
    // The marker is set only once a load for this identity has settled, and cleared when it cannot be current.
    const load = between('const [pairedChildClientKeypair, setPairedChildClientKeypair]', '// Child-direct Heartwood pairing');
    expect([...load.matchAll(/setPairedChildLoadedFor\(identity\.id\)/g)]).toHaveLength(2);
    expect([...load.matchAll(/setPairedChildLoadedFor\(null\)/g)].length).toBeGreaterThanOrEqual(3);
  });

  it('M11: a decline shows the ack only when the app-permission page is on screen; elsewhere it is silent', () => {
    const decline = between('const declineAppPermission = useCallback(', 'const handleCancelAppPermission = useCallback(');
    const guard = decline.indexOf("if (pageRef.current === 'approve-app-permission') {");
    expect(guard).toBeGreaterThan(-1);
    const shown = decline.slice(guard, decline.indexOf('\n    }\n', guard));
    expect(shown).toContain('setRelayAuthAckState(');
    expect(shown).toContain("navigateReplace('relay-auth-ack')");
    expect([...decline.matchAll(/navigateReplace\(/g)]).toHaveLength(1);
    expect([...decline.matchAll(/setRelayAuthAckState\(/g)]).toHaveLength(1);
    // the answer still goes out, and the request is still retired
    expect(decline).toContain('setPendingAppPermissionRequest(null)');
    expect(decline).toContain('giftWrap(rumor, req.sessionPubkey, refusal)');
    expect(app).toContain('const pageRef = useRef<Page>(page);');
  });
});
