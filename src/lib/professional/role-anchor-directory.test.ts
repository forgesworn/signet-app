import { describe, it, expect } from 'vitest';
import { buildDirectoryAddEventSigned } from './role-anchor';
import { verifyEvent } from 'signet-protocol';

const MOCK_PRIVKEY = '0'.repeat(63) + '1';

describe('buildDirectoryAddEventSigned', () => {
  it('produces a kind-30203 event with correct tags', async () => {
    const ev = await buildDirectoryAddEventSigned(
      {
        firmName: 'Springfield School',
        identifier: { kind: 'URN', value: '100000' },
        canonicalUrl: 'https://www.springfield-school.example',
        professionKind: 'school',
      },
      MOCK_PRIVKEY,
    );
    expect(ev.kind).toBe(30203);
    expect(ev.tags.find(t => t[0] === 'd')?.[1]).toBe('URN:100000');
    expect(ev.tags.find(t => t[0] === 'profession')?.[1]).toBe('school');
    expect(ev.tags.find(t => t[0] === 'url')?.[1]).toBe('https://www.springfield-school.example');
    const parsed = JSON.parse(ev.content) as { firmName: string; listed: boolean };
    expect(parsed.firmName).toBe('Springfield School');
    expect(parsed.listed).toBe(true);
  });

  it('sets listed:false when optOut is true', async () => {
    const ev = await buildDirectoryAddEventSigned(
      {
        firmName: 'Private Surgery',
        identifier: { kind: 'CQC-ProviderID', value: 'RXL' },
        canonicalUrl: 'https://www.private-surgery.example',
        professionKind: 'gp-practice',
        optOut: true,
      },
      MOCK_PRIVKEY,
    );
    const parsed = JSON.parse(ev.content) as { listed: boolean };
    expect(parsed.listed).toBe(false);
    const tag = ev.tags.find(t => t[0] === 'listed');
    expect(tag?.[1]).toBe('false');
  });

  it('produces a validly signed event', async () => {
    const ev = await buildDirectoryAddEventSigned(
      {
        firmName: 'Springfield School',
        identifier: { kind: 'URN', value: '100000' },
        canonicalUrl: 'https://www.springfield-school.example',
        professionKind: 'school',
      },
      MOCK_PRIVKEY,
    );
    expect(await verifyEvent(ev)).toBe(true);
  });
});
