/**
 * A31: one mutex per Heartwood operator client. Every slot-policy mutation
 * path — the regular policy push, a child-direct ceiling push, pending-revoke
 * retries, the removal-time revoke — runs `list_clients → compile →
 * update_client` inside this lock, so two of them can never interleave and
 * land an older compile over a newer one. Keyed by the client object itself
 * (a WeakMap, so a forgotten client takes its queue with it).
 */
import { createSerialQueue, type SerialQueue } from './contacts-v2-queue';

const queues = new WeakMap<object, SerialQueue>();

export function withOperatorLock<T>(client: object, task: () => Promise<T>): Promise<T> {
  let q = queues.get(client);
  if (!q) { q = createSerialQueue(); queues.set(client, q); }
  return q.run(task);
}
