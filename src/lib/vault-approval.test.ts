import { describe, it, expect } from 'vitest';
import { isSignerRefusalMessage, isVaultApprovalError, VaultApprovalError } from './vault-approval';

describe('isSignerRefusalMessage', () => {
  it('treats the Heartwood verdict replies as refusals', () => {
    for (const m of ['user denied', 'timeout', 'unauthorised',
      'signer is busy with another approval; retry shortly',
      'this request must be approved at the device; a guardian verdict cannot answer it']) {
      expect(isSignerRefusalMessage(m)).toBe(true);
    }
  });

  it('does not treat operational errors as refusals', () => {
    for (const m of ['decryption failed', 'signing failed', 'encryption failed', 'bad event format',
      'unknown method', 'key derivation failure', 'identity approved; send the request again',
      'approval changed while waiting; send the request again', '', undefined, 42]) {
      expect(isSignerRefusalMessage(m)).toBe(false);
    }
  });
});

describe('isVaultApprovalError', () => {
  it('recognises only VaultApprovalError', () => {
    expect(isVaultApprovalError(new VaultApprovalError('x'))).toBe(true);
    expect(isVaultApprovalError(new Error('user denied'))).toBe(false);
  });
});
