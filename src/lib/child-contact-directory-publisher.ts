import type { NostrEvent } from 'signet-protocol';
import type { ChildSettings, ContactRecord, DependantIdentity } from '../types';
import { isDependantNaturalPersonActive } from './identity-display';
import { pairedDeviceAllows } from './paired-device-personas';
import { updateEncryptedPrivateState } from './private-vault-store';
import { projectChildContactDirectory, sealChildContactDirectory } from './child-contact-directory';
import type { DecryptingSigningBackend } from './signing-backend';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const HEX = /^[0-9a-f]{64}$/;
const MAX_REVISION = 253402300799;
interface Revision { v: 1; guardian: string; child: string; endpoint: string; recipient: string; revision: number; issuedAt?: number }
export interface ChildDirectoryPublicationScope {
  dependant: DependantIdentity;
  settings?: ChildSettings;
  records: ContactRecord[];
}
/** Unlike owner list selection, delivery omits hidden and dormant slots, and
 * personas removed from a direct child's phone (A51) — the same rule as the
 * persona inventory (`pairedDeviceAllows`). The child refuses a directory
 * naming a persona it no longer has, so this list must not outlive the card. */
export function childDirectoryPersonas(dep: Pick<DependantIdentity, 'persona' | 'extraPersonas' | 'naturalPerson' | 'naturalPersonActive' | 'hiddenOnPairedDeviceKeys' | 'childDevice'>): string[] {
  const allows = pairedDeviceAllows(dep);
  return [...new Set([
    ...(allows(dep.persona.publicKey) ? [dep.persona.publicKey] : []),
    ...(dep.extraPersonas ?? []).filter(p => allows(p.publicKey, p.hidden === true)).map(p => p.publicKey),
    ...(isDependantNaturalPersonActive(dep) && allows(dep.naturalPerson.publicKey) ? [dep.naturalPerson.publicKey] : []),
  ].filter(Boolean))].sort();
}

/**
 * D6: the one persona a paired child asks its guardian with, and the label the
 * ask screen shows for it — a single source, so the screen can never name one
 * key while the request is checked against another. Only owned, visible,
 * non-dormant personas qualify (`childDirectoryPersonas`); `preferred` (the
 * contacts-list selection) wins when it qualifies. Null until one exists —
 * e.g. between pairing and the guardian's first persona inventory, when the
 * only slot is the dormant real-identity stub the pairing URI seeded.
 */
export function resolveChildAskPersona(
  identity: Parameters<typeof childDirectoryPersonas>[0],
  preferred: string | null | undefined,
): { pubkey: string; label: string } | null {
  const personas = childDirectoryPersonas(identity);
  const want = preferred?.toLowerCase();
  const pubkey = personas.find(p => p.toLowerCase() === want) ?? personas.find(p => p === identity.persona.publicKey) ?? personas[0];
  if (!pubkey) return null;
  const slot = [identity.persona, ...(identity.extraPersonas ?? []), identity.naturalPerson].find(s => s.publicKey === pubkey);
  return { pubkey, label: slot?.displayName || `Identity ${pubkey.slice(0, 8)}` };
}

/** Device-local floor is shared by tabs, independent of the wall clock. Never
 * reset a corrupt floor or recycle a revision after a cancelled/failed send. */
export async function reserveChildDirectoryRevision(scope: Omit<Revision, 'v' | 'revision' | 'issuedAt'>, key: string, current: () => boolean): Promise<number> {
  return (await reservePublication(scope, key, current, Math.floor(Date.now() / 1000))).revision;
}
async function reservePublication(scope: Omit<Revision, 'v' | 'revision' | 'issuedAt'>, key: string, current: () => boolean, now: number): Promise<Revision & { issuedAt: number }> {
  scope = { ...scope };
  if (!Object.values(scope).every(p => typeof p === 'string' && HEX.test(p)) || !key) throw new Error('Invalid directory publication scope');
  const check = () => { if (!current()) throw new Error('Child directory session changed'); };
  check();
  const id = `child-directory-revision:${scope.guardian}:${scope.child}:${scope.endpoint}:${scope.recipient}`;
  const next = await updateEncryptedPrivateState<Revision>(id, key, old => {
    check();
    if (old !== undefined && (!old || old.v !== 1 || Object.entries(scope).some(([k, v]) => old[k as keyof Revision] !== v)
      || !Number.isSafeInteger(old.revision) || old.revision < 1 || old.revision >= MAX_REVISION
      || (old.issuedAt !== undefined && (!Number.isSafeInteger(old.issuedAt) || old.issuedAt < 0 || old.issuedAt >= MAX_REVISION)))) throw new Error('Invalid child directory revision floor');
    // Relays order replaceable events by created_at, not our encrypted revision.
    // Reserve both together so same-second updates from separate tabs cannot
    // leave an older snapshot as the only event available to an offline child.
    const issuedAt = Math.max(now, (old?.issuedAt ?? now - 1) + 1);
    if (!Number.isSafeInteger(now) || now < 0 || issuedAt > now + 300 || issuedAt >= MAX_REVISION) throw new Error('Child directory publication clock changed');
    return { v: 1, ...scope, revision: (old?.revision ?? 0) + 1, issuedAt };
  }, check);
  check();
  return next as Revision & { issuedAt: number };
}

