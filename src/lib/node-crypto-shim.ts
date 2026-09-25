/** Shim for node:crypto used by @forgesworn/shamir-words in browser builds */
export function randomFillSync<T extends ArrayBufferView>(buf: T): T {
  crypto.getRandomValues(buf as unknown as ArrayBufferView & { buffer: ArrayBuffer });
  return buf;
}
