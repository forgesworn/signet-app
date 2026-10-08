import { describe, expect, it, vi } from 'vitest';
import type { SignetIdentity } from '../types';
import { buildContactCard, contactCardInfoFor, ContactCardPhotoError, defaultCardChoice, partnerCardOf, shareCopyReady } from './contact-card-share';

const P = 'a'.repeat(64), X = 'b'.repeat(64), NP = 'c'.repeat(64), PRO = 'd'.repeat(64);
const photo = { key: '1'.repeat(64), server: 'https://blossom.example.com/', hash: '2'.repeat(64) };
const identity = {
  persona: { publicKey: P, displayName: 'Pip', avatarHash: 'h', avatarBlossomUrl: 'https://b.example.com', avatarKey: 'k' },
  naturalPerson: { publicKey: NP, displayName: '' },
  extraPersonas: [{ publicKey: X, displayName: 'Work', avatarHash: 'h' }],
  professionalPersona: { publicKey: PRO, displayName: 'Dr Pip' },
} as unknown as SignetIdentity;

describe('contactCardInfoFor', () => {
  it('offers the name, and the photo only when the persona has a complete in-app picture', () => {
    expect(contactCardInfoFor(identity, P, { pairedChild: false })).toEqual({ name: 'Pip', hasPhoto: true });
    expect(contactCardInfoFor(identity, X, { pairedChild: false })).toEqual({ name: 'Work', hasPhoto: false }); // hash only: no URL or key
    expect(contactCardInfoFor(identity, NP, { pairedChild: false })).toEqual({ name: '', hasPhoto: false });
    expect(contactCardInfoFor(identity, PRO, { pairedChild: false })).toEqual({ name: 'Dr Pip', hasPhoto: false });
  });
  it('is null on a paired-child install, for an unknown pubkey, and with no identity', () => {
    expect(contactCardInfoFor(identity, P, { pairedChild: true })).toBeNull();
    expect(contactCardInfoFor(identity, 'e'.repeat(64), { pairedChild: false })).toBeNull();
    expect(contactCardInfoFor(null, P, { pairedChild: false })).toBeNull();
  });
});

describe('defaultCardChoice', () => {
  it('has the name on when there is one and the photo always off', () => {
    expect(defaultCardChoice({ name: 'Pip', hasPhoto: true })).toEqual({ name: true, photo: false });
    expect(defaultCardChoice({ name: '', hasPhoto: true })).toEqual({ name: false, photo: false });
  });
});

describe('buildContactCard', () => {
  it('builds name only without touching the share step', async () => {
    const share = vi.fn(async () => photo);
    expect(await buildContactCard({ name: true, photo: false }, { name: 'Pip', hasPhoto: true }, share)).toEqual({ name: 'Pip' });
    expect(share).not.toHaveBeenCalled();
  });
  it('shares the photo exactly once, on build, and puts it in the card with the name', async () => {
    const share = vi.fn(async () => photo);
    const card = await buildContactCard({ name: true, photo: true }, { name: 'Pip', hasPhoto: true }, share);
    expect(share).toHaveBeenCalledTimes(1);
    expect(card).toEqual({ name: 'Pip', photo });
  });
  it('omits a name that is switched off, and returns no card when nothing is chosen', async () => {
    const share = vi.fn(async () => photo);
    expect(await buildContactCard({ name: false, photo: true }, { name: 'Pip', hasPhoto: true }, share)).toEqual({ photo });
    expect(await buildContactCard({ name: false, photo: false }, { name: 'Pip', hasPhoto: true }, share)).toBeUndefined();
    expect(await buildContactCard({ name: true, photo: false }, { name: '', hasPhoto: false }, share)).toBeUndefined();
  });
  it('throws ContactCardPhotoError when the share step fails, or the photo is not one the wire carries, or there is no picture', async () => {
    const info = { name: 'Pip', hasPhoto: true };
    await expect(buildContactCard({ name: true, photo: true }, info, async () => { throw new Error('upload failed'); })).rejects.toBeInstanceOf(ContactCardPhotoError);
    await expect(buildContactCard({ name: true, photo: true }, info, async () => ({ ...photo, server: 'http://blossom.example.com' }))).rejects.toBeInstanceOf(ContactCardPhotoError);
    const share = vi.fn(async () => photo);
    await expect(buildContactCard({ name: true, photo: true }, { name: 'Pip', hasPhoto: false }, share)).rejects.toBeInstanceOf(ContactCardPhotoError);
    expect(share).not.toHaveBeenCalled();
  });
});

describe('partnerCardOf', () => {
  const request = { card: { name: 'Req' } } as never, acceptance = { card: { name: 'Acc' } } as never;
  it('reads the acceptance for a requester and the request for a recipient', () => {
    expect(partnerCardOf({ role: 'requester', request, acceptance })).toEqual({ name: 'Acc' });
    expect(partnerCardOf({ role: 'recipient', request, acceptance })).toEqual({ name: 'Req' });
    expect(partnerCardOf({ role: 'requester', request, acceptance: undefined })).toBeUndefined();
  });
});

describe('M5: shareCopyReady', () => {
  const copy = { contactAvatarKey: '1'.repeat(64), contactAvatarHash: '2'.repeat(64), contactAvatarBlossomUrl: 'https://b.example.com', contactAvatarUpdatedAt: 1000 };
  it('returns a current, published copy as it stands', () => {
    expect(shareCopyReady({ ...copy, avatarUpdatedAt: 900 })).toEqual({ key: copy.contactAvatarKey, server: copy.contactAvatarBlossomUrl, hash: copy.contactAvatarHash });
    expect(shareCopyReady({ ...copy, avatarUpdatedAt: 1000 })).not.toBeNull(); // made in the same second as the change
    expect(shareCopyReady(copy)).not.toBeNull();
  });
  it('returns null when the in-app picture changed after the copy was made', () => {
    expect(shareCopyReady({ ...copy, avatarUpdatedAt: 1001 })).toBeNull();
  });
  it('returns null for no copy, a partial copy and a stale-flagged one', () => {
    expect(shareCopyReady(null)).toBeNull();
    expect(shareCopyReady({})).toBeNull();
    expect(shareCopyReady({ ...copy, contactAvatarHash: undefined })).toBeNull();
    expect(shareCopyReady({ ...copy, contactAvatarStale: true })).toBeNull();
  });
});