/** One publication kept for a retry (in memory only): the signed event and a
 * digest of exactly what it was built from. */
export interface ChildDirectoryResendEntry {
  guardian: string; event: NostrEvent; bindingDigest: string; revision: number; issuedAt: number; expiresAt: number;
}
/** Per child id, owned by the caller for one publication attempt and its retries. */
export type ChildDirectoryResendCache = Map<string, ChildDirectoryResendEntry>;
/** A retry this close to a publication's expiry builds a fresh one instead. */
export const CHILD_DIRECTORY_RESEND_MARGIN_S = 300;

const digest = (binding: string) => bytesToHex(sha256(new TextEncoder().encode(binding)));

/** All waits (including socket connection) belong before send. The adapter must
 * read fresh encrypted guardian state and synchronously transmit on an already
 * open socket; it must not queue an event for a later connection/retry.
 *
 * With `resend` (a retry of a send that failed or was not acknowledged): when
 * the publication kept there for this child still matches what fresh guardian
 * state would build at its revision and time, and is not near expiry, the same
 * signed event goes again — no new revision, no new signature. Anything else
 * (a real change, near expiry, no entry) builds a fresh one with a new
 * revision, as before. This does not grant child write access. */
export async function publishChildContactDirectory(options: {
  guardian: string; child: string; key: string; isCurrent(): boolean;
  readScope(): Promise<ChildDirectoryPublicationScope>;
  signer(scope: ChildDirectoryPublicationScope): Promise<DecryptingSigningBackend>;
  send(event: NostrEvent): void;
  now?(): number;
  resend?: ChildDirectoryResendCache;
}): Promise<void> {
  const o = { ...options };
  const check = () => { if (!o.isCurrent()) throw new Error('Child directory session changed'); };
  const now = () => o.now?.() ?? Math.floor(Date.now() / 1000);
  const read = async (revision: number, issuedAt: number) => {
    check();
    const scope = structuredClone(await o.readScope());
    check();
    const dep = scope.dependant, endpoint = dep.bunkerEndpoint;
    if (dep.id !== o.child || dep.guardianPubkey !== o.guardian || !endpoint?.authorizedClientPubkey
      || !HEX.test(endpoint.publicKey)) throw new Error('Child directory pairing unavailable');
    const view = projectChildContactDirectory({ child: o.child, guardian: o.guardian, recipient: endpoint.authorizedClientPubkey,
      availablePersonas: dep.autonomyStage === 'full-control' ? [] : childDirectoryPersonas(dep),
      records: dep.autonomyStage === 'full-control' ? [] : scope.records, settings: scope.settings, revision, now: issuedAt });
    return { scope, view, endpoint: endpoint.publicKey, binding: JSON.stringify([endpoint, view]) };
  };
  const kept = o.resend?.get(o.child);
  if (kept) {
    o.resend!.delete(o.child);
    const again = await read(kept.revision, kept.issuedAt);
    check();
    const t = now();
    if (kept.guardian === o.guardian && digest(again.binding) === kept.bindingDigest
      && t < kept.expiresAt - CHILD_DIRECTORY_RESEND_MARGIN_S && t >= kept.issuedAt - 300) {
      o.resend!.set(o.child, kept);
      o.send(kept.event);
      return;
    }
  }
  const initial = await read(0, now());
  const { revision, issuedAt } = await reservePublication({ guardian: o.guardian, child: o.child,
    endpoint: initial.endpoint, recipient: initial.view.recipient }, o.key, o.isCurrent, now());
  const expected = { ...initial.view, revision, issuedAt, expiresAt: issuedAt + 900 };
  const binding = JSON.stringify([initial.scope.dependant.bunkerEndpoint, expected]);
  let backend: DecryptingSigningBackend | undefined;
  try {
    backend = await o.signer(initial.scope);
    check();
    if (backend.activePublicKeyHex !== initial.endpoint || (await read(revision, issuedAt)).binding !== binding) throw new Error('Child directory scope changed');
    const event = await sealChildContactDirectory(expected, backend);
    if ((await read(revision, issuedAt)).binding !== binding) throw new Error('Child directory scope changed');
    check();
    if (now() >= expected.expiresAt || now() < issuedAt - 300) throw new Error('Child directory publication expired');
    o.resend?.set(o.child, { guardian: o.guardian, event, bindingDigest: digest(binding), revision, issuedAt, expiresAt: expected.expiresAt });
    o.send(event);
  } finally { backend?.destroy(); }
}
