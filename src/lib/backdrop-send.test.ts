import { describe, it, expect, vi } from 'vitest';
import { sendBackdropToChild, removeBackdropFromChild, type BackdropSendDeps } from './backdrop-send';
import { BACKDROP_UPLOADER_DOMAIN } from './blossom-uploader';
import { BACKDROP_COPY } from './child-device-copy';
import { BlossomUploadError, BLOSSOM_REFUSED_COPY } from './blossom';

const SERVER = 'https://nostr.download';
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const META = { hash: H2, blossomUrl: SERVER, keyHex: '3'.repeat(64), updatedAt: 5 };
const blob = new Blob(['jpeg'], { type: 'image/jpeg' });

function deps(over: Partial<BackdropSendDeps> = {}) {
  const order: string[] = [];
  const d: BackdropSendDeps = {
    encryptionKey: 'unlock-key',
    blossomUrl: SERVER,
    blossomConsent: true,
    upload: vi.fn(async () => { order.push('upload'); return META; }),
    saveSlot: vi.fn(async () => { order.push('save'); return { previous: { hash: H1, server: SERVER } }; }),
    deleteBlob: vi.fn(async () => { order.push('delete'); return 'deleted' as const; }),
    ...over,
  };
  return { d, order };
}

describe('sendBackdropToChild', () => {
  it('uploads, saves the slot, THEN deletes the replaced blob under the backdrop domain', async () => {
    const { d, order } = deps();
    const res = await sendBackdropToChild(blob, d);
    expect(res.ok).toBe(true);
    if (res.ok) await res.deletion;
    expect(order).toEqual(['upload', 'save', 'delete']);
    expect(d.upload).toHaveBeenCalledWith(blob, SERVER, true, 'unlock-key');
    expect(d.saveSlot).toHaveBeenCalledWith(META);
    expect(d.deleteBlob).toHaveBeenCalledWith(BACKDROP_UPLOADER_DOMAIN, H1, SERVER);
  });

  it('a first send has nothing to delete', async () => {
    const { d } = deps({ saveSlot: vi.fn(async () => ({})) });
    const res = await sendBackdropToChild(blob, d);
    expect(res.ok).toBe(true);
    if (res.ok) await res.deletion;
    expect(d.deleteBlob).not.toHaveBeenCalled();
  });

  it('re-sending identical bytes (same hash) deletes nothing', async () => {
    const { d } = deps({ saveSlot: vi.fn(async () => ({ previous: { hash: H2, server: SERVER } })) });
    const res = await sendBackdropToChild(blob, d);
    if (res.ok) await res.deletion;
    expect(d.deleteBlob).not.toHaveBeenCalled();
  });

  it('locked: nothing is uploaded or saved, and the reason says to unlock', async () => {
    const { d } = deps({ encryptionKey: null });
    expect(await sendBackdropToChild(blob, d)).toEqual({ ok: false, reason: BACKDROP_COPY.reasons.locked });
    expect(d.upload).not.toHaveBeenCalled();
    expect(d.saveSlot).not.toHaveBeenCalled();
  });

  it('no Blossom server set, or no consent: nothing leaves the phone', async () => {
    const a = deps({ blossomUrl: undefined });
    expect(await sendBackdropToChild(blob, a.d)).toEqual({ ok: false, reason: BACKDROP_COPY.reasons.noServer });
    const b = deps({ blossomConsent: false });
    expect(await sendBackdropToChild(blob, b.d)).toEqual({ ok: false, reason: BACKDROP_COPY.reasons.noConsent });
    expect(a.d.upload).not.toHaveBeenCalled();
    expect(b.d.upload).not.toHaveBeenCalled();
  });

  it('a server refusal (401/403) is reported with the refused-upload copy, and the slot is left as it was', async () => {
    const { d } = deps({ upload: vi.fn(async () => { throw new BlossomUploadError(403, BLOSSOM_REFUSED_COPY); }) });
    expect(await sendBackdropToChild(blob, d)).toEqual({ ok: false, reason: BLOSSOM_REFUSED_COPY });
    expect(d.saveSlot).not.toHaveBeenCalled();
    expect(d.deleteBlob).not.toHaveBeenCalled();
  });

  it('a failed replace keeps the old pointer and never deletes the old blob', async () => {
    const { d } = deps({ upload: vi.fn(async () => { throw new Error('Upload failed — this phone is offline. Connect and try again.'); }) });
    const res = await sendBackdropToChild(blob, d);
    expect(res).toEqual({ ok: false, reason: 'Upload failed — this phone is offline. Connect and try again.' });
    expect(d.saveSlot).not.toHaveBeenCalled();
    expect(d.deleteBlob).not.toHaveBeenCalled();
  });

  it('an over-size picture is refused with its own reason, not the generic one', async () => {
    const { d } = deps({ upload: vi.fn(async () => { throw new Error('That picture is too large to send (2000 KB, the limit is 1536 KB).'); }) });
    expect(await sendBackdropToChild(blob, d)).toEqual({ ok: false, reason: 'That picture is too large to send (2000 KB, the limit is 1536 KB).' });
  });

  it('an unrecognised failure gets the generic reason, never raw internals', async () => {
    const { d } = deps({ upload: vi.fn(async () => { throw 'boom'; }) });
    expect(await sendBackdropToChild(blob, d)).toEqual({ ok: false, reason: BACKDROP_COPY.reasons.failed });
  });

  it('if saving the slot fails after the upload, the new blob is cleaned up and the old one kept', async () => {
    const { d } = deps({ saveSlot: vi.fn(async () => { throw new Error('idb'); }) });
    expect(await sendBackdropToChild(blob, d)).toEqual({ ok: false, reason: BACKDROP_COPY.reasons.failed });
    expect(d.deleteBlob).toHaveBeenCalledTimes(1);
    expect(d.deleteBlob).toHaveBeenCalledWith(BACKDROP_UPLOADER_DOMAIN, H2, SERVER);
  });
});

