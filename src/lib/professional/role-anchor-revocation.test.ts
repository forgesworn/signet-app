import { describe, it, expect } from 'vitest';
import { buildRoleAnchorRevocationEvent } from './role-anchor';
import { verifyEvent } from 'signet-protocol';

const LEAD_PRIVKEY = '0'.repeat(63) + '1';

describe('buildRoleAnchorRevocationEvent', () => {
  it('produces a kind-30204 event with correct d tag', async () => {
    const ev = await buildRoleAnchorRevocationEvent(
      { identifier: { kind: 'URN', value: '100000' }, professionKind: 'school' },
      LEAD_PRIVKEY,
    );
    expect(ev.kind).toBe(30204);
    expect(ev.tags.find(t => t[0] === 'd')?.[1]).toBe('URN:100000');
    expect(await verifyEvent(ev)).toBe(true);
  });

  it('includes a reason field in content', async () => {
    const ev = await buildRoleAnchorRevocationEvent(
      {
        identifier: { kind: 'CQC-ProviderID', value: 'RXL' },
        professionKind: 'gp-practice',
        reason: 'Practice closed',
      },
      LEAD_PRIVKEY,
    );
    const content = JSON.parse(ev.content) as { reason?: string };
    expect(content.reason).toBe('Practice closed');
  });
});
