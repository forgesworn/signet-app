import { describe, expect, it } from 'vitest';
import type { KnownPlace } from '../types/known-places';
import { badgesFor, primaryBadge } from './known-place-badges';

const NOW = 1_800_000_000;
const DAY = 86_400;

function place(over: Partial<KnownPlace> = {}): KnownPlace {
  return {
    id: 'https://a.example:' + 'a'.repeat(64),
    pubkey: 'a'.repeat(64),
    placeKey: 'https://a.example',
    kind: 'sign-in',
    name: 'A',
    channel: 'browser',
    signer: 'local',
    firstAt: NOW - 10 * DAY,
    lastAt: NOW - DAY,
    uses: 1,
    shared: {},
    ...over,
  };
}

const kinds = (p: KnownPlace, ctx: Partial<Parameters<typeof badgesFor>[1]> = {}) =>
  badgesFor(p, { now: NOW, ...ctx }).map(b => b.kind);

describe('badgesFor', () => {
  it('claims no automatic signing while the paired clients are still loading', () => {
    const nc = place({ kind: 'nip46', channel: 'nip46' });
    expect(kinds(nc, { askToSign: undefined })).toContain('auto');
    expect(kinds(nc, { askToSign: undefined, loading: true })).not.toContain('auto');
  });

  it('gives a plain recent sign-in no badges', () => {
    expect(badgesFor(place(), { now: NOW })).toEqual([]);
    expect(primaryBadge([])).toBeNull();
  });

  it('flags expiry within seven days, not beyond, and not once past', () => {
    expect(kinds(place(), { expiresAt: NOW + 6 * DAY })).toEqual(['expires-soon']);
    expect(kinds(place(), { expiresAt: NOW + 7 * DAY })).toEqual(['expires-soon']);
    expect(kinds(place(), { expiresAt: NOW + 8 * DAY })).toEqual([]);
    expect(kinds(place(), { expiresAt: NOW - 1 })).toEqual([]);
  });

  it('marks a paired app that does not ask to sign as automatic', () => {
    const p = place({ kind: 'nip46', channel: 'nip46' });
    expect(kinds(p, { askToSign: false })).toEqual(['auto']);
    expect(kinds(p, { askToSign: undefined })).toEqual(['auto']);
    expect(kinds(p, { askToSign: true })).toEqual([]);
  });

  it('marks a phone app with an allow-always grant as automatic', () => {
    const p = place({ kind: 'nip55', channel: 'nip55' });
    expect(kinds(p, { nip55Grant: { allowAlways: true, denyAlways: false } })).toEqual(['auto']);
    expect(kinds(p, { nip55Grant: { allowAlways: false, denyAlways: false } })).toEqual([]);
    expect(kinds(p, { nip55Grant: { allowAlways: false, denyAlways: true } })).toEqual([]);
    expect(kinds(p, { nip55Grant: null })).toEqual([]);
  });

  it('never calls a sign-in automatic, whatever the context says', () => {
    expect(kinds(place(), { askToSign: false, nip55Grant: { allowAlways: true, denyAlways: false } })).toEqual([]);
  });

  it('marks Heartwood-approved and other-device places', () => {
    expect(badgesFor(place({ signer: 'heartwood' }), { now: NOW })).toEqual([
      { kind: 'heartwood', label: 'Approved on Heartwood' },
    ]);
    expect(badgesFor(place({ channel: 'other-device' }), { now: NOW })).toEqual([
      { kind: 'other-device', label: 'Another device' },
    ]);
  });

  it('words the shared badge for handle, picture or both', () => {
    expect(badgesFor(place({ shared: { handle: true } }), { now: NOW })[0].label).toBe('Shared handle');
    expect(badgesFor(place({ shared: { picture: true } }), { now: NOW })[0].label).toBe('Shared picture');
    expect(badgesFor(place({ shared: { handle: true, picture: true } }), { now: NOW })[0].label).toBe(
      'Shared handle and picture',
    );
    expect(kinds(place({ shared: { handle: false, picture: false } }))).toEqual([]);
  });

  it('marks pinned places', () => {
    expect(badgesFor(place({ pinned: true }), { now: NOW })).toEqual([{ kind: 'pinned', label: 'Pinned' }]);
  });

  it('marks places unused for more than 90 days', () => {
    expect(kinds(place({ lastAt: NOW - 90 * DAY }))).toEqual([]);
    expect(badgesFor(place({ lastAt: NOW - 91 * DAY }), { now: NOW })).toEqual([
      { kind: 'dormant', label: 'Not used in 3 months' },
    ]);
  });

  it('orders badges by precedence and picks the first as primary', () => {
    const p = place({
      kind: 'nip46',
      channel: 'other-device',
      signer: 'heartwood',
      shared: { handle: true },
      pinned: true,
      lastAt: NOW - 200 * DAY,
    });
    const badges = badgesFor(p, { now: NOW, askToSign: false, expiresAt: NOW + DAY });
    expect(badges.map(b => b.kind)).toEqual([
      'expires-soon',
      'auto',
      'heartwood',
      'other-device',
      'shared',
      'pinned',
      'dormant',
    ]);
    expect(primaryBadge(badges)).toEqual({ kind: 'expires-soon', label: 'Expires soon' });
    expect(primaryBadge(badges.slice(1))?.kind).toBe('auto');
  });
});
