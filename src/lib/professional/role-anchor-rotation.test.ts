import { describe, it, expect } from 'vitest';
import { buildLeadKeyRotationEvent } from './role-anchor';
import { verifyEvent } from 'signet-protocol';

const NEW_PRIVKEY = '0'.repeat(63) + '2';

describe('buildLeadKeyRotationEvent', () => {
  it('produces a kind-30201 event signed by the new key', async () => {
    const ev = await buildLeadKeyRotationEvent(
      {
        identifier: { kind: 'URN', value: '100000' },
        professionKind: 'school',
        canonicalUrl: 'https://www.springfield-school.example',
        firmName: 'Springfield School',
        previousHeadPubkeyHex: 'abc' + '0'.repeat(61),
      },
      NEW_PRIVKEY,
    );
    expect(ev.kind).toBe(30201);
    expect(ev.tags.find(t => t[0] === 'prev-head')?.[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyEvent(ev)).toBe(true);
  });

  it('tags the previous head pubkey for audit trail', async () => {
    const prevPubkey = '1111' + '0'.repeat(60);
    const ev = await buildLeadKeyRotationEvent(
      {
        identifier: { kind: 'URN', value: '100000' },
        professionKind: 'school',
        canonicalUrl: 'https://www.springfield-school.example',
        firmName: 'Springfield School',
        previousHeadPubkeyHex: prevPubkey,
      },
      NEW_PRIVKEY,
    );
    expect(ev.tags.find(t => t[0] === 'prev-head')?.[1]).toBe(prevPubkey);
  });
});