describe('an upload that spans a lock', () => {
  it('saves nothing when the app locked while uploading, and does not reload state', async () => {
    let key: string | null = 'unlock-key';
    const { d } = deps({ getKey: () => key, upload: vi.fn(async () => { key = null; return META; }) });
    expect(await sendBackdropToChild(blob, d)).toEqual({ ok: false, reason: BACKDROP_COPY.reasons.locked });
    expect(d.saveSlot).not.toHaveBeenCalled();
  });

  it('tries to delete the uploaded blob (a no-op while locked, since the uploader secret needs the key)', async () => {
    let key: string | null = 'unlock-key';
    const { d } = deps({ getKey: () => key, upload: vi.fn(async () => { key = null; return META; }) });
    await sendBackdropToChild(blob, d);
    expect(d.deleteBlob).toHaveBeenCalledWith(BACKDROP_UPLOADER_DOMAIN, H2, SERVER);
  });

  it('a different key after the upload counts as a lock too', async () => {
    let key: string | null = 'unlock-key';
    const { d } = deps({ getKey: () => key, upload: vi.fn(async () => { key = 'other-key'; return META; }) });
    expect((await sendBackdropToChild(blob, d)).ok).toBe(false);
    expect(d.saveSlot).not.toHaveBeenCalled();
  });

  it('an unchanged key saves as normal', async () => {
    const { d } = deps({ getKey: () => 'unlock-key' });
    expect((await sendBackdropToChild(blob, d)).ok).toBe(true);
    expect(d.saveSlot).toHaveBeenCalledWith(META);
  });
});

describe('removeBackdropFromChild', () => {
  it('clears the slot, then deletes the blob it pointed at', async () => {
    const { d, order } = deps();
    await removeBackdropFromChild(d);
    expect(d.saveSlot).toHaveBeenCalledWith(null);
    expect(order).toEqual(['save', 'delete']);
    expect(d.deleteBlob).toHaveBeenCalledWith(BACKDROP_UPLOADER_DOMAIN, H1, SERVER);
  });

  it('never throws, and never deletes a blob it could not first detach', async () => {
    const { d } = deps({ saveSlot: vi.fn(async () => { throw new Error('locked'); }) });
    await expect(removeBackdropFromChild(d)).resolves.toBeUndefined();
    expect(d.deleteBlob).not.toHaveBeenCalled();
  });

  it('with nothing sent there is nothing to delete', async () => {
    const { d } = deps({ saveSlot: vi.fn(async () => ({})) });
    await removeBackdropFromChild(d);
    expect(d.deleteBlob).not.toHaveBeenCalled();
  });
});

