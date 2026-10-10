import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { checkRelayHealth } from './relay-health';

class Socket {
  static instances: Socket[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  send = vi.fn();
  close = vi.fn();
  constructor() { Socket.instances.push(this); }
  frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  get subscription() { return JSON.parse(this.send.mock.calls[0][0])[1]; }
}
beforeEach(() => { vi.useFakeTimers(); Socket.instances = []; vi.stubGlobal('WebSocket', Socket); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('read-only relay health', () => {
  it('requires a relay read response, publishes nothing and closes the socket', async () => {
    const check = checkRelayHealth('wss://relay.example');
    const socket = Socket.instances[0];
    socket.onopen?.();
    socket.frame(['EOSE', 'another-subscription']);
    expect(socket.close).not.toHaveBeenCalled();
    socket.frame(['EOSE', socket.subscription]);
    expect((await check).status).toBe('reachable');
    expect(socket.send.mock.calls.map(([raw]) => JSON.parse(raw)[0])).toEqual(['REQ', 'CLOSE']);
    expect(socket.close).toHaveBeenCalledOnce();
  });
  it('reports the actual read refusal rather than claiming the relay is down', async () => {
    const check = checkRelayHealth('wss://relay.example');
    const socket = Socket.instances[0];
    socket.onopen?.();
    socket.frame(['CLOSED', socket.subscription, 'auth-required: authenticate first']);
    expect(await check).toMatchObject({ status: 'restricted', detail: 'auth-required: authenticate first' });
  });
  it('does not mistake an authentication challenge for a failed public read', async () => {
    const check = checkRelayHealth('wss://relay.example');
    const socket = Socket.instances[0];
    socket.onopen?.();
    socket.frame(['AUTH', 'challenge']);
    socket.frame(['EOSE', socket.subscription]);
    expect(await check).toMatchObject({ status: 'reachable', detail: expect.stringContaining('writes may require it') });
  });
  it('distinguishes a connection failure from a connected relay that never answers', async () => {
    const disconnected = checkRelayHealth('wss://offline.example');
    await vi.advanceTimersByTimeAsync(5000);
    expect((await disconnected).status).toBe('unreachable');
    const silent = checkRelayHealth('wss://silent.example');
    Socket.instances[1].onopen?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await silent).status).toBe('restricted');
  });
  it('cancels a check and ignores later relay frames', async () => {
    const controller = new AbortController();
    const check = checkRelayHealth('wss://relay.example', { signal: controller.signal });
    const socket = Socket.instances[0];
    controller.abort();
    socket.onopen?.();
    socket.frame(['EOSE', 'late']);
    expect((await check).detail).toBe('Check cancelled.');
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
