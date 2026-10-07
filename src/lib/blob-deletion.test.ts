import { describe, it, expect, vi, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  collectReferencedHashes, isBlobReferenced, deleteOwnedBlob, blobDeletionNote, serverFromBlobUrl, findSlotBlobs,
  deleteReplacedAvatar, deleteStoppedShareCopy, type BlobDeleter, type DeleteOutcome,
} from './blob-deletion';
import {
  AVATAR_UPLOADER_DOMAIN, CONTACT_AVATAR_UPLOADER_DOMAIN, PUBLIC_PICTURE_UPLOADER_DOMAIN, VENUE_PHOTO_UPLOADER_DOMAIN,
  hmacUploaderBackend,
} from './blossom-uploader';
import { uploadContactAvatar } from './avatar';
import {
  OLD_PHOTO_DELETED_COPY, OLD_PHOTO_NOT_DELETED_COPY, OLD_PICTURE_DELETED_COPY, OLD_PICTURE_NOT_DELETED_COPY,
  OLD_PICTURE_STAYS_COPY,
} from './blob-deletion-copy';

const KEY = 'correct-horse-battery-staple';
const SERVER = 'https://nostr.download';
const H1 = '11'.repeat(32);
const H2 = '22'.repeat(32);
const H3 = '33'.repeat(32);
const H4 = '44'.repeat(32);
const H5 = '55'.repeat(32);
const H6 = '66'.repeat(32);

/** A stored identity/dependant row with the slot shapes the app writes. */
function row(extra: Record<string, unknown> = {}) {
  return {
    id: 'a'.repeat(64),
    naturalPerson: { publicKey: 'n'.repeat(64) },
    persona: { publicKey: 'p'.repeat(64) },
    ...extra,
  };
}

/** A Blossom server stub: records each DELETE's decoded auth event. */
function stubDelete(status: number) {
  const sent: Array<{ url: string; method: string; event: { pubkey: string; kind: number; tags: string[][] } }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      method: init.method ?? 'GET',
      event: JSON.parse(atob((init.headers as Record<string, string>).Authorization.replace(/^Nostr /, ''))),
    });
    return new Response(status === 204 ? null : '', { status });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const noRows = async () => [] as unknown[];