import { buildDependantBackdropLookup, type BackdropLinkEnv } from './backdrop-send';

describe('buildDependantBackdropLookup', () => {
  const NP = 'a'.repeat(64), PERSONA = 'b'.repeat(64), EXTRA = 'c'.repeat(64), OWN = 'd'.repeat(64);
  const dep = (over: Record<string, unknown> = {}) => ({
    id: PERSONA, displayName: 'Lily', bunkerEndpoint: { authorizedClientPubkey: 'f'.repeat(64) },
    naturalPerson: { publicKey: NP }, persona: { publicKey: PERSONA }, extraPersonas: [{ publicKey: EXTRA }], ...over,
  });
  function env(over: Partial<BackdropLinkEnv> = {}) {
    const setSlot = vi.fn(async () => ({}));
    const upload = vi.fn(async () => META);
    const e: BackdropLinkEnv = {
      isPairedChild: false, dependants: [dep()], getKey: () => 'key', blossomUrl: SERVER, blossomConsent: true,
      setSlot, upload, deleteBlob: vi.fn(async () => 'deleted' as const), ...over,
    };
    return { e, setSlot, upload };
  }

  it('links the persona, the real-name slot and an extra, by slot pubkey', async () => {
    const { e, setSlot } = env();
    const lookup = buildDependantBackdropLookup(e);
    for (const [pk, target] of [[PERSONA, 'persona'], [NP, 'natural-person'], [EXTRA, EXTRA]] as const) {
      const link = lookup(pk)!;
      expect(link.name).toBe('Lily');
      await link.send(blob);
      expect(setSlot).toHaveBeenLastCalledWith(PERSONA, target, META);
    }
  });

  it('gives the guardian\'s own personas, an empty key and strangers no link', () => {
    const lookup = buildDependantBackdropLookup(env().e);
    expect(lookup(OWN)).toBeNull();
    expect(lookup('')).toBeNull();
  });

  it('reports sent only when the slot names an encrypted copy', () => {
    const sentSlot = { publicKey: PERSONA, backdropHash: H1, backdropKey: 'k'.repeat(64), backdropBlossomUrl: SERVER };
    expect(buildDependantBackdropLookup(env({ dependants: [dep({ persona: sentSlot })] }).e)(PERSONA)!.sent).toBe(true);
    expect(buildDependantBackdropLookup(env().e)(PERSONA)!.sent).toBe(false);
  });

  it('a dependant with no phone paired has no link: the backdrop stays on this device and nothing is uploaded', async () => {
    const { e, upload } = env({ dependants: [dep({ bunkerEndpoint: undefined }), dep({ id: 'x', persona: { publicKey: 'e'.repeat(64) }, bunkerEndpoint: {} })] });
    const lookup = buildDependantBackdropLookup(e);
    expect(lookup(PERSONA)).toBeNull();
    expect(lookup('e'.repeat(64))).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });

  it('a child-direct dependant is paired too (the pairing writes authorizedClientPubkey)', () => {
    expect(buildDependantBackdropLookup(env({ dependants: [dep()] }).e)(PERSONA)).not.toBeNull();
  });

  it('a paired-child install has no link anywhere, so nothing is ever uploaded', async () => {
    const { e, upload, setSlot } = env({ isPairedChild: true });
    const lookup = buildDependantBackdropLookup(e);
    expect(lookup(PERSONA)).toBeNull();
    expect(lookup(NP)).toBeNull();
    expect(upload).not.toHaveBeenCalled();
    expect(setSlot).not.toHaveBeenCalled();
  });

  it('reads the unlock key and consent when sending, not when the lookup was built', async () => {
    let key: string | null = null;
    const { e, upload } = env({ getKey: () => key });
    const link = buildDependantBackdropLookup(e)(PERSONA)!;
    expect(await link.send(blob)).toEqual({ ok: false, reason: BACKDROP_COPY.reasons.locked });
    key = 'now-unlocked';
    expect((await link.send(blob)).ok).toBe(true);
    expect(upload).toHaveBeenCalledWith(blob, SERVER, true, 'now-unlocked');
  });

  it('remove clears the slot', async () => {
    const { e, setSlot } = env();
    await buildDependantBackdropLookup(e)(EXTRA)!.remove();
    expect(setSlot).toHaveBeenCalledWith(PERSONA, EXTRA, null);
  });
});
