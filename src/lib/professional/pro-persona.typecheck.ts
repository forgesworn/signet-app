// Pro-persona type shape canary — delete after Phase 2 is complete.
import type { SignetIdentity, StoredCredential } from '../../types';
import { createLocalBackends } from '../signing-backend';
const _backends = createLocalBackends('test mnemonic');
const _pro: import('../signing-backend').LocalSigningBackend = _backends.professional;
void _pro;

// Must compile without errors once Phase 1 types land.
const _id: SignetIdentity = {} as SignetIdentity;
const _pp: { publicKey: string; privateKey: string; displayName: string } | undefined
  = _id.professionalPersona;
const _sc: StoredCredential = {} as StoredCredential;
const _vs: 'confirmed' | 'pending' | 'expired-pending' = _sc.verifierStatus;
const _pi: number | undefined = _sc.pendingIssuedAt;
const _ca: number | undefined = _sc.confirmationAt;
void _pp; void _vs; void _pi; void _ca;
