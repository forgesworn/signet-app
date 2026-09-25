import { beforeEach, expect, it, vi } from 'vitest';
import { LocalSigningBackend } from './signing-backend';
import { getDb, purgeAllUserData } from './db';
import * as cryptoStore from './crypto-store';
import { loadChildContactInbox, openChildContactRequest, parseChildContactRequest, sealChildContactRequest, storeChildContactRequest, transitionChildContactReceipt, type ChildContactRequest } from './child-contact-requests';
const endpointKey = '04'.repeat(32), clientKey = '05'.repeat(32);
const endpoint = new LocalSigningBackend(endpointKey), client = new LocalSigningBackend(clientKey);
const scope = { guardian: '1'.repeat(64), child: '2'.repeat(64), endpoint: endpoint.activePublicKeyHex, client: client.activePublicKeyHex, personas: ['3'.repeat(64)] };
const now = 1800000000, key = 'child-request-inbox-test', current = () => true;
const request = (): ChildContactRequest => ({ v: 1, id: 'a'.repeat(32), guardian: scope.guardian, endpoint: scope.endpoint, client: scope.client,
  persona: scope.personas[0], revision: 1, createdAt: now, expiresAt: now + 600,
  invite: { v: 1, recipient: '6'.repeat(64), secret: '7'.repeat(64), relays: ['wss://invite.example/'], caption: 'Private invite name' } });
const options = () => ({ scope, endpoint, now, isCurrent: current });
beforeEach(async () => { vi.restoreAllMocks(); await purgeAllUserData(); });
it('authenticates the pinned child transport before decryption and excludes private fields from tags', async () => {
  const r = request(), event = await sealChildContactRequest(r, client);
  expect(event.tags).toEqual([['d', `signet:child-contact-request:v1:${r.id}`]]);
  expect(JSON.stringify(event)).not.toContain(r.persona);
  expect(JSON.stringify(event)).not.toContain('Private invite name');
  expect(await openChildContactRequest(event, options())).toMatchObject({ request: r });
  const decrypt = vi.spyOn(endpoint, 'nip44Decrypt'); decrypt.mockClear();
  expect(await openChildContactRequest({ ...event, content: event.content + 'x' }, options())).toBeNull();
  expect(await openChildContactRequest(event, { ...options(), scope: { ...scope, client: scope.child } })).toBeNull();
  expect(await openChildContactRequest(event, { ...options(), now: now + 600 })).toBeNull();
  expect(decrypt).not.toHaveBeenCalled();
});
it('refuses foreign personas, guardians, stale pairings and session changes during decryption', async () => {
  const event = await sealChildContactRequest(request(), client);
  for (const wrong of [{ ...scope, personas: [] }, { ...scope, guardian: scope.child }, { ...scope, endpoint: scope.child }])
    expect(await openChildContactRequest(event, { ...options(), scope: wrong })).toBeNull();
  let active = true; const decrypt = endpoint.nip44Decrypt.bind(endpoint);
  vi.spyOn(endpoint, 'nip44Decrypt').mockImplementation(async (...args) => { const raw = await decrypt(...args); active = false; return raw; });
  expect(await openChildContactRequest(event, { ...options(), isCurrent: () => active })).toBeNull();
});
it('bounds request lifetime, invite expiry and plaintext size', () => {
  expect(parseChildContactRequest(JSON.stringify({ ...request(), expiresAt: now + 601 }))).toBeNull();
  expect(parseChildContactRequest(JSON.stringify({ ...request(), invite: { ...request().invite, expiresAt: now + 100 } }))).toBeNull();
  expect(parseChildContactRequest(JSON.stringify({ ...request(), extra: 'x'.repeat(12000) }))).toBeNull();
  expect(parseChildContactRequest(JSON.stringify({ ...request(), revision: 0 }))).toBeNull();
});
it('persists before acknowledging, deduplicates replay and keeps conflicts sticky without invite secrets', async () => {
  const opened = (await openChildContactRequest(await sealChildContactRequest(request(), client), options()))!;
  const save = (fingerprint = opened.fingerprint) => storeChildContactRequest({ ...opened, fingerprint, scope, key, now, isCurrent: current });
  await Promise.all([save(), save()]);
  expect(await loadChildContactInbox(scope, key, now, current)).toHaveLength(1);
  const row = (await (await getDb()).getAll('privateVaultState'))[0];
  expect(row.encrypted).not.toContain('Private invite name');
  expect(await save('f'.repeat(64))).toMatchObject({ status: 'conflict' });
  expect(await save()).toMatchObject({ status: 'conflict' });
  expect((await loadChildContactInbox(scope, key, now, current))[0].request).toBeUndefined();
  expect(await loadChildContactInbox({ ...scope, client: scope.child }, key, now, current)).toEqual([]);
});
it('rejects overflow without dropping requests and frees capacity only through expiry', async () => {
  const r = request();
  await storeChildContactRequest({ scope, key, request: r, fingerprint: 'f'.repeat(64), now, isCurrent: current });
  const db = await getDb(), row = (await db.getAll('privateVaultState'))[0];
  const stored = JSON.parse(await cryptoStore.decryptSecret(row.encrypted, key));
  const receipt = stored.receipts[0];
  stored.receipts = Array.from({ length: 32 }, (_, index) => {
    const id = index.toString(16).padStart(32, '0');
    return { ...receipt, id, request: { ...receipt.request, id } };
  });
  await db.put('privateVaultState', { ...row, encrypted: await cryptoStore.encryptSecret(JSON.stringify(stored), key) });
  await expect(storeChildContactRequest({ scope, key, request: r, fingerprint: 'f'.repeat(64), now, isCurrent: current })).rejects.toThrow('full');
  expect(await loadChildContactInbox(scope, key, now, current)).toHaveLength(32);
  await storeChildContactRequest({ scope, key, request: { ...r, createdAt: now + 601, expiresAt: now + 1201 }, fingerprint: 'e'.repeat(64), now: now + 601, isCurrent: current });
  const receipts = await loadChildContactInbox(scope, key, now + 601, current);
  expect(receipts).toHaveLength(33);
  expect(receipts.filter(r => r.status === 'pending')).toHaveLength(1);
  expect(receipts.filter(r => r.status === 'expired').every(r => r.request === undefined)).toBe(true);
});
it('never resets corrupted state and refuses a lock during persistence', async () => {
  let active = true; const encrypt = cryptoStore.encryptSecret;
  vi.spyOn(cryptoStore, 'encryptSecret').mockImplementation(async (...args) => { const result = await encrypt(...args); active = false; return result; });
  await expect(storeChildContactRequest({ scope, key, request: request(), fingerprint: 'f'.repeat(64), now, isCurrent: () => active })).rejects.toThrow('session changed');
  expect(await (await getDb()).getAll('privateVaultState')).toEqual([]);
  vi.restoreAllMocks();
  await storeChildContactRequest({ scope, key, request: request(), fingerprint: 'f'.repeat(64), now, isCurrent: current });
  const db = await getDb(), row = (await db.getAll('privateVaultState'))[0];
  await db.put('privateVaultState', { ...row, encrypted: 'corrupt' });
  await expect(storeChildContactRequest({ scope, key, request: request(), fingerprint: 'f'.repeat(64), now, isCurrent: current })).rejects.toThrow();
});
it('persists persona withdrawal so showing the persona again cannot revive the prompt', async () => {
  await storeChildContactRequest({ scope, key, request: request(), fingerprint: 'f'.repeat(64), now, isCurrent: current });
  expect((await loadChildContactInbox({ ...scope, personas: [] }, key, now, current))[0]).toMatchObject({ status: 'expired' });
  expect((await loadChildContactInbox(scope, key, now, current))[0]).toMatchObject({ status: 'expired' });
  expect((await loadChildContactInbox(scope, key, now, current))[0].request).toBeUndefined();
});

