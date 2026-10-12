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
