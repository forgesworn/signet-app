import { beforeEach, expect, it, vi } from 'vitest';
import { sendConnectResponse } from './nip46';
import { LocalSigningBackend } from './signing-backend';
const relay = vi.hoisted(() => ({ connect: vi.fn(), publish: vi.fn(), disconnect: vi.fn() }));
vi.mock('signet-protocol', async importOriginal => ({ ...await importOriginal<object>(), RelayClient: class {
  connect = relay.connect; publish = relay.publish; disconnect = relay.disconnect;
} }));
const signer = new LocalSigningBackend('04'.repeat(32));
const client = new LocalSigningBackend('05'.repeat(32));
const request = { clientPubkey: client.activePublicKeyHex, relayUrl: 'wss://relay.test', relayUrls: ['wss://relay.test'], secret: 'connection-secret', appName: 'Bot game' };
beforeEach(() => { vi.resetAllMocks(); relay.publish.mockResolvedValue({ ok: true }); });
it('withholds a pairing reply if consent changed while connecting', async () => {
  let current = true;
  relay.connect.mockImplementation(async () => { current = false; });
  await expect(sendConnectResponse(request, signer, request.relayUrl, async () => { if (!current) throw new Error('revoked'); })).rejects.toThrow('revoked');
  expect(relay.publish).not.toHaveBeenCalled();
  expect(relay.disconnect).toHaveBeenCalledOnce();
});
it('does not report connected if consent changed while waiting for the acknowledgement', async () => {
  let current = true;
  relay.publish.mockImplementation(async () => { current = false; return { ok: true }; });
  await expect(sendConnectResponse(request, signer, request.relayUrl, async () => { if (!current) throw new Error('revoked'); })).rejects.toThrow('revoked');
  expect(relay.publish).toHaveBeenCalledOnce();
  expect(relay.disconnect).toHaveBeenCalledOnce();
});
it('checks consent around publication and preserves ordinary pairing callers', async () => {
  const guard = vi.fn(async () => {});
  expect(await sendConnectResponse(request, signer, request.relayUrl, guard)).toBe(true);
  expect(guard).toHaveBeenCalledTimes(2);
  expect(await sendConnectResponse(request, signer)).toBe(true);
});
