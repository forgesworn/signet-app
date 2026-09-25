import type { DecryptingSigningBackend } from './signing-backend';

/** Cancel a queued legacy write even when its signer was already awaiting approval. */
export function guardedSigningBackend(backend: DecryptingSigningBackend, isCurrent: () => boolean): DecryptingSigningBackend {
  const check = () => { if (!isCurrent()) throw new Error('Backup publication superseded'); };
  return {
    // This wrapper borrows the backend; its owner controls destruction.
    destroy() {},
    type: backend.type,
    activePublicKeyHex: backend.activePublicKeyHex,
    async signEvent(event) {
      check();
      const signed = await backend.signEvent(event);
      check();
      return signed;
    },
    async nip44Encrypt(recipient, plaintext) {
      check();
      const encrypted = await backend.nip44Encrypt(recipient, plaintext);
      check();
      return encrypted;
    },
    nip44Decrypt: (sender, ciphertext) => backend.nip44Decrypt(sender, ciphertext),
  };
}
