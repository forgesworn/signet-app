// Tests for blossom.ts
// Covers URL scheme validation, auth event construction, SHA-256 hash
// verification, and all HTTP error paths. The fetch global is mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { SigningBackend } from './signing-backend';
import type { UploaderBackend } from './blossom-uploader';
import type { NostrEvent } from 'signet-protocol';

// ---- helpers -------------------------------------------------------------

const MOCK_PUBKEY = 'a'.repeat(64);
const VALID_URL = 'https://blossom.example.com';

/** Build a minimal signer stub (cast to the branded uploader type). Captures the most recently signed event. */
function makeBackend(overrides?: Partial<SigningBackend>): UploaderBackend & { lastSignedEvent: NostrEvent | null } {
  let lastSignedEvent: NostrEvent | null = null;
  return {
    type: 'local',
    activePublicKeyHex: MOCK_PUBKEY,
    signEvent: vi.fn(async (event) => {
      const signed = { ...event, id: 'b'.repeat(64), sig: 'c'.repeat(128) } as NostrEvent;
      lastSignedEvent = signed;
      return signed;
    }),
    nip44Encrypt: vi.fn(async () => ''),
    destroy: vi.fn(),
    get lastSignedEvent() { return lastSignedEvent; },
    ...overrides,
  } as unknown as UploaderBackend & { lastSignedEvent: NostrEvent | null };
}

/** Build a Blob whose SHA-256 we can predict in tests. */
function makeBlob(content: string): Blob {
  return new Blob([content], { type: 'image/jpeg' });
}

/** Compute SHA-256 of a string using the Web Crypto API (same path as sha256 from @noble/hashes). */
async function sha256hex(content: string): Promise<string> {
  const buf = new TextEncoder().encode(content);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Wrap a JSON body into a successful fetch Response. */
function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Return a failed fetch Response with the given status. */
function errorResponse(status: number): Response {
  return new Response('Server error', { status });
}

// ---- module import -------------------------------------------------------
// Must happen after mocks are registered if mocking were needed; here we let
// @noble/hashes run natively as it is pure crypto.

import { uploadToBlossom, BlossomUploadError, DEFAULT_BLOSSOM_URL } from './blossom';

// -------------------------------------------------------------------------
describe('uploadToBlossom — URL scheme validation', () => {
  it('throws for http:// URL pointing at a remote host', async () => {
    const backend = makeBackend();
    await expect(
      uploadToBlossom(makeBlob('x'), 'http://blossom.example.com', backend, true),
    ).rejects.toThrow('https://');
  });

  it('throws for ftp:// URL', async () => {
    const backend = makeBackend();
    await expect(
      uploadToBlossom(makeBlob('x'), 'ftp://blossom.example.com', backend, true),
    ).rejects.toThrow();
  });

  it('does NOT throw for https:// URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ sha256: await sha256hex('hello') })));
    const backend = makeBackend();
    await expect(
      uploadToBlossom(makeBlob('hello'), VALID_URL, backend, true),
    ).resolves.toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('does NOT throw for http://localhost URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ sha256: await sha256hex('hello') })));
    const backend = makeBackend();
    await expect(
      uploadToBlossom(makeBlob('hello'), 'http://localhost:8080', backend, true),
    ).resolves.toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('does NOT throw for http://127.0.0.1 URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ sha256: await sha256hex('hi') })));
    const backend = makeBackend();
    await expect(
      uploadToBlossom(makeBlob('hi'), 'http://127.0.0.1:8080', backend, true),
    ).resolves.toBeTruthy();
    vi.unstubAllGlobals();
  });
});

// -------------------------------------------------------------------------
describe('uploadToBlossom — auth event construction', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('signs a kind 24242 event', async () => {
    const content = 'auth-test';
    const expectedHash = await sha256hex(content);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ sha256: expectedHash })));

    const backend = makeBackend();
    await uploadToBlossom(makeBlob(content), VALID_URL, backend, true);

    const signed = backend.lastSignedEvent!;
    expect(signed.kind).toBe(24242);
  });

  it('includes upload t-tag', async () => {
    const content = 'auth-test-2';
    const expectedHash = await sha256hex(content);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ sha256: expectedHash })));

    const backend = makeBackend();
    await uploadToBlossom(makeBlob(content), VALID_URL, backend, true);

    expect(backend.lastSignedEvent!.tags).toContainEqual(['t', 'upload']);
  });

  it('includes x-tag with the correct SHA-256 hash', async () => {
    const content = 'predictable-content';
    const expectedHash = await sha256hex(content);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ sha256: expectedHash })));

    const backend = makeBackend();
    await uploadToBlossom(makeBlob(content), VALID_URL, backend, true);

    expect(backend.lastSignedEvent!.tags).toContainEqual(['x', expectedHash]);
  });

  it('sends Authorization header with Nostr prefix', async () => {
    const content = 'auth-header-check';
    const expectedHash = await sha256hex(content);
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ sha256: expectedHash }));
    vi.stubGlobal('fetch', fetchMock);

    const backend = makeBackend();
    await uploadToBlossom(makeBlob(content), VALID_URL, backend, true);

    const [, init] = (fetchMock as Mock).mock.calls[0] as [string, RequestInit];
    const authHeader = (init.headers as Record<string, string>)['Authorization'];
    expect(authHeader).toMatch(/^Nostr /);
  });

  it('uses PUT method', async () => {
    const content = 'method-check';
    const expectedHash = await sha256hex(content);
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ sha256: expectedHash }));
    vi.stubGlobal('fetch', fetchMock);

    const backend = makeBackend();
    await uploadToBlossom(makeBlob(content), VALID_URL, backend, true);

    const [, init] = (fetchMock as Mock).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PUT');
  });

  it('strips trailing slash from base URL before appending /upload', async () => {
    const content = 'trailing-slash';
    const expectedHash = await sha256hex(content);
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ sha256: expectedHash }));
    vi.stubGlobal('fetch', fetchMock);

    const backend = makeBackend();
    await uploadToBlossom(makeBlob(content), 'https://blossom.example.com/', backend, true);

    const [url] = (fetchMock as Mock).mock.calls[0] as [string];
    expect(url).toBe('https://blossom.example.com/upload');
  });
});

