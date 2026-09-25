import { useEffect, useRef, useState } from 'react';
import { RelayClient } from 'signet-protocol';
import { loadPairedChild } from '../lib/db';
import { LocalSigningBackend } from '../lib/signing-backend';
import { extractEndpointPubkey } from '../lib/dependant-status-sync';
import { isValidRelayUrl } from '../lib/relay-url';
import { childContactReplyTransition, openChildContactReply, type ChildContactReply } from '../lib/child-contact-exchange';
import type { ChildRequestScope } from '../lib/child-contact-requests';
import { getDb } from '../lib/db';
import { updateEncryptedPrivateState } from '../lib/private-vault-store';

const HEX = /^[0-9a-f]{64}$/, ID = /^[0-9a-f]{32}$/;
export interface ChildContactReplyReceipt { id: string; fingerprint: string; reply: ChildContactReply; receivedAt: number }
interface Inbox { v: 1; guardian: string; child: string; endpoint: string; client: string; receipts: ChildContactReplyReceipt[] }
function rowId(scope: ChildRequestScope) { return `child-contact-reply-inbox:${scope.guardian}:${scope.child}:${scope.endpoint}:${scope.client}`; }
function parseInbox(raw: Inbox, scope: ChildRequestScope): Inbox {
  if (!raw || raw.v !== 1 || raw.guardian !== scope.guardian || raw.child !== scope.child || raw.endpoint !== scope.endpoint || raw.client !== scope.client || !Array.isArray(raw.receipts) || raw.receipts.length > 1024) throw new Error('Invalid child reply inbox');
  if (raw.receipts.some(r => !r || !ID.test(r.id) || !HEX.test(r.fingerprint) || !r.reply || r.reply.requestId !== r.id || r.reply.guardian !== scope.guardian || r.reply.endpoint !== scope.endpoint || r.reply.client !== scope.client || !scope.personas.includes(r.reply.persona) || !Number.isSafeInteger(r.receivedAt))) throw new Error('Invalid child reply receipt');
  if (new Set(raw.receipts.map(r => r.id)).size !== raw.receipts.length) throw new Error('Duplicate child reply receipt');
  return raw;
}
export async function saveChildContactReplyReceipt(scope: ChildRequestScope, key: string, receipt: ChildContactReplyReceipt, current: () => boolean) {
  const check = () => { if (!current()) throw new Error('Child reply session changed'); };
  return updateEncryptedPrivateState<Inbox>(rowId(scope), key, previous => {
    if (!current()) throw new Error('Child reply session changed');
    const inbox = parseInbox(previous ?? { v: 1, guardian: scope.guardian, child: scope.child, endpoint: scope.endpoint, client: scope.client, receipts: [] }, scope);
    const old = inbox.receipts.find(r => r.id === receipt.id);
    if (old) {
      if (old.fingerprint === receipt.fingerprint) return inbox;
      if (childContactReplyTransition(old.reply, receipt.reply) !== 'advance') return inbox;
      return { ...inbox, receipts: inbox.receipts.map(r => r.id === receipt.id ? receipt : r) };
    }
    if (inbox.receipts.length >= 1024) throw new Error('Child reply inbox is full');
    return { ...inbox, receipts: [...inbox.receipts, receipt] };
  }, check);
}
export async function loadChildContactReplyReceipts(scope: ChildRequestScope, key: string, current: () => boolean): Promise<ChildContactReplyReceipt[]> {
  if (!current()) throw new Error('Child reply session changed');
  const row = await (await getDb()).get('privateVaultState', rowId(scope)); if (!row) return [];
  const raw = await (await import('../lib/crypto-store')).decryptSecret(row.encrypted, key);
  return parseInbox(JSON.parse(raw), scope).receipts;
}

export function useChildContactReplyInbox(options: { enabled: boolean; child: string | null; key: string | null; relayUrl: string; guardian: string | null; personas: string[] }) {
  const { enabled, child, key, relayUrl, guardian } = options;
  const personas = JSON.stringify([...options.personas].sort());
  const session = JSON.stringify([enabled, child, key, relayUrl, guardian, personas]);
  const latest = useRef(session); latest.current = session;
  const [receipts, setReceipts] = useState<ChildContactReplyReceipt[]>([]);
  useEffect(() => {
    setReceipts([]);
    if (!enabled || !child || !key || !guardian || !isValidRelayUrl(relayUrl) || !HEX.test(guardian)) return;
    let active = true, relay: RelayClient | undefined, backend: LocalSigningBackend | undefined, queued = 0;
    let chain = Promise.resolve();
    const current = () => active && latest.current === session;
    void (async () => {
      const pair = await loadPairedChild(child, key); if (!current() || !pair || pair.guardianPubkey !== guardian) return;
      const endpoint = extractEndpointPubkey(pair.bunkerUri); if (!endpoint) return;
      const scope: ChildRequestScope = { guardian, child, endpoint, client: pair.clientKeypair.publicKey, personas: JSON.parse(personas) };
      const cached = await loadChildContactReplyReceipts(scope, key, current); if (current()) setReceipts(cached);
      backend = new LocalSigningBackend(pair.clientKeypair.privateKey);
      relay = new RelayClient(relayUrl);
      relay.subscribe([{ kinds: [30078], authors: [endpoint] } as never], event => {
        if (!current() || queued >= 32) return; queued++;
        chain = chain.then(async () => {
          const opened = await openChildContactReply(event, { scope, client: backend!, now: Math.floor(Date.now() / 1000), isCurrent: current });
          if (!opened || !current()) return;
          const saved = await saveChildContactReplyReceipt(scope, key, { id: opened.reply.requestId, fingerprint: opened.fingerprint, reply: opened.reply, receivedAt: Math.floor(Date.now() / 1000) }, current);
          if (current()) setReceipts(parseInbox(saved, scope).receipts);
        }).catch(() => {}).finally(() => { queued--; });
      });
      await relay.connect(); if (!current()) relay.disconnect();
    })().catch(() => { if (current()) setReceipts([]); });
    return () => { active = false; relay?.disconnect(); backend?.destroy(); };
  }, [enabled, child, key, relayUrl, guardian, personas, session]);
  return receipts;
}
