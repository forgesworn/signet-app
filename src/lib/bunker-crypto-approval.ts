/**
 * Owner-route NIP-04 / NIP-44 requests from a client the owner has not
 * marked "Allow always" are queued for a decision instead of refused
 * (signet-app-internal#189). These helpers are the parts of that path that
 * need no React: the one-line description the prompt shows, and the call
 * into the signing backend.
 */
import type { DecryptingSigningBackend } from './signing-backend';
import { shortNpub } from './signet';

export type BunkerCryptoMethod = 'nip04_encrypt' | 'nip04_decrypt' | 'nip44_encrypt' | 'nip44_decrypt';

export function isBunkerCryptoMethod(method: string): method is BunkerCryptoMethod {
  return method === 'nip04_encrypt' || method === 'nip04_decrypt'
    || method === 'nip44_encrypt' || method === 'nip44_decrypt';
}

export function isDecryptMethod(method: BunkerCryptoMethod): boolean {
  return method === 'nip04_decrypt' || method === 'nip44_decrypt';
}

/**
 * Plain description of the request, for the approval card and the native
 * notification. `selfPubkey` is the route's own key: a payload encrypted to
 * yourself (a Stash vault key, for instance) reads differently from one
 * shared with someone else.
 */
export function describeCryptoRequest(method: BunkerCryptoMethod, peerPubkey: string, selfPubkey: string): string {
  const self = peerPubkey.toLowerCase() === selfPubkey.toLowerCase();
  const older = method.startsWith('nip04') ? ' (older format)' : '';
  if (isDecryptMethod(method)) {
    return self
      ? `Decrypt data you encrypted to yourself${older}`
      : `Decrypt a message from ${shortNpub(peerPubkey.toLowerCase())}${older}`;
  }
  return self
    ? `Encrypt data to yourself${older}`
    : `Encrypt a message to ${shortNpub(peerPubkey.toLowerCase())}${older}`;
}

export type BunkerCryptoOutcome = { ok: true; result: string } | { ok: false; error: string };

/** Run one NIP-04 / NIP-44 operation. Never throws; errors are wire strings. */
export async function runBunkerCrypto(
  backend: DecryptingSigningBackend,
  method: BunkerCryptoMethod,
  peerPubkey: string,
  payload: string,
): Promise<BunkerCryptoOutcome> {
  if (method === 'nip04_encrypt' && !backend.nip04Encrypt) return { ok: false, error: 'NIP-04 not supported' };
  if (method === 'nip04_decrypt' && !backend.nip04Decrypt) return { ok: false, error: 'NIP-04 not supported' };
  try {
    const result = method === 'nip04_encrypt'
      ? await backend.nip04Encrypt!(peerPubkey, payload)
      : method === 'nip04_decrypt'
        ? await backend.nip04Decrypt!(peerPubkey, payload)
        : method === 'nip44_encrypt'
          ? await backend.nip44Encrypt(peerPubkey, payload)
          : await backend.nip44Decrypt(peerPubkey, payload);
    return { ok: true, result };
  } catch {
    return { ok: false, error: isDecryptMethod(method) ? 'decryption failed' : 'encryption failed' };
  }
}