describe('R1: never delete a blob something still references', () => {
  it('collects every hash field on every slot kind, and the venue photo on the identity and the dependant', () => {
    const rows = [
      row({
        photoHash: H1,
        naturalPerson: { pictureBlossomHash: H2 },
        persona: { bannerBlossomHash: H3, avatarHash: H4 },
        professionalPersona: { pictureBlossomHash: H5 },
        extraPersonas: [{ contactAvatarHash: H6 }],
      }),
      // A dependant row: its own venue photo and extra persona.
      { id: 'dependant:x', photoHash: 'ab'.repeat(32), extraPersonas: [{ avatarHash: 'cd'.repeat(32) }], persona: { pictureBlossomHash: 'ef'.repeat(32) } },
    ];
    const hashes = collectReferencedHashes(rows);
    for (const h of [H1, H2, H3, H4, H5, H6, 'ab'.repeat(32), 'cd'.repeat(32), 'ef'.repeat(32)]) expect(hashes.has(h)).toBe(true);
    expect(hashes.size).toBe(9);
  });

  it('S1: the picture and banner of a slot\'s published kind-0 (publicProfileBase) count as referenced', async () => {
    const base = (content: unknown) => ({ eventId: 'f'.repeat(64), createdAt: 1, tags: [], content: typeof content === 'string' ? content : JSON.stringify(content) });
    const rows = [row({
      persona: { publicProfileBase: base({ picture: `${SERVER}/${H1}`, banner: `${SERVER}/${H2}` }) },
      extraPersonas: [{ publicProfileBase: base({ banner: `${SERVER}/${H3}` }) }],
      naturalPerson: { publicProfileBase: base('not json') },
    }), { id: 'dependant:x', persona: { publicProfileBase: base({ picture: `${SERVER}/${H4}?x=1`, banner: 'https://example.com/b.jpg' }) } }];
    const hashes = collectReferencedHashes(rows);
    expect([...hashes].sort()).toEqual([H1, H2, H3].sort());
    const { sent, fetchImpl } = stubDelete(200);
    const outcome = await deleteOwnedBlob({ hash: H2, server: SERVER, domain: PUBLIC_PICTURE_UPLOADER_DOMAIN, encryptionKey: KEY, loadRows: async () => rows, fetchImpl });
    expect(outcome).toBe('kept');
    expect(sent).toHaveLength(0);
  });

  it('is case-insensitive and tolerates marker rows and junk', () => {
    expect(isBlobReferenced(H1.toUpperCase(), [row({ photoHash: H1 })])).toBe(true);
    expect(isBlobReferenced(H1, [null, 'x', 7, { id: 'bunkerSecret', value: 'c' }, row({ extraPersonas: 'nope', naturalPerson: 3 })])).toBe(false);
  });

  it('a hash shared between two slots is not deleted while either still has it', async () => {
    const { sent, fetchImpl } = stubDelete(200);
    const rows = [row({ persona: { pictureBlossomHash: H1 }, extraPersonas: [{ bannerBlossomHash: H1 }] })];
    const outcome = await deleteOwnedBlob({ hash: H1, server: SERVER, domain: PUBLIC_PICTURE_UPLOADER_DOMAIN, encryptionKey: KEY, loadRows: async () => rows, fetchImpl });
    expect(outcome).toBe('kept');
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['identity venue photo', row({ photoHash: H1 })],
    ['dependant venue photo', { id: 'dependant:d', photoHash: H1 }],
    ['an avatar', row({ persona: { avatarHash: H1 } })],
    ['a #242 share copy', row({ naturalPerson: { contactAvatarHash: H1 } })],
    ['a banner on an extra persona', row({ extraPersonas: [{ bannerBlossomHash: H1 }] })],
  ])('is not deleted while %s still references it', async (_name, stored) => {
    const { sent, fetchImpl } = stubDelete(200);
    const outcome = await deleteOwnedBlob({ hash: H1, server: SERVER, domain: VENUE_PHOTO_UPLOADER_DOMAIN, encryptionKey: KEY, loadRows: async () => [stored], fetchImpl });
    expect(outcome).toBe('kept');
    expect(sent).toHaveLength(0);
  });

  it('M1: with no unlock key nothing is sent and the answer is kept, so no "Couldn\'t delete" line', async () => {
    const { sent, fetchImpl } = stubDelete(200);
    const outcome = await deleteOwnedBlob({ hash: H1, server: SERVER, domain: AVATAR_UPLOADER_DOMAIN, encryptionKey: null, loadRows: noRows, fetchImpl });
    expect(outcome).toBe('kept');
    expect(sent).toHaveLength(0);
    expect(blobDeletionNote('picture', outcome, SERVER)).toBeUndefined();
  });

  it('is deleted once nothing references it', async () => {
    const { sent, fetchImpl } = stubDelete(200);
    const outcome = await deleteOwnedBlob({ hash: H1, server: SERVER, domain: AVATAR_UPLOADER_DOMAIN, encryptionKey: KEY, loadRows: async () => [row({ persona: { avatarHash: H2 } })], fetchImpl });
    expect(outcome).toBe('deleted');
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('DELETE');
    expect(sent[0].url).toBe(`${SERVER}/${H1}`);
  }, 20_000);

  it('leaves the blob alone when the stored rows cannot be read', async () => {
    const { sent, fetchImpl } = stubDelete(200);
    const outcome = await deleteOwnedBlob({
      hash: H1, server: SERVER, domain: AVATAR_UPLOADER_DOMAIN, encryptionKey: KEY, fetchImpl,
      loadRows: async () => { throw new Error('idb closed'); },
    });
    expect(outcome).toBe('kept');
    expect(sent).toHaveLength(0);
  });
});

