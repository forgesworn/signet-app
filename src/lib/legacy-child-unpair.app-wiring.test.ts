import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8');

describe('legacy unpair notice wiring in App.tsx', () => {
  it('Revoke captures the notice target from a fresh record BEFORE the clear, and publishes only after it, never failing on it', () => {
    const start = app.indexOf('clearDependantBunkerEndpoint={async (pubkey) => {');
    expect(start).toBeGreaterThan(-1);
    const end = app.indexOf('return clearThenPublishLegacyUnpair(target, () => clearDependantBunkerEndpoint(pubkey, key));', start);
    expect(end).toBeGreaterThan(start);
    const body = app.slice(start, end);
    expect(body).toContain('loadFreshDependants(key)');
    expect(body).toContain('guardianToChildRelays(fresh, [preferences.relayUrl ?? DEFAULT_RELAY_URL])');
    // Nothing publishes ahead of the clear.
    expect(body).not.toContain('publishLegacyUnpairedNotice');
    expect(body).toContain('} catch { /* best effort */ }');
  });

  it('the child reads it on the inventory relay and feeds one unpaired flag to every surface', () => {
    expect(app).toContain('const legacyChildUnpaired = useLegacyChildUnpaired({');
    expect(app).toContain('const childUnpaired = childDeviceLink.unpaired || legacyChildUnpaired;');
    expect(app).toContain("enabled: preferences.signingMode === 'paired-child' && !!encryptionKey && !childUnpaired,");
    expect(app).toContain('const childApprovalsBanner = (childUnpaired ||');
  });
});
