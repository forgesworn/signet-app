import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * App.tsx is too large to render in a unit test, so this pins how the Nostr
 * Connect approval's outcome is wired. A lock remounts the approval page; if
 * App stops holding the outcome (or the sign mode) for the request, the
 * request comes back looking unanswered, with Approve and Deny, and "Try
 * again" may silently use a different sign mode.
 */
const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8');
const count = (needle: string) => app.split(needle).length - 1;
const between = (from: string, to: string) => {
  const start = app.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = app.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  return app.slice(start, end);
};

describe('connect approval outcome wiring', () => {
  it('the page is rendered with the outcome and the sign mode kept for this request', () => {
    const block = between("if (page === 'approve-connect' && pendingConnectRequest && identity) {", '// Approve Companion Grant');
    expect(block).toContain('key={connectRequestKey}');
    expect(block).toContain('outcome={connectOutcome?.key === connectRequestKey ? connectOutcome : undefined}');
    expect(block).toContain('signChoice={connectSignChoice?.key === connectRequestKey ? connectSignChoice.mode : undefined}');
    expect(block).toContain('onSignChoice={(mode) => setConnectSignChoice({ key: connectRequestKey, mode })}');
    expect(block).toContain('onDeny={handleConnectDone}');
  });

  it('every approval runs through trackApproval, between beginApproval and endApproval (in a finally)', () => {
    const body = between('const handleApproveConnect = useCallback(', 'const handleConnectDone = useCallback(');
    const guard = body.indexOf('if (childModeSelectionRefused(');
    const begin = body.indexOf('connectSettlementRef.current.beginApproval(key)');
    const track = body.indexOf('await trackApproval({');
    const fin = body.indexOf('} finally {');
    const end = body.indexOf('connectSettlementRef.current.endApproval(key)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(begin);
    expect(begin).toBeLessThan(track);
    expect(track).toBeLessThan(fin);
    expect(fin).toBeLessThan(end);
    expect(count('approveConnectUnguarded(')).toBe(1);
  });

  it('trackApproval is given the one settlement, the live-request check and the outcome setter', () => {
    const body = between('await trackApproval({', '} finally {');
    expect(body).toContain('settlement: connectSettlementRef.current,');
    expect(body).toContain('isCurrent: () => pendingConnectRequestRef.current === request,');
    expect(body).toContain('record: setConnectOutcome,');
    expect(body).toContain('run: () => approveConnectUnguarded(sel, connectOptions),');
  });

  it('the outcome and the sign mode are cleared together with the request, and only there', () => {
    const effect = between('if (!pendingConnectRequest) {\n      setConnectPickerChoice(null);', '}, [pendingConnectRequest]);');
    expect(effect).toContain('setConnectOutcome(null);');
    expect(effect).toContain('setConnectSignChoice(null);');
    // The effect's null is the only direct write; trackApproval records the rest.
    expect(count('setConnectOutcome(')).toBe(1);
    // The effect's null, and the page's onSignChoice.
    expect(count('setConnectSignChoice(')).toBe(2);
  });

  it('closing an answered request sends no callback and returns to no app', () => {
    const branch = between("if (outcome === 'already-answered') {", 'return;');
    expect(branch).not.toContain('buildCallbackRedirect');
    expect(branch).not.toContain('returnToPreviousApp');
    expect(branch).toContain('setPendingConnectRequest(null);');
  });

  it('setPendingConnectRequest stays the only writer of the request, which isCurrent reads synchronously', () => {
    expect(count('setPendingConnectRequestState(')).toBe(1);
    const setter = between('const setPendingConnectRequest = useCallback(', '}, []);');
    expect(setter.indexOf('pendingConnectRequestRef.current = request;')).toBeGreaterThan(-1);
    expect(setter.indexOf('pendingConnectRequestRef.current = request;')).toBeLessThan(setter.indexOf('setPendingConnectRequestState(request)'));
  });
});