it('moves a receipt out of pending by compare-and-swap and never back, including across reload and replay', async () => {
  const opened = (await openChildContactRequest(await sealChildContactRequest(request(), client), options()))!;
  await storeChildContactRequest({ scope, key, request: opened.request, fingerprint: opened.fingerprint, now, isCurrent: current });
  const move = (from: Parameters<typeof transitionChildContactReceipt>[0]['from'], to: Parameters<typeof transitionChildContactReceipt>[0]['to'], at = now + 1) =>
    transitionChildContactReceipt({ scope, key, requestId: request().id, from, to, now: at, isCurrent: current });
  expect(await move(['pending'], 'approved')).toMatchObject({ status: 'approved' });
  expect((await loadChildContactInbox(scope, key, now + 2, current))[0]).toMatchObject({ status: 'approved' });
  expect((await loadChildContactInbox(scope, key, now + 2, current))[0].request).toBeUndefined();
  await expect(move(['pending'], 'denied')).rejects.toThrow('already approved');
  await expect(move(['approved'], 'pending' as never)).rejects.toThrow('Invalid');
  expect(await move(['pending'], 'approved')).toMatchObject({ status: 'approved' });
  // A relay replay of the same bytes cannot revive the prompt.
  expect(await storeChildContactRequest({ scope, key, request: opened.request, fingerprint: opened.fingerprint, now: now + 3, isCurrent: current })).toMatchObject({ status: 'approved' });
  expect(await move(['approved'], 'completed', now + 4)).toMatchObject({ status: 'completed' });
  // The request expiry passing later does not rewrite a finished receipt.
  expect((await loadChildContactInbox(scope, key, now + 5000, current))[0]).toMatchObject({ status: 'completed' });
});
