import { createSerialQueue } from './contacts-v2-queue';
/** Live reply processing and the optical screen share an exchange inbox. Hold
 * one queue across read/decrypt/sign/write, rather than racing the same packet
 * after its per-unlock decrypt budget has already been consumed. */
const queue = createSerialQueue();
export function contactInviteWork<T>(work: () => Promise<T>): Promise<T> {
  return queue.run(work);
}