describe('R6: signing and status handling', () => {
  it.each([
    ['public picture/banner', PUBLIC_PICTURE_UPLOADER_DOMAIN],
    ['in-app avatar', AVATAR_UPLOADER_DOMAIN],
    ['share copy', CONTACT_AVATAR_UPLOADER_DOMAIN],
    ['venue photo', VENUE_PHOTO_UPLOADER_DOMAIN],
  ])('%s: the DELETE is signed by the uploader rebuilt for that domain and hash', async (_name, domain) => {
    const { sent, fetchImpl } = stubDelete(200);
    await deleteOwnedBlob({ hash: H2, server: SERVER, domain, encryptionKey: KEY, loadRows: noRows, fetchImpl });
    const rebuilt = await hmacUploaderBackend(domain, H2, KEY);
    expect(sent[0].event.pubkey).toBe(rebuilt.activePublicKeyHex);
    expect(sent[0].event.kind).toBe(24242);
    expect(sent[0].event.tags).toContainEqual(['t', 'delete']);
    expect(sent[0].event.tags).toContainEqual(['x', H2]);
    // A different domain would not be the same signer.
    const other = await hmacUploaderBackend(domain === AVATAR_UPLOADER_DOMAIN ? VENUE_PHOTO_UPLOADER_DOMAIN : AVATAR_UPLOADER_DOMAIN, H2, KEY);
    expect(other.activePublicKeyHex).not.toBe(sent[0].event.pubkey);
    rebuilt.destroy();
    other.destroy();
  }, 30_000);

  it('the signer is the uploader of the original upload (same install secret, same hash)', async () => {
    // Upload a share copy, then delete it by hash: the DELETE signer must be the upload signer.
    const uploads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      uploads.push(JSON.parse(atob((init.headers as Record<string, string>).Authorization.replace(/^Nostr /, ''))).pubkey);
      const body = new Uint8Array(await (init.body as Blob).arrayBuffer());
      return new Response(JSON.stringify({ sha256: bytesToHex(sha256(body)) }), { status: 200 });
    }));
    const meta = await uploadContactAvatar(new Uint8Array([1, 2, 3]), '7'.repeat(64), SERVER, true, KEY);
    vi.unstubAllGlobals();
    const { sent, fetchImpl } = stubDelete(200);
    await deleteOwnedBlob({ hash: meta.hash, server: SERVER, domain: CONTACT_AVATAR_UPLOADER_DOMAIN, encryptionKey: KEY, loadRows: noRows, fetchImpl });
    expect(sent[0].event.pubkey).toBe(uploads[0]);
  }, 30_000);

  it.each([[200], [204], [404]])('a %i answer counts as deleted', async (status) => {
    const { fetchImpl } = stubDelete(status);
    expect(await deleteOwnedBlob({ hash: H3, server: SERVER, domain: AVATAR_UPLOADER_DOMAIN, encryptionKey: KEY, loadRows: noRows, fetchImpl })).toBe('deleted');
  }, 20_000);

  it.each([[401], [403], [500]])('a %i answer is a failure', async (status) => {
    const { fetchImpl } = stubDelete(status);
    expect(await deleteOwnedBlob({ hash: H3, server: SERVER, domain: AVATAR_UPLOADER_DOMAIN, encryptionKey: KEY, loadRows: noRows, fetchImpl })).toBe('failed');
  }, 20_000);

  it('a network error is a failure, never a throw', async () => {
    const fetchImpl = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    expect(await deleteOwnedBlob({ hash: H3, server: SERVER, domain: AVATAR_UPLOADER_DOMAIN, encryptionKey: KEY, loadRows: noRows, fetchImpl })).toBe('failed');
  }, 20_000);

  it('a malformed hash or server is a failure without any request', async () => {
    const { sent, fetchImpl } = stubDelete(200);
    expect(await deleteOwnedBlob({ hash: 'nope', server: SERVER, domain: AVATAR_UPLOADER_DOMAIN, encryptionKey: KEY, loadRows: noRows, fetchImpl })).toBe('failed');
    expect(await deleteOwnedBlob({ hash: H3, server: '', domain: AVATAR_UPLOADER_DOMAIN, encryptionKey: KEY, loadRows: noRows, fetchImpl })).toBe('failed');
    expect(sent).toHaveLength(0);
  });
});

