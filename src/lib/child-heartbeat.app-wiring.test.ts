import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8');

describe('child Heartwood heartbeat wiring in App.tsx', () => {
  it('pings only on a direct child, unlocked, with the router up', () => {
    expect(app).toContain('enabled: childDirect && !!encryptionKey && !!bunkerRouter,');
    expect(app).toContain("bunkerBackend.request('ping', [], CHILD_HEARTBEAT_TIMEOUT_MS)");
  });

  it('feeds the lost state into the signer line', () => {
    expect(app).toMatch(/childSignerKind\(\{[^}]*lost: childHeartwoodLost[^}]*\}\)/);
  });

  it('feeds the unpaired state into the signer line and wires Pair again to the repair page', () => {
    expect(app).toMatch(/childSignerKind\(\{[^}]*unpaired: childUnpaired[^}]*\}\)/);
    // Direct (childDeviceLink) or legacy (the guardian's unpaired notice).
    expect(app).toContain('const childUnpaired = childDeviceLink.unpaired || legacyChildUnpaired;');
    expect(app).toContain("onPairAgain={() => navigateTo('paired-child-repair')}");
  });

  it('the ready notice is withheld while the Heartwood is lost', () => {
    expect(app).toContain("(childReadySummary === 'ready' && !childHeartwoodLost && childDeviceLink.readyThisSession)");
  });
});
