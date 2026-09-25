/** Self-entered identity document (pre-verification) */
export interface IdentityDocument {
  /** Unique local ID */
  id: string;
  /** Owner's primary pubkey */
  ownerPubkey: string;
  country: string;
  documentType: string;
  fullName: string;
  dateOfBirth: string;
  nationality?: string;
  documentNumber: string;
  documentExpiry?: string;
  /** Additional country-specific fields */
  additionalFields?: Record<string, string>;
  /** Credential event ID if verified */
  credentialId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Stored credential (after verification) */
export interface StoredCredential {
  /** Credential event ID */
  id: string;
  /** Which document this credential verifies */
  documentId: string;
  /** Which keypair (NP, Persona, or Professional Persona) */
  keypairType: 'natural-person' | 'persona' | 'professional';
  /** The signed Nostr event (Kind 30470) */
  event: string;
  /** Private Merkle leaves */
  merkleLeaves?: Record<string, string>;
  /** Merkle proofs for selective disclosure */
  merkleProofs?: string;
  /** Verifier's pubkey */
  verifierPubkey: string;
  verifiedAt: number;
  /**
   * Whether the verifier's attestation has been confirmed on the relay.
   * 'expired-pending' = pending for >30 days without chain completion.
   * Spec §6.10.3 and IQ redesign spec (Credential States table).
   */
  verifierStatus: 'confirmed' | 'pending' | 'expired-pending';
  /**
   * Unix seconds — when a self-cert credential was issued (stamped in the
   * signed event tag 'pending-issued-at'). Used to compute lapse. Absent on
   * normal (non-self-cert) credentials.
   */
  pendingIssuedAt?: number;
  /**
   * Unix seconds — when verifierStatus transitioned to 'confirmed'. Local
   * IndexedDB metadata, not part of the signed event. Absent until confirmed.
   */
  confirmationAt?: number;
  /** Unix seconds — absent means never expires. Set by issuers that want time-limited credentials. */
  expiresAt?: number;
  /** Unix seconds — absent means not revoked. Populated when the user initiates a local revoke. */
  revokedAt?: number;
}
