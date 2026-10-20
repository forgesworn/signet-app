import { describe, expect, it } from 'vitest';
import type { NostrEvent } from 'signet-protocol';
import {
  displayName, formatBytes, pickActiveClaims, pickStatus, presenceLabel, presenceOf, relativeAge,
} from './keep';
import { claimEvent, newKey, statusEvent } from './keep-fixtures';

const me = newKey();
const persona = newKey();
const node = newKey();

describe('pickActiveClaims', () => {
  it('accepts a valid claim from the master key or a persona', () => {
    const a = claimEvent(me, node.pk, { name: 'Kitchen box', region: 'Scotland' });
    const n2 = newKey();
    const b = claimEvent(persona, n2.pk, { role: 'phone' });
    const claims = pickActiveClaims([a, b], [me.pk, persona.pk]);
    expect(claims.map(c => c.node).sort()).toEqual([node.pk, n2.pk].sort());
    expect(claims.find(c => c.node === node.pk)).toMatchObject({ name: 'Kitchen box', region: 'Scotland', role: 'box', eventId: a.id });
  });

  it('ignores a forged signature', () => {
    const good = claimEvent(me, node.pk);
    const forged = { ...good, sig: good.sig.slice(0, -2) + (good.sig.endsWith('00') ? '11' : '00') };
    const tamperedContent = { ...good, content: 'x' };
    expect(pickActiveClaims([forged as NostrEvent], [me.pk])).toEqual([]);
    expect(pickActiveClaims([tamperedContent as NostrEvent], [me.pk])).toEqual([]);
  });

  it('ignores a claim authored by a stranger even when its p tag names you', () => {
    const stranger = newKey();
    const hijack = claimEvent(stranger, node.pk, { extraP: [['p', me.pk, '', 'persona']] });
    expect(pickActiveClaims([hijack], [me.pk])).toEqual([]);
  });

  it('keeps the newest claim per node', () => {
    const older = claimEvent(me, node.pk, { createdAt: 100, name: 'Old name' });
    const newest = claimEvent(me, node.pk, { createdAt: 300, name: 'New name' });
    const mid = claimEvent(me, node.pk, { createdAt: 200, name: 'Mid name' });
    const claims = pickActiveClaims([older, newest, mid], [me.pk]);
    expect(claims).toHaveLength(1);
    expect(claims[0].name).toBe('New name');
  });

  it('hides a retired claim, including when it is newer than an active one', () => {
    const active = claimEvent(me, node.pk, { createdAt: 100 });
    const retired = claimEvent(me, node.pk, { createdAt: 200, status: 'retired' });
    expect(pickActiveClaims([retired], [me.pk])).toEqual([]);
    expect(pickActiveClaims([active, retired], [me.pk])).toEqual([]);
  });

  it('ignores a malformed claim (master tag not the signer, bad role)', () => {
    const other = newKey();
    const wrongMaster = claimEvent(me, node.pk, { extraP: [] });
    wrongMaster.tags = wrongMaster.tags.map(t => (t[3] === 'master' ? ['p', other.pk, '', 'master'] : t));
    expect(pickActiveClaims([wrongMaster], [me.pk])).toEqual([]);
    expect(pickActiveClaims([claimEvent(me, node.pk, { role: 'toaster' })], [me.pk])).toEqual([]);
  });
});

describe('pickStatus', () => {
  const claim = pickActiveClaims([claimEvent(me, node.pk)], [me.pk])[0];

  it('takes the newest valid status and reads free space and software', () => {
    const older = statusEvent(node, claim.eventId, { createdAt: 100, free: 1 << 30 });
    const newest = statusEvent(node, claim.eventId, { createdAt: 500, free: 5 * 2 ** 30, software: 'bothy-node/0.1.0' });
    expect(pickStatus([older, newest], claim)).toEqual({ createdAt: 500, freeBytes: 5 * 2 ** 30, software: 'bothy-node/0.1.0' });
  });

  it('ignores a status whose claim tag names a different claim', () => {
    expect(pickStatus([statusEvent(node, 'ab'.repeat(32))], claim)).toBeNull();
  });

  it('ignores a status from the wrong author', () => {
    const impostor = newKey();
    expect(pickStatus([statusEvent(impostor, claim.eventId)], claim)).toBeNull();
  });

  it('ignores a forged status and falls back to an older valid one', () => {
    const valid = statusEvent(node, claim.eventId, { createdAt: 100 });
    const good = statusEvent(node, claim.eventId, { createdAt: 900 });
    const forged = { ...good, sig: good.sig.slice(0, -2) + (good.sig.endsWith('00') ? '11' : '00') } as NostrEvent;
    expect(pickStatus([forged, valid], claim)?.createdAt).toBe(100);
  });

  it('returns null when there is no status', () => {
    expect(pickStatus([], claim)).toBeNull();
  });
});

describe('presence', () => {
  const status = { createdAt: 10_000 };
  it('is online under 10 minutes old, last seen from 10 minutes', () => {
    expect(presenceOf(status, 10_000 + 599)).toEqual({ state: 'online' });
    expect(presenceOf(status, 10_000 + 600)).toEqual({ state: 'last-seen', ageSeconds: 600 });
  });
  it('is unseen with no valid status', () => {
    expect(presenceLabel(presenceOf(null, 1))).toBe('Not seen yet');
  });
  it('words the labels', () => {
    expect(presenceLabel({ state: 'online' })).toBe('Online');
    expect(presenceLabel({ state: 'last-seen', ageSeconds: 3 * 3600 + 5 })).toBe('Last seen 3 hours ago');
    expect(relativeAge(600)).toBe('10 minutes ago');
    expect(relativeAge(3600)).toBe('1 hour ago');
    expect(relativeAge(2 * 86400)).toBe('2 days ago');
  });
});

describe('formatting', () => {
  it('formats bytes and names', () => {
    expect(formatBytes(21474836480)).toBe('20 GB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(0)).toBe('0 bytes');
    const claim = pickActiveClaims([claimEvent(me, node.pk, { name: 'Kitchen box' })], [me.pk])[0];
    expect(displayName(claim)).toBe('Kitchen box');
    expect(displayName(claim, '  Study  ')).toBe('Study');
    expect(displayName({ ...claim, name: undefined })).toBe('Your Keep');
  });
});
