/**
 * A48 — the guardian acting as the child.
 *
 * When the guardian's own phone signs (or encrypts/decrypts) as one of a
 * direct-paired dependant's personas through its routed Heartwood backend, the
 * Heartwood writes a C5 record for that persona that the child's phone never
 * reported. Without a record of our own, the merged timeline (spec §9.2)
 * would flag it as "signed on the Heartwood but not reported".
 *
 * So every such call is stamped (`withRequestCreatedAt`, strictly increasing
 * per persona via `nextRequestCreatedAt`) and, once the call succeeds,
 * recorded locally as `{source:'guardian', persona, kind, method,
 * requestCreatedAt, at}` in an encrypted device-local row (kept 7 days,
 * capped at 1000). `mergeActivity` matches a device record against these rows
 * and shows it as "Signed by you", never a mismatch.
 */
import type { DecryptingSigningBackend } from './signing-backend';
import { withRequestCreatedAt } from './signing-backend';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';

export interface GuardianActingEntry {
  source: 'guardian';
  persona: string;
  kind: number | null;
  method: 'sign_event' | 'nip44_encrypt' | 'nip44_decrypt';
  /** Unix seconds: the forced request `created_at` the Heartwood echoes. */
  requestCreatedAt: number;
  /** Unix seconds. */
  at: number;
}

export const GUARDIAN_ACTING_KEEP_S = 7 * 86_400;
export const GUARDIAN_ACTING_MAX = 1000;

const HEX64 = /^[0-9a-f]{64}$/;
const METHODS = ['sign_event', 'nip44_encrypt', 'nip44_decrypt'] as const;
const posInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

export function parseGuardianActingEntry(raw: unknown): GuardianActingEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.source !== 'guardian' || typeof o.persona !== 'string' || !HEX64.test(o.persona)) return null;
  if (typeof o.method !== 'string' || !(METHODS as readonly string[]).includes(o.method)) return null;
  if (!posInt(o.requestCreatedAt) || !posInt(o.at)) return null;
  let kind: number | null = null;
  if (o.kind !== null && o.kind !== undefined) {
    if (!Number.isInteger(o.kind) || (o.kind as number) < 0 || (o.kind as number) > 65535) return null;
    kind = o.kind as number;
  }
  return { source: 'guardian', persona: o.persona, kind, method: o.method as GuardianActingEntry['method'], requestCreatedAt: o.requestCreatedAt, at: o.at };
}

/** Drop rows older than 7 days; keep the newest 1000. Newest first. */
export function pruneGuardianActing(list: GuardianActingEntry[], nowS: number): GuardianActingEntry[] {
  return list
    .filter(e => nowS - e.at <= GUARDIAN_ACTING_KEEP_S)
    .sort((a, b) => b.at - a.at || b.requestCreatedAt - a.requestCreatedAt)
    .slice(0, GUARDIAN_ACTING_MAX);
}

export interface GuardianActingDeps {
  /** Strictly increasing per persona, at most 30 s ahead (useChildGate's `reserveRequestCreatedAt`, A58). */
  stamp(persona: string): number | Promise<number>;
  record(e: GuardianActingEntry): void;
  nowS?: () => number;
}

/**
 * A view of `inner` (a routed backend for `persona`) whose sign / NIP-44
 * calls are stamped and, on success, recorded. Everything else — pubkey,
 * `isDestroyed`, `destroy`, `stamped`, `request`… — passes straight through,
 * and `instanceof` still sees the inner class.
 */
export function guardianActingBackend(inner: DecryptingSigningBackend, persona: string, deps: GuardianActingDeps): DecryptingSigningBackend {
  const p = persona.toLowerCase();
  const nowS = deps.nowS ?? (() => Math.floor(Date.now() / 1000));
  const note = (kind: number | null, method: GuardianActingEntry['method'], requestCreatedAt: number) => {
    try { deps.record({ source: 'guardian', persona: p, kind, method, requestCreatedAt, at: nowS() }); } catch { /* bookkeeping only */ }
  };
  const signEvent = async (event: UnsignedEvent): Promise<NostrEvent> => {
    const n = await deps.stamp(p);
    const out = await withRequestCreatedAt(inner, n).signEvent(event);
    note(typeof event?.kind === 'number' ? event.kind : null, 'sign_event', n);
    return out;
  };
  const nip44Encrypt = async (peer: string, plaintext: string): Promise<string> => {
    const n = await deps.stamp(p);
    const out = await withRequestCreatedAt(inner, n).nip44Encrypt(peer, plaintext);
    note(null, 'nip44_encrypt', n);
    return out;
  };
  const nip44Decrypt = async (peer: string, ciphertext: string): Promise<string> => {
    const n = await deps.stamp(p);
    const out = await withRequestCreatedAt(inner, n).nip44Decrypt(peer, ciphertext);
    note(null, 'nip44_decrypt', n);
    return out;
  };
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'signEvent') return signEvent;
      if (prop === 'nip44Encrypt') return nip44Encrypt;
      if (prop === 'nip44Decrypt') return nip44Decrypt;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
