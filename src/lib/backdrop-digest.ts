import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * sha256 (hex) of a local backdrop picture. The guardian's slot records the one
 * it last sent (`backdropSentDigest`); a card compares that with the picture
 * now stored locally to know whether the child's phone has the current one.
 */
export async function backdropDigest(blob: Blob): Promise<string> {
  return bytesToHex(sha256(new Uint8Array(await blob.arrayBuffer())));
}
