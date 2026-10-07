// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { PhotoCapture } from './PhotoCapture';
import { deriveUploaderKey, VENUE_PHOTO_UPLOADER_DOMAIN } from '../lib/blossom-uploader';
import type { SignetIdentity } from '../types';

const NP_PUBKEY = 'a'.repeat(64);

describe('PhotoCapture upload auth', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('signs the Blossom upload with a key derived from the photo key, never the identity key', async () => {
    const auths: Array<{ pubkey: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      auths.push(JSON.parse(atob((init.headers as Record<string, string>).Authorization.replace(/^Nostr /, ''))));
      const body = new Uint8Array(await (init.body as Blob).arrayBuffer());
      return new Response(JSON.stringify({ sha256: bytesToHex(sha256(body)) }), { status: 200 });
    }));
    // A camera that "captures" a 1 byte JPEG.
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })));
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();

    const onUpdatePhoto = vi.fn(async () => {});
    render(
      <PhotoCapture
        identity={{ blossomUrl: 'https://nostr.download' } as unknown as SignetIdentity}
        blossomConsent
        onSetBlossomConsent={vi.fn(async () => {})}
        onUpdatePhoto={onUpdatePhoto}
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^capture$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /upload to blossom/i }));

    await waitFor(() => expect(onUpdatePhoto).toHaveBeenCalled());
    const keyHex = (onUpdatePhoto.mock.calls[0] as unknown as [string, string, string])[2];
    expect(auths).toHaveLength(1);
    expect(auths[0].pubkey).not.toBe(NP_PUBKEY);
    expect(auths[0].pubkey).toBe(bytesToHex(schnorr.getPublicKey(deriveUploaderKey(keyHex, VENUE_PHOTO_UPLOADER_DOMAIN))));
  });
});
