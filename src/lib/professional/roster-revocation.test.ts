import { describe, it, expect } from 'vitest';
import { buildRosterRevocationEvent } from './role-anchor';
import { verifyEvent } from 'signet-protocol';

const LEAD_PRIVKEY = '0'.repeat(63) + '1';
const MEMBER_A = 'aaa' + '0'.repeat(61);
const MEMBER_B = 'bbb' + '0'.repeat(61);

describe('buildRosterRevocationEvent', () => {
  it('produces a kind-30202 event excluding the revoked member', async () => {
    const ev = await buildRosterRevocationEvent(
      {
        identifier: { kind: 'URN', value: '100000' },
        professionKind: 'school',
        remainingMembers: [
          { pubkey: MEMBER_A, subRole: 'form-tutor', scope: '8A' },
        ],
        revokedPubkey: MEMBER_B,
      },
      LEAD_PRIVKEY,
    );
    expect(ev.kind).toBe(30202);
    const content = JSON.parse(ev.content) as { members: { pubkey: string }[] };
    expect(content.members.map(m => m.pubkey)).not.toContain(MEMBER_B);
    expect(content.members.map(m => m.pubkey)).toContain(MEMBER_A);
    expect(ev.tags.find(t => t[0] === 'revoked')?.[1]).toBe(MEMBER_B);
    expect(await verifyEvent(ev)).toBe(true);
  });

  it('publishes an empty roster when the last member is revoked', async () => {
    const ev = await buildRosterRevocationEvent(
      {
        identifier: { kind: 'URN', value: '100000' },
        professionKind: 'school',
        remainingMembers: [],
        revokedPubkey: MEMBER_A,
      },
      LEAD_PRIVKEY,
    );
    const content = JSON.parse(ev.content) as { members: unknown[] };
    expect(content.members).toHaveLength(0);
    expect(await verifyEvent(ev)).toBe(true);
  });
});
