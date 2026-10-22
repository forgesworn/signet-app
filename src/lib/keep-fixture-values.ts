/**
 * The values behind the committed cross-check fixtures (`fixtures/keep-m-*.json`),
 * using the K1d contract's throwaway keys (never used outside tests).
 */
export const FIXTURE = {
  /** Keep secret key: 63 zeros then 1. */
  keepSk: '0'.repeat(63) + '1',
  /** Owner secret key: 63 zeros then 2. */
  ownerSk: '0'.repeat(63) + '2',
  /** The invited friend's persona key is the public key of this secret (63 zeros then 3). */
  friendSk: '0'.repeat(63) + '3',
  code: '00112233445566778899aabbccddeeff',
  grant: 'ffeeddccbbaa99887766554433221100',
  secret: '000102030405060708090a0b0c0d0e0f' + '101112131415161718191a1b1c1d1e1f',
  label: 'Dave',
  /** The rumors' real time, and the base of the invite's 30-day expiration. 2026-10-22 08:26:40 UTC. */
  createdAt: 1_792_657_600,
} as const;
