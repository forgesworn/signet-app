import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { BunkerSigningBackend, BunkerRequestTimeoutError, SIGNER_REQUEST_TIMEOUT_MS } from './signing-backend';

/** Stand-in for nostr-tools' BunkerSigner: registers its listener synchronously, never replies. */
function silentSigner() {
  let serial = 0;
  const signer = {
    listeners: {} as Record<string, unknown>,
    sendRequest(this: { listeners: Record<string, unknown> }) {
      return new Promise<string>((resolve, reject) => {
        this.listeners[`p-${++serial}`] = { resolve, reject };
      });
    },
  };
  return signer;
}

describe('BunkerSigningBackend.request timeout', () => {
  it('rejects with BunkerRequestTimeoutError and drops only its own orphaned listener', async () => {
    const backend = new BunkerSigningBackend('1'.repeat(64));
    const signer = silentSigner();
    signer.listeners['other'] = {};
    (backend as unknown as { signer: unknown }).signer = signer;
    await expect(backend.request('heartwood_capabilities', [], 10)).rejects.toBeInstanceOf(BunkerRequestTimeoutError);
    expect(Object.keys(signer.listeners)).toEqual(['other']);
  });

  it('resolves normally when the reply arrives in time', async () => {
    const backend = new BunkerSigningBackend('1'.repeat(64));
    (backend as unknown as { signer: unknown }).signer = { sendRequest: async () => 'ok', listeners: {} };
    await expect(backend.request('ping', [], 1000)).resolves.toBe('ok');
  });
});

