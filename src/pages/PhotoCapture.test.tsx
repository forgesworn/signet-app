// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { PhotoCapture, PHOTO_SERVER_REFUSED_COPY } from './PhotoCapture';
import { deriveUploaderKey, hmacUploaderBackend, VENUE_PHOTO_UPLOADER_DOMAIN } from '../lib/blossom-uploader';
import type { SignetIdentity } from '../types';

const NP_PUBKEY = 'a'.repeat(64);
const UNLOCK_KEY = 'correct-horse-battery-staple';

/** Mount the page with a camera that "captures" a 3 byte JPEG, then walk to the upload button. */
async function captureAndUpload(
  onUpdatePhoto: () => Promise<void>,
  extra: { identity?: Record<string, unknown>; onDeleteOldPhoto?: (hash: string, server: string) => Promise<'deleted' | 'failed' | 'kept'> } = {},
) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })));
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  render(
    <PhotoCapture
      identity={{ blossomUrl: 'https://nostr.download', ...extra.identity } as unknown as SignetIdentity}
      encryptionKey={UNLOCK_KEY}
      blossomConsent
      onSetBlossomConsent={vi.fn(async () => {})}
      onUpdatePhoto={onUpdatePhoto}
      onDeleteOldPhoto={extra.onDeleteOldPhoto}
      onBack={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: /^capture$/i }));
  fireEvent.click(await screen.findByRole('button', { name: /upload to blossom/i }));
}

describe('PhotoCapture upload auth', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('signs the Blossom upload with the install-secret HMAC key for the uploaded blob, never the identity key or a key from the photo key', async () => {
    const auths: Array<{ pubkey: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      auths.push(JSON.parse(atob((init.headers as Record<string, string>).Authorization.replace(/^Nostr /, ''))));
      const body = new Uint8Array(await (init.body as Blob).arrayBuffer());
      return new Response(JSON.stringify({ sha256: bytesToHex(sha256(body)) }), { status: 200 });
    }));
    const onUpdatePhoto = vi.fn(async () => {});
    await captureAndUpload(onUpdatePhoto);

    await waitFor(() => expect(onUpdatePhoto).toHaveBeenCalled());
    const [hash, , keyHex] = onUpdatePhoto.mock.calls[0] as unknown as [string, string, string];
    expect(auths).toHaveLength(1);
    expect(auths[0].pubkey).not.toBe(NP_PUBKEY);
    // The venue QR carries the photo key; it must not let a steward derive the uploader.
    expect(auths[0].pubkey).not.toBe(bytesToHex(schnorr.getPublicKey(deriveUploaderKey(keyHex, VENUE_PHOTO_UPLOADER_DOMAIN))));
    const rebuilt = await hmacUploaderBackend(VENUE_PHOTO_UPLOADER_DOMAIN, hash, UNLOCK_KEY);
    expect(auths[0].pubkey).toBe(rebuilt.activePublicKeyHex);
    rebuilt.destroy();
  }, 30_000);

  it.each([415, 401, 403])('a %i tells the user to change the server field on this page, not Advanced settings', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status })));
    await captureAndUpload(vi.fn(async () => {}));
    const msg = await screen.findByText(PHOTO_SERVER_REFUSED_COPY);
    expect(msg).toBeTruthy();
    expect(PHOTO_SERVER_REFUSED_COPY).not.toMatch(/Advanced settings/i);
  }, 30_000);
});

describe('PhotoCapture: the replaced venue photo is deleted (R3)', () => {
  const OLD_HASH = '9'.repeat(64);
  const stubUpload = () => vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = new Uint8Array(await (init.body as Blob).arrayBuffer());
    return new Response(JSON.stringify({ sha256: bytesToHex(sha256(body)) }), { status: 200 });
  }));
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('after the new photo is saved, deletes the old one from its server and says so', async () => {
    stubUpload();
    const order: string[] = [];
    const onUpdatePhoto = vi.fn(async () => { order.push('save'); });
    const onDeleteOldPhoto = vi.fn(async () => { order.push('delete'); return 'deleted' as const; });
    await captureAndUpload(onUpdatePhoto, { identity: { photoHash: OLD_HASH, blossomUrl: 'https://old.example' }, onDeleteOldPhoto });
    expect(await screen.findByText('Old photo deleted from old.example.')).toBeTruthy();
    expect(onDeleteOldPhoto).toHaveBeenCalledWith(OLD_HASH, 'https://old.example');
    expect(order).toEqual(['save', 'delete']);
  }, 30_000);

  it('a refused delete shows the "Couldn\'t delete" line and the new photo still stands', async () => {
    stubUpload();
    const onUpdatePhoto = vi.fn(async () => {});
    await captureAndUpload(onUpdatePhoto, { identity: { photoHash: OLD_HASH }, onDeleteOldPhoto: vi.fn(async () => 'failed' as const) });
    expect(await screen.findByText("Couldn't delete the old photo from nostr.download.")).toBeTruthy();
    expect(onUpdatePhoto).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Photo uploaded')).toBeTruthy();
  }, 30_000);

  it('a delete that throws never blocks the change', async () => {
    stubUpload();
    await captureAndUpload(vi.fn(async () => {}), { identity: { photoHash: OLD_HASH }, onDeleteOldPhoto: vi.fn(async () => { throw new Error('boom'); }) });
    expect(await screen.findByText("Couldn't delete the old photo from nostr.download.")).toBeTruthy();
    expect(screen.getByText('Photo uploaded')).toBeTruthy();
  }, 30_000);

  it('a first photo has nothing to delete, and a failed save deletes nothing', async () => {
    stubUpload();
    const onDeleteOldPhoto = vi.fn(async () => 'deleted' as const);
    await captureAndUpload(vi.fn(async () => {}), { onDeleteOldPhoto });
    await screen.findByText('Photo uploaded');
    expect(onDeleteOldPhoto).not.toHaveBeenCalled();
  }, 30_000);

  it('does not delete when saving the new photo failed', async () => {
    stubUpload();
    const onDeleteOldPhoto = vi.fn(async () => 'deleted' as const);
    await captureAndUpload(vi.fn(async () => { throw new Error('save failed'); }), { identity: { photoHash: OLD_HASH }, onDeleteOldPhoto });
    await screen.findByText(/save failed/);
    expect(onDeleteOldPhoto).not.toHaveBeenCalled();
  }, 30_000);
});