describe('the one-line results', () => {
  it('uses the exact copy and the server hostname', () => {
    expect(blobDeletionNote('photo', 'deleted', 'https://nostr.download/')).toBe('Old photo deleted from nostr.download.');
    expect(blobDeletionNote('photo', 'failed', SERVER)).toBe("Couldn't delete the old photo from nostr.download.");
    expect(blobDeletionNote('picture', 'deleted', SERVER)).toBe('Old picture deleted from nostr.download.');
    expect(blobDeletionNote('picture', 'failed', SERVER)).toBe("Couldn't delete the old picture from nostr.download.");
    expect(blobDeletionNote('photo', 'kept', SERVER)).toBeUndefined();
    expect(OLD_PHOTO_DELETED_COPY).toBe('Old photo deleted from {host}.');
    expect(OLD_PHOTO_NOT_DELETED_COPY).toBe("Couldn't delete the old photo from {host}.");
    expect(OLD_PICTURE_DELETED_COPY).toBe('Old picture deleted from {host}.');
    expect(OLD_PICTURE_NOT_DELETED_COPY).toBe("Couldn't delete the old picture from {host}.");
    expect(OLD_PICTURE_STAYS_COPY).toBe('The old picture stays on {host} because your published profile still shows it.');
  });
});

describe('serverFromBlobUrl and findSlotBlobs', () => {
  it('takes the server from {server}/{hash} only', () => {
    expect(serverFromBlobUrl(`${SERVER}/${H1}`, H1)).toBe(SERVER);
    expect(serverFromBlobUrl(`https://blossom.example/sub/${H1}`, H1)).toBe('https://blossom.example/sub');
    expect(serverFromBlobUrl('https://example.com/me.jpg', H1)).toBeNull();
    expect(serverFromBlobUrl(undefined, H1)).toBeNull();
    expect(serverFromBlobUrl(`${SERVER}/${H1}`, 'nope')).toBeNull();
  });

  it('reads the avatar and share copy of the targeted slot', () => {
    const holder = {
      naturalPerson: { avatarHash: H1, avatarBlossomUrl: 'https://a.example', contactAvatarHash: H2, contactAvatarBlossomUrl: 'https://b.example' },
      persona: { avatarHash: H3, avatarBlossomUrl: 'https://c.example' },
      extraPersonas: [{ publicKey: 'x'.repeat(64), avatarHash: H4, avatarBlossomUrl: 'https://d.example' }],
    };
    expect(findSlotBlobs(holder, 'natural-person')).toEqual({ avatar: { hash: H1, server: 'https://a.example' }, share: { hash: H2, server: 'https://b.example' } });
    expect(findSlotBlobs(holder, 'persona')).toEqual({ avatar: { hash: H3, server: 'https://c.example' }, share: undefined });
    expect(findSlotBlobs(holder, 'x'.repeat(64)).avatar).toEqual({ hash: H4, server: 'https://d.example' });
    expect(findSlotBlobs(holder, 'missing')).toEqual({});
    expect(findSlotBlobs(null, 'persona')).toEqual({});
  });
});