describe('BunkerSigningBackend signing methods — bounded by SIGNER_REQUEST_TIMEOUT_MS', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('signEvent rejects with BunkerRequestTimeoutError when the signer never replies', async () => {
    const backend = new BunkerSigningBackend('1'.repeat(64));
    const signer = silentSigner();
    (backend as unknown as { signer: unknown }).signer = signer;

    const pending = backend.signEvent({
      pubkey: '',
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'hello',
    });
    const assertion = expect(pending).rejects.toBeInstanceOf(BunkerRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(SIGNER_REQUEST_TIMEOUT_MS);
    await assertion;
    // The orphaned listener registered by sendRequest is dropped on timeout.
    expect(Object.keys(signer.listeners)).toEqual([]);
  });

  it('signEvent returns the verified event on a prompt reply', async () => {
    const backend = new BunkerSigningBackend('1'.repeat(64));
    const remoteSk = generateSecretKey();
    const remotePubkey = getPublicKey(remoteSk);
    // This backend instance represents remotePubkey (as connect/reconnect
    // would have set it) — required for the post-verify pubkey-pin check.
    backend.activePublicKeyHex = remotePubkey;
    const template = {
      pubkey: '',
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [] as string[][],
      content: 'hello',
    };
    const signer = {
      listeners: {} as Record<string, unknown>,
      sendRequest: async (_method: string, params: string[]) => {
        const parsedTemplate = JSON.parse(params[0]);
        const signed = finalizeEvent(parsedTemplate, remoteSk);
        return JSON.stringify(signed);
      },
    };
    (backend as unknown as { signer: unknown }).signer = signer;

    const signed = await backend.signEvent(template);
    expect(signed.pubkey).toBe(remotePubkey);
    expect(signed).toHaveProperty('sig');
    expect(signed).toHaveProperty('id');
  });

  it('signEvent rejects a badly-signed reply', async () => {
    const backend = new BunkerSigningBackend('1'.repeat(64));
    const remoteSk = generateSecretKey();
    backend.activePublicKeyHex = getPublicKey(remoteSk);
    const template = {
      pubkey: '',
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [] as string[][],
      content: 'hello',
    };
    const signer = {
      listeners: {} as Record<string, unknown>,
      sendRequest: async (_method: string, params: string[]) => {
        const parsedTemplate = JSON.parse(params[0]);
        const signed = finalizeEvent(parsedTemplate, remoteSk);
        // Tamper with the content after signing — the signature no longer
        // matches the event id.
        return JSON.stringify({ ...signed, content: 'tampered' });
      },
    };
    (backend as unknown as { signer: unknown }).signer = signer;

    await expect(backend.signEvent(template)).rejects.toThrow(/improperly signed/);
  });

  it('signEvent rejects a validly-signed reply from a different pubkey', async () => {
    const backend = new BunkerSigningBackend('1'.repeat(64));
    const boundSk = generateSecretKey();
    backend.activePublicKeyHex = getPublicKey(boundSk);
    const foreignSk = generateSecretKey();
    const template = {
      pubkey: '',
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [] as string[][],
      content: 'hello',
    };
    const signer = {
      listeners: {} as Record<string, unknown>,
      sendRequest: async (_method: string, params: string[]) => {
        const parsedTemplate = JSON.parse(params[0]);
        // Correctly signed, but by a key other than the one this route is
        // bound to (e.g. a MITM relay or a misbehaving signer).
        const signed = finalizeEvent(parsedTemplate, foreignSk);
        return JSON.stringify(signed);
      },
    };
    (backend as unknown as { signer: unknown }).signer = signer;

    await expect(backend.signEvent(template)).rejects.toThrow(/different pubkey/);
  });

  it('nip44Decrypt times out the same way signEvent does', async () => {
    const backend = new BunkerSigningBackend('1'.repeat(64));
    const signer = silentSigner();
    (backend as unknown as { signer: unknown }).signer = signer;

    const pending = backend.nip44Decrypt('a'.repeat(64), 'ciphertext');
    const assertion = expect(pending).rejects.toBeInstanceOf(BunkerRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(SIGNER_REQUEST_TIMEOUT_MS);
    await assertion;
    expect(Object.keys(signer.listeners)).toEqual([]);
  });

  it('only the timed-out request of two concurrent ones is dropped; the other still resolves', async () => {
    const backend = new BunkerSigningBackend('1'.repeat(64));
    let serial = 0;
    const listeners: Record<string, { resolve: (v: string) => void; reject: (e: unknown) => void }> = {};
    const signer = {
      listeners,
      sendRequest(_method: string, _params: string[]) {
        const id = `p-${++serial}`;
        return new Promise<string>((resolve, reject) => {
          listeners[id] = { resolve, reject };
        });
      },
    };
    (backend as unknown as { signer: unknown }).signer = signer;

    const fastCall = backend.request('ping', [], SIGNER_REQUEST_TIMEOUT_MS);
    const slowCall = backend.request('heartwood_capabilities', [], SIGNER_REQUEST_TIMEOUT_MS);

    // Reply to the first request only — the second is left to time out.
    listeners['p-1'].resolve('pong');

    const fastAssertion = expect(fastCall).resolves.toBe('pong');
    const slowAssertion = expect(slowCall).rejects.toBeInstanceOf(BunkerRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(SIGNER_REQUEST_TIMEOUT_MS);
    await fastAssertion;
    await slowAssertion;
    // Only the timed-out listener (p-2) was dropped; the answered one (p-1)
    // is untouched by the timeout cleanup.
    expect(Object.keys(listeners)).toEqual(['p-1']);
  });
});

describe('BunkerSigningBackend — wire method names and params', () => {
  function capturingSigner() {
    const calls: Array<{ method: string; params: string[] }> = [];
    const signer = {
      listeners: {} as Record<string, unknown>,
      sendRequest: async (method: string, params: string[]) => {
        calls.push({ method, params });
        return 'ok';
      },
    };
    return { signer, calls };
  }

  it('signEvent sends sign_event with the JSON-stringified template (no pubkey)', async () => {
    const backend = new BunkerSigningBackend('1'.repeat(64));
    const sk = generateSecretKey();
    backend.activePublicKeyHex = getPublicKey(sk);
    const { signer, calls } = capturingSigner();
    (backend as unknown as { signer: unknown }).signer = {
      listeners: signer.listeners,
      sendRequest: async (method: string, params: string[]) => {
        calls.push({ method, params });
        const parsedTemplate = JSON.parse(params[0]);
        return JSON.stringify(finalizeEvent(parsedTemplate, sk));
      },
    };
    const template = { pubkey: '', kind: 1, created_at: 1234, tags: [] as string[][], content: 'hi' };
    await backend.signEvent(template);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('sign_event');
    expect(JSON.parse(calls[0].params[0])).toEqual({ kind: 1, created_at: 1234, tags: [], content: 'hi' });
  });

  it('nip44Encrypt sends nip44_encrypt with [recipientPubkey, plaintext]', async () => {
    const backend = new BunkerSigningBackend('1'.repeat(64));
    const { signer, calls } = capturingSigner();
    (backend as unknown as { signer: unknown }).signer = signer;
    await backend.nip44Encrypt('a'.repeat(64), 'plaintext');
    expect(calls).toEqual([{ method: 'nip44_encrypt', params: ['a'.repeat(64), 'plaintext'] }]);
  });

  it('nip44Decrypt sends nip44_decrypt with [senderPubkey, ciphertext]', async () => {
    const backend = new BunkerSigningBackend('1'.repeat(64));
    const { signer, calls } = capturingSigner();
    (backend as unknown as { signer: unknown }).signer = signer;
    await backend.nip44Decrypt('b'.repeat(64), 'ciphertext');
    expect(calls).toEqual([{ method: 'nip44_decrypt', params: ['b'.repeat(64), 'ciphertext'] }]);
  });

  it('nip04Encrypt sends nip04_encrypt with [recipientPubkey, plaintext]', async () => {
    const backend = new BunkerSigningBackend('1'.repeat(64));
    const { signer, calls } = capturingSigner();
    (backend as unknown as { signer: unknown }).signer = signer;
    await backend.nip04Encrypt('c'.repeat(64), 'plaintext');
    expect(calls).toEqual([{ method: 'nip04_encrypt', params: ['c'.repeat(64), 'plaintext'] }]);
  });

  it('nip04Decrypt sends nip04_decrypt with [senderPubkey, ciphertext]', async () => {
    const backend = new BunkerSigningBackend('1'.repeat(64));
    const { signer, calls } = capturingSigner();
    (backend as unknown as { signer: unknown }).signer = signer;
    await backend.nip04Decrypt('d'.repeat(64), 'ciphertext');
    expect(calls).toEqual([{ method: 'nip04_decrypt', params: ['d'.repeat(64), 'ciphertext'] }]);
  });
});