// -------------------------------------------------------------------------
describe('uploadToBlossom — HTTP error handling', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('throws when server returns 4xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(400)));
    const backend = makeBackend();
    await expect(uploadToBlossom(makeBlob('x'), VALID_URL, backend, true)).rejects.toThrow('400');
  });

  it('answers 415 for an ENCRYPTED blob with the "ordinary pictures" message, status kept', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(415)));
    const encrypted = new Blob(['x'], { type: 'application/octet-stream' });
    const err = await uploadToBlossom(encrypted, VALID_URL, makeBackend(), true).catch(e => e);
    expect(err).toBeInstanceOf(BlossomUploadError);
    expect(err.status).toBe(415);
    expect(err.message).toBe(
      "That Blossom server only takes ordinary pictures, so it can't store encrypted ones. Choose a different server in Advanced settings.",
    );
  });

  it('answers 415 for a PLAIN picture without blaming encryption (M9)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(415)));
    const err = await uploadToBlossom(makeBlob('x'), VALID_URL, makeBackend(), true).catch(e => e);
    expect(err).toBeInstanceOf(BlossomUploadError);
    expect(err.status).toBe(415);
    expect(err.message).toBe(
      "That Blossom server didn't accept this picture. Choose a different server in Advanced settings.",
    );
    expect(err.message).not.toMatch(/encrypted/);
  });

  it('strips control and bidi characters from a server message and caps it (M6)', async () => {
    const hostile = '\u202Eevil\u0007 text\u200B' + 'y'.repeat(300);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(hostile, { status: 500 })));
    const err = await uploadToBlossom(makeBlob('x'), VALID_URL, makeBackend(), true).catch(e => e);
    expect(err.message).toMatch(/^Blossom upload failed: 500 — evil text/);
    // eslint-disable-next-line no-control-regex
    expect(err.message).not.toMatch(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e]/);
    expect(err.message.length).toBeLessThanOrEqual('Blossom upload failed: 500 — '.length + 100);
  });

  it.each([401, 403])('answers %i with the "approved keys" message, status kept', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(status)));
    const err = await uploadToBlossom(makeBlob('x'), VALID_URL, makeBackend(), true).catch(e => e);
    expect(err).toBeInstanceOf(BlossomUploadError);
    expect(err.status).toBe(status);
    expect(err.message).toBe(
      'That Blossom server refused the upload. It may only accept uploads from approved keys. Choose a different server in Advanced settings.',
    );
  });

  it('throws when server returns 500', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(500)));
    const backend = makeBackend();
    await expect(uploadToBlossom(makeBlob('x'), VALID_URL, backend, true)).rejects.toThrow('500');
  });

  it('throws when response body is not an object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('"just-a-string"', { status: 200 })));
    const backend = makeBackend();
    await expect(uploadToBlossom(makeBlob('x'), VALID_URL, backend, true)).rejects.toThrow('invalid response');
  });

  it('throws when response body is null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null', { status: 200 })));
    const backend = makeBackend();
    await expect(uploadToBlossom(makeBlob('x'), VALID_URL, backend, true)).rejects.toThrow('invalid response');
  });

  it('throws when sha256 field is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ url: 'https://blossom.example.com/file' })));
    const backend = makeBackend();
    await expect(uploadToBlossom(makeBlob('x'), VALID_URL, backend, true)).rejects.toThrow('sha256');
  });

  it('throws when sha256 field is not a string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ sha256: 12345 })));
    const backend = makeBackend();
    await expect(uploadToBlossom(makeBlob('x'), VALID_URL, backend, true)).rejects.toThrow('sha256');
  });
});

