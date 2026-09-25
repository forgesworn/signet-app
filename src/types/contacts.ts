export interface Contact {
  /** Their pubkey — primary key */
  pubkey: string;
  /** Which of our accounts owns this connection */
  ownerPubkey: string;
  displayName: string;
  /** ECDH shared secret for Signet Me words */
  sharedSecret: string;
  /** When we verified them */
  verifiedAt: number;
  /** Optional relationship label */
  relationship?: 'parent' | 'child' | 'sibling' | 'grandparent' | 'partner' | 'other';
  isChild?: boolean;
  /** Group ID linking multiple pubkeys belonging to the same person */
  groupId?: string;
  /** Label for this pubkey within a group (e.g. "Gaming", "Natural Person") */
  label?: string;
  /** Whether this is the default pubkey for its group */
  isDefaultForGroup?: boolean;
}
