/**
 * D7: the gate's pass-forward entry is reachable from the answer seal pass
 * only. The NIP-46 server (`useBunkerServer`) and NIP-55 (`useNip55Server`)
 * paths are handed `authorise` alone — checked here on the source, as the
 * App.tsx wiring has no unit seam.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const between = (text: string, from: string, to: string) => {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`markers not found: ${from} … ${to}`);
  return text.slice(a, b);
};

describe('forwardPassed reach (D7)', () => {
  it('the NIP-46 and NIP-55 servers never name it', () => {
    expect(src('hooks/useBunkerServer.ts')).not.toMatch(/forwardPassed/);
    expect(src('hooks/useNip55Server.ts')).not.toMatch(/forwardPassed/);
    expect(src('lib/nip55.ts')).not.toMatch(/forwardPassed/);
  });

  it('App.tsx hands the child NIP-46 routes and NIP-55 the gate\'s authorise only', () => {
    const app = src('App.tsx');
    const routes = between(app, 'gateFor: (persona) => ({', 'onConnect:');
    expect(routes).toContain('childGateRef.current.authorise(');
    expect(routes).not.toMatch(/forwardPassed/);
    const nip55 = between(app, 'const nip55Gate = useMemo(', 'const nip55 = useNip55Server(');
    expect(nip55).toContain('childGateRef.current.authorise(');
    expect(nip55).not.toMatch(/forwardPassed/);
  });

  it('the child-bunker route and sign-in helpers take an authorise-shaped function only', () => {
    expect(src('lib/child-bunker.ts')).not.toMatch(/forwardPassed/);
  });
});

describe('Part B: the child\'s relay-mode sign-in wiring (App.tsx)', () => {
  const app = src('App.tsx');
  const approve = between(app, 'const approveAuthUnguarded = useCallback(', '// ── Redirect mode (no relay)');

  it('the sign-in marker is set only here: the NIP-46 and NIP-55 paths never name it', () => {
    for (const f of ['hooks/useBunkerServer.ts', 'hooks/useNip55Server.ts', 'lib/nip55.ts', 'lib/child-bunker.ts']) {
      expect(src(f)).not.toMatch(/\bsignIn\b/);
    }
    const marks = [...app.matchAll(/signIn: \{ sharesHandle/g)];
    expect(marks).toHaveLength(1);
    expect(approve).toContain('signIn: { sharesHandle: !!handleToShare }');
  });

  it('relay mode on a direct child wraps the backend in the seal pass for the 21236 and its authEvent answer', () => {
    expect(approve).toMatch(/const childDirectRelaySignIn = childDirect && selection\.source === 'guardian' && !!\(request\.relay && request\.sessionPubkey\);/);
    const block = between(approve, 'if (childDirectRelaySignIn) {', 'const { authEvent } = await signAuthChallenge(');
    expect(block).toContain('answerSealingBackend({');
    expect(block).toContain('eligibleKind: 21236,');
    expect(block).toContain("responseField: 'authEvent',");
    expect(block).toContain('sessionPubkey: sessionPubkey!,');
    expect(block).toContain('siteOrigin: origin,');
    expect(block).toContain('authorise: (r) => childGateRef.current.authorise(r).then(touched)');
    // inside the relay branch, before the sign-in is signed
    expect(approve.indexOf('if (isRelayMode) {')).toBeLessThan(approve.indexOf('if (childDirectRelaySignIn) {'));
  });

  it('redirect mode, and every other path, keeps today\'s site gate', () => {
    expect(approve).toContain("if (childDirect && selection.source === 'guardian' && !childDirectRelaySignIn) {");
    const redirect = between(approve, "if (childDirect && selection.source === 'guardian' && !childDirectRelaySignIn) {", '// The resolution above may have awaited');
    expect(redirect).toContain('childSignInBackend({');
    expect(redirect).not.toContain('answerSealingBackend');
  });

  it('the wrap is built once, through the same backend, and reused by every retry', () => {
    const publish = between(approve, 'const doPublish = async () => {', 'await doPublish();');
    expect([...publish.matchAll(/wrapAuthResponse\(/g)]).toHaveLength(1);
    expect(publish).toMatch(/if \(!wrappedResponse\) \{\s*wrappedResponse = await wrapAuthResponse\(capturedResponse, capturedBackend, sessionPubkey\);/);
    expect(approve).toContain('const capturedBackend = selectedBackend;');
    expect(approve.indexOf('if (childDirectRelaySignIn) {')).toBeLessThan(approve.indexOf('const capturedBackend = selectedBackend;'));
  });
});
