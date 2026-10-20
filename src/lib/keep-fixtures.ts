// Test-only builders: real, signed Bothy-shaped events (no mocks of verify).
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'signet-protocol';
import { KEEP_CLAIM_KIND, KEEP_STATUS_KIND } from './keep-wire';

export interface Key { sk: Uint8Array; pk: string }
export function newKey(): Key { const sk = generateSecretKey(); return { sk, pk: getPublicKey(sk) }; }

export function claimEvent(
  signer: Key, node: string,
  o: { createdAt?: number; role?: string; status?: string; name?: string; region?: string; extraP?: string[][] } = {},
): NostrEvent {
  const status = o.status ?? 'active';
  const tags: string[][] = [
    ['d', node],
    ['p', node, '', 'node'],
    ['p', signer.pk, '', 'master'],
    ...(status === 'active' ? [['p', 'cc'.repeat(32), '', 'stash']] : []),
    ['role', o.role ?? 'box'],
    ...(o.region ? [['region', o.region]] : []),
    ['status', status],
    ...(o.name ? [['name', o.name]] : []),
    ...(o.extraP ?? []),
  ];
  return finalizeEvent({ kind: KEEP_CLAIM_KIND, created_at: o.createdAt ?? 1_000, tags, content: '' }, signer.sk) as NostrEvent;
}

export function statusEvent(
  node: Key, claimId: string,
  o: { createdAt?: number; free?: number; software?: string } = {},
): NostrEvent {
  const tags: string[][] = [
    ['claim', claimId],
    ['free', String(o.free ?? 21474836480)],
    ...(o.software ? [['software', o.software, 'unknown']] : []),
  ];
  return finalizeEvent({ kind: KEEP_STATUS_KIND, created_at: o.createdAt ?? 2_000, tags, content: '' }, node.sk) as NostrEvent;
}