describe('R3: replacing or removing the private avatar', () => {
  const recorder = (outcome: DeleteOutcome = 'deleted') => {
    const calls: Array<[string, string, string]> = [];
    const del: BlobDeleter = async (domain, hash, server) => { calls.push([domain, hash, server]); return outcome; };
    return { calls, del };
  };

  it('deletes the old avatar under the avatar domain and reports it', async () => {
    const { calls, del } = recorder();
    const note = await deleteReplacedAvatar({ hash: H1, server: SERVER }, H2, del);
    expect(calls).toEqual([[AVATAR_UPLOADER_DOMAIN, H1, SERVER]]);
    expect(note).toBe('Old photo deleted from nostr.download.');
  });

  it('on Remove (no new avatar) deletes the old one', async () => {
    const { calls, del } = recorder();
    await deleteReplacedAvatar({ hash: H1, server: SERVER }, undefined, del);
    expect(calls).toHaveLength(1);
  });

  it('reports a failure with the "Couldn\'t" line', async () => {
    const { del } = recorder('failed');
    expect(await deleteReplacedAvatar({ hash: H1, server: SERVER }, H2, del)).toBe("Couldn't delete the old photo from nostr.download.");
  });

  it('does nothing when there was no avatar, or the same bytes were picked again', async () => {
    const { calls, del } = recorder();
    expect(await deleteReplacedAvatar(undefined, H2, del)).toBeUndefined();
    expect(await deleteReplacedAvatar({ hash: H1, server: SERVER }, H1, del)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe('R5: the #242 share copy', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Stop sharing deletes the share blob under the contact-avatar domain', async () => {
    const calls: Array<[string, string, string]> = [];
    const del: BlobDeleter = async (domain, hash, server) => { calls.push([domain, hash, server]); return 'deleted'; };
    const note = await deleteStoppedShareCopy({ hash: H1, server: SERVER }, del);
    expect(calls).toEqual([[CONTACT_AVATAR_UPLOADER_DOMAIN, H1, SERVER]]);
    expect(note).toBe('Old photo deleted from nostr.download.');
    expect(await deleteStoppedShareCopy(undefined, del)).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('a new share copy (re-upload after a picture change) sends only PUTs and never deletes the previous one', async () => {
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      methods.push(init.method ?? 'GET');
      const body = new Uint8Array(await (init.body as Blob).arrayBuffer());
      return new Response(JSON.stringify({ sha256: bytesToHex(sha256(body)) }), { status: 200 });
    }));
    const key = '7'.repeat(64);
    const first = await uploadContactAvatar(new Uint8Array([1, 2, 3]), key, SERVER, true, KEY);
    const second = await uploadContactAvatar(new Uint8Array([4, 5, 6]), key, SERVER, true, KEY);
    expect(second.hash).not.toBe(first.hash);
    expect(methods).toEqual(['PUT', 'PUT']);
  }, 30_000);
});

describe('R1 against the real stored rows (no test seam)', () => {
  it('reads the venue photo off the stored identity and refuses to delete it', async () => {
    const { saveIdentityEncrypted, purgeAllUserData } = await import('./db');
    await purgeAllUserData();
    const identity = {
      id: 'e'.repeat(64),
      naturalPerson: { publicKey: 'e'.repeat(64), privateKey: '', displayName: '' },
      persona: { publicKey: 'f'.repeat(64), privateKey: '', displayName: 'P', pictureBlossomHash: H2 },
      primaryKeypair: 'persona',
      photoHash: H1,
      blossomUrl: SERVER,
      createdAt: 1,
    } as unknown as Parameters<typeof saveIdentityEncrypted>[0];
    await saveIdentityEncrypted(identity, KEY);
    const { sent, fetchImpl } = stubDelete(200);
    expect(await deleteOwnedBlob({ hash: H1, server: SERVER, domain: VENUE_PHOTO_UPLOADER_DOMAIN, encryptionKey: KEY, fetchImpl })).toBe('kept');
    expect(await deleteOwnedBlob({ hash: H2, server: SERVER, domain: PUBLIC_PICTURE_UPLOADER_DOMAIN, encryptionKey: KEY, fetchImpl })).toBe('kept');
    expect(sent).toHaveLength(0);
    // Something the identity does not name is deletable.
    expect(await deleteOwnedBlob({ hash: H3, server: SERVER, domain: VENUE_PHOTO_UPLOADER_DOMAIN, encryptionKey: KEY, fetchImpl })).toBe('deleted');
    await purgeAllUserData();
  }, 30_000);
});