// -------------------------------------------------------------------------
describe('uploadToBlossom — SHA-256 hash verification', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('throws when server hash does not match local hash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ sha256: 'f'.repeat(64) })));
    const backend = makeBackend();
    await expect(uploadToBlossom(makeBlob('real-content'), VALID_URL, backend, true)).rejects.toThrow('hash');
  });

  it('accepts server hash in uppercase (case-insensitive comparison)', async () => {
    const content = 'case-insensitive';
    const expectedHash = await sha256hex(content);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ sha256: expectedHash.toUpperCase() })));

    const backend = makeBackend();
    await expect(uploadToBlossom(makeBlob(content), VALID_URL, backend, true)).resolves.toBe(expectedHash);
  });

  it('returns the local SHA-256 hash on success', async () => {
    const content = 'return-value-check';
    const expectedHash = await sha256hex(content);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ sha256: expectedHash })));

    const backend = makeBackend();
    const result = await uploadToBlossom(makeBlob(content), VALID_URL, backend, true);
    expect(result).toBe(expectedHash);
  });
});

describe('DEFAULT_BLOSSOM_URL', () => {
  it('is nostr.download (accepts encrypted blobs; primal answers 415 to non-image bytes)', () => {
    expect(DEFAULT_BLOSSOM_URL).toBe('https://nostr.download');
  });
});

describe('uploadToBlossom — the request never reached a server', () => {
  beforeEach(() => vi.unstubAllGlobals());

  // Device test 2026-10-08: an offline phone (DNS failing) was told the server
  // "rejected the request", which sent the user hunting for another server.
  it('says the phone is offline when the browser knows it is', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    vi.stubGlobal('navigator', { onLine: false });
    await expect(uploadToBlossom(makeBlob('x'), VALID_URL, makeBackend(), true))
      .rejects.toThrow('Upload failed — this phone is offline. Connect and try again.');
  });

  it('names the host and both causes when it cannot tell', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    vi.stubGlobal('navigator', { onLine: true });
    await expect(uploadToBlossom(makeBlob('x'), VALID_URL, makeBackend(), true))
      .rejects.toThrow("Upload failed — couldn't reach blossom.example.com, or it refused the upload. Check your connection, or try a different server.");
  });
});
