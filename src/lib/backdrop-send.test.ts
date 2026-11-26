import { describe, it, expect, vi } from 'vitest';
import { sendBackdropToChild, removeBackdropFromChild, type BackdropSendDeps } from './backdrop-send';
import { BACKDROP_UPLOADER_DOMAIN } from './blossom-uploader';
import { BACKDROP_COPY } from './child-device-copy';
import { BlossomUploadError, BLOSSOM_REFUSED_COPY } from './blossom';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const SERVER = 'https://nostr.download';
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const META = { hash: H2, blossomUrl: SERVER, keyHex: '3'.repeat(64), updatedAt: 5 };
const blob = new Blob(['jpeg'], { type: 'image/jpeg' });
// sha256('jpeg'): what the slot records as "the picture that was sent".
const DIGEST = '41e5787e9f28562d07b891b1816b492309d646c0f2829743fa4963a9f9cc1d61';

let slotCounter = 0;
function deps(over: Partial<BackdropSendDeps> = {}) {
  const order: string[] = [];
  const d: BackdropSendDeps = {
    slotKey: `slot-${++slotCounter}`,
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
    expect(d.saveSlot).toHaveBeenCalledWith(META, DIGEST);
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

  it('records the uploaded blob as an orphan for the next unlock (deleting needs the key), and sends no delete', async () => {
    let key: string | null = 'unlock-key';
    const recordOrphan = vi.fn(async () => undefined);
    const { d } = deps({ getKey: () => key, recordOrphan, upload: vi.fn(async () => { key = null; return META; }) });
    await sendBackdropToChild(blob, d);
    await vi.waitFor(() => expect(recordOrphan).toHaveBeenCalledWith({ domain: BACKDROP_UPLOADER_DOMAIN, hash: H2, url: SERVER }));
    expect(d.deleteBlob).not.toHaveBeenCalled();
  });

  it('a lock during the save itself (the save refuses) is a lock too: orphan recorded, nothing deleted', async () => {
    let key: string | null = 'unlock-key';
    const recordOrphan = vi.fn(async () => undefined);
    const { d } = deps({ getKey: () => key, recordOrphan, saveSlot: vi.fn(async () => { key = null; throw new Error('Encryption key required'); }) });
    expect(await sendBackdropToChild(blob, d)).toEqual({ ok: false, reason: BACKDROP_COPY.reasons.locked });
    await vi.waitFor(() => expect(recordOrphan).toHaveBeenCalledTimes(1));
    expect(d.deleteBlob).not.toHaveBeenCalled();
  });

  it('an orphan whose delete fails while unlocked is recorded for a retry', async () => {
    const recordOrphan = vi.fn(async () => undefined);
    const { d } = deps({ recordOrphan, deleteBlob: vi.fn(async () => 'failed' as const), saveSlot: vi.fn(async () => { throw new Error('idb'); }) });
    await sendBackdropToChild(blob, d);
    await vi.waitFor(() => expect(recordOrphan).toHaveBeenCalledWith({ domain: BACKDROP_UPLOADER_DOMAIN, hash: H2, url: SERVER }));
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
    expect(d.saveSlot).toHaveBeenCalledWith(META, DIGEST);
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const metaN = (n: string) => ({ hash: n.repeat(64), blossomUrl: SERVER, keyHex: '3'.repeat(64), updatedAt: 5 });

describe('overlapping sends and removes on one slot', () => {
  it('a newer pick wins even when the older upload finishes last; the older blob is deleted, never saved', async () => {
    const first = deferred<ReturnType<typeof metaN>>();
    const second = deferred<ReturnType<typeof metaN>>();
    const { d } = deps();
    const a = sendBackdropToChild(blob, { ...d, upload: vi.fn(() => first.promise) });
    const b = sendBackdropToChild(blob, { ...d, upload: vi.fn(() => second.promise) });
    second.resolve(metaN('b'));
    expect((await b).ok).toBe(true);
    first.resolve(metaN('a'));
    const lost = await a;
    expect(lost.ok).toBe(false);
    expect(d.saveSlot).toHaveBeenCalledTimes(1);
    expect(d.saveSlot).toHaveBeenCalledWith(metaN('b'), DIGEST);
    expect(d.deleteBlob).toHaveBeenCalledWith(BACKDROP_UPLOADER_DOMAIN, 'a'.repeat(64), SERVER);
  });

  it('a newer pick wins when the older upload finishes first too', async () => {
    const first = deferred<ReturnType<typeof metaN>>();
    const second = deferred<ReturnType<typeof metaN>>();
    const { d } = deps();
    const a = sendBackdropToChild(blob, { ...d, upload: vi.fn(() => first.promise) });
    const b = sendBackdropToChild(blob, { ...d, upload: vi.fn(() => second.promise) });
    first.resolve(metaN('a'));
    expect((await a).ok).toBe(false);
    second.resolve(metaN('b'));
    expect((await b).ok).toBe(true);
    expect(d.saveSlot).toHaveBeenCalledTimes(1);
    expect(d.saveSlot).toHaveBeenCalledWith(metaN('b'), DIGEST);
  });

  it('a remove during an upload wins: the pointer is cleared and the upload is discarded', async () => {
    const up = deferred<ReturnType<typeof metaN>>();
    const { d } = deps();
    const send = sendBackdropToChild(blob, { ...d, upload: vi.fn(() => up.promise) });
    const removal = removeBackdropFromChild(d);
    up.resolve(metaN('a'));
    expect((await send).ok).toBe(false);
    await removal;
    expect(d.saveSlot).toHaveBeenCalledTimes(1);
    expect(d.saveSlot).toHaveBeenCalledWith(null);
    expect(d.deleteBlob).toHaveBeenCalledWith(BACKDROP_UPLOADER_DOMAIN, 'a'.repeat(64), SERVER);
  });

  it('a remove that arrives while the send is saving runs after it, so the slot ends empty', async () => {
    const saving = deferred<{ previous?: { hash: string; server: string } }>();
    const calls: Array<string | null> = [];
    const { d } = deps({
      saveSlot: vi.fn(async (m: { hash: string } | null) => {
        calls.push(m ? m.hash : null);
        return m ? saving.promise : { previous: { hash: H2, server: SERVER } };
      }),
    });
    const send = sendBackdropToChild(blob, d);
    await vi.waitFor(() => expect(calls).toEqual([H2]));
    const removal = removeBackdropFromChild(d);
    await Promise.resolve();
    expect(calls).toEqual([H2]);
    saving.resolve({});
    await send;
    await removal;
    expect(calls).toEqual([H2, null]);
  });

  it('slots do not block each other', async () => {
    const up = deferred<ReturnType<typeof metaN>>();
    const a = deps();
    const b = deps();
    const slow = sendBackdropToChild(blob, { ...a.d, upload: vi.fn(() => up.promise) });
    expect((await sendBackdropToChild(blob, b.d)).ok).toBe(true);
    up.resolve(metaN('a'));
    expect((await slow).ok).toBe(true);
  });
});

describe('the digest of what was sent', () => {
  it('is the sha256 of the local picture and is saved with the pointer', async () => {
    const { d } = deps();
    await sendBackdropToChild(blob, d);
    const [, digest] = (d.saveSlot as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(digest).toBe(bytesToHex(sha256(new TextEncoder().encode('jpeg'))));
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
    naturalPersonActive: true, naturalPerson: { publicKey: NP, displayName: 'Lily Smith' }, persona: { publicKey: PERSONA }, extraPersonas: [{ publicKey: EXTRA }], ...over,
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
      expect(setSlot).toHaveBeenLastCalledWith(PERSONA, target, META, DIGEST);
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

  it('carries the slot\'s recorded digest, so the card can tell whether the current picture was sent', () => {
    const sentSlot = { publicKey: PERSONA, backdropHash: H1, backdropKey: 'k'.repeat(64), backdropBlossomUrl: SERVER, backdropSentDigest: 'd'.repeat(64) };
    expect(buildDependantBackdropLookup(env({ dependants: [dep({ persona: sentSlot })] }).e)(PERSONA)!.sentDigest).toBe('d'.repeat(64));
    expect(buildDependantBackdropLookup(env().e)(PERSONA)!.sentDigest).toBeUndefined();
  });

  it('a dependant with no phone paired still has a link, but it cannot send: nothing is uploaded and the pointer can still be cleared', async () => {
    const { e, upload, setSlot } = env({ dependants: [dep({ bunkerEndpoint: undefined }), dep({ id: 'x', persona: { publicKey: 'e'.repeat(64) }, bunkerEndpoint: {} })] });
    const lookup = buildDependantBackdropLookup(e);
    for (const pk of [PERSONA, 'e'.repeat(64)]) {
      const link = lookup(pk)!;
      expect(link.canSend).toBe(false);
      expect((await link.send(blob)).ok).toBe(false);
    }
    expect(upload).not.toHaveBeenCalled();
    await lookup(PERSONA)!.remove();
    expect(setSlot).toHaveBeenCalledWith(PERSONA, 'persona', null, undefined);
  });

  it('can send exactly where the publisher sends: a paired phone and a visible slot', () => {
    const lookup = (over: Record<string, unknown>) => buildDependantBackdropLookup(env({ dependants: [dep(over)] }).e);
    expect(lookup({})(PERSONA)!.canSend).toBe(true);
    expect(lookup({})(NP)!.canSend).toBe(true);
    expect(lookup({})(EXTRA)!.canSend).toBe(true);
    // real identity dormant
    expect(lookup({ naturalPersonActive: false })(NP)!.canSend).toBe(false);
    // hidden from the paired device, or removed from the phone
    expect(lookup({ hiddenOnPairedDeviceKeys: [PERSONA] })(PERSONA)!.canSend).toBe(false);
    expect(lookup({ childDevice: { removedPersonas: [EXTRA] } })(EXTRA)!.canSend).toBe(false);
    // a soft-deleted extra
    expect(lookup({ extraPersonas: [{ publicKey: EXTRA, hidden: true }] })(EXTRA)!.canSend).toBe(false);
    // other slots are unaffected by one slot's rule
    expect(lookup({ hiddenOnPairedDeviceKeys: [PERSONA] })(EXTRA)!.canSend).toBe(true);
  });

  it('a dependant that does not match is never inspected (a keyless or odd record cannot throw)', () => {
    const odd = { id: 'z', displayName: 'Odd', persona: { publicKey: 'e'.repeat(64) }, naturalPerson: { publicKey: 'f'.repeat(64) }, hiddenOnPairedDeviceKeys: 'sealed' } as never;
    expect(() => buildDependantBackdropLookup(env({ dependants: [odd, dep()] }).e)(PERSONA)).not.toThrow();
    expect(buildDependantBackdropLookup(env({ dependants: [odd, dep()] }).e)(PERSONA)!.canSend).toBe(true);
  });

  it('reports whether the key is available, so a locked remove can be refused', () => {
    let key: string | null = null;
    const lookup = buildDependantBackdropLookup(env({ getKey: () => key }).e);
    expect(lookup(PERSONA)!.unlocked).toBe(false);
    key = 'k';
    expect(lookup(PERSONA)!.unlocked).toBe(true);
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
    expect(setSlot).toHaveBeenCalledWith(PERSONA, EXTRA, null, undefined);
  });
});
