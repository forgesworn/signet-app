import { isValidRelayUrl } from './relay-url';

export interface RelayHealth {
  status: 'reachable' | 'restricted' | 'unreachable';
  detail: string;
  checkedAt: number;
  latencyMs: number;
}

/** A bounded connection/read check. Never publishes or signs an event. */
export function checkRelayHealth(url: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RelayHealth> {
  const startedAt = Date.now();
  const result = (status: RelayHealth['status'], detail: string): RelayHealth => ({
    status, detail, checkedAt: Date.now(), latencyMs: Date.now() - startedAt,
  });
  if (!isValidRelayUrl(url)) return Promise.resolve(result('unreachable', 'Invalid relay URL.'));
  if (opts.signal?.aborted) return Promise.resolve(result('unreachable', 'Check cancelled.'));
  return new Promise(resolve => {
    let socket: WebSocket;
    try { socket = new WebSocket(url); }
    catch { resolve(result('unreachable', 'Could not open a WebSocket connection.')); return; }
    const subscription = `health-${crypto.randomUUID()}`;
    let done = false;
    let opened = false;
    let authRequested = false;
    let notice = '';
    const finish = (status: RelayHealth['status'], detail: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', cancel);
      if (opened) {
        try { socket.send(JSON.stringify(['CLOSE', subscription])); } catch { /* closed */ }
      }
      try { socket.close(); } catch { /* closed */ }
      resolve(result(status, detail));
    };
    const cancel = () => finish('unreachable', 'Check cancelled.');
    const timer = setTimeout(() => finish(opened ? 'restricted' : 'unreachable', notice || (opened ? 'Connected, but the relay did not answer the read check.' : 'Connection timed out.')), opts.timeoutMs ?? 5000);
    opts.signal?.addEventListener('abort', cancel, { once: true });
    socket.onopen = () => {
      if (done) return;
      opened = true;
      try { socket.send(JSON.stringify(['REQ', subscription, { kinds: [0], limit: 0 }])); }
      catch { finish('unreachable', 'Could not send the read check.'); }
    };
    socket.onmessage = ({ data }) => {
      if (done) return;
      let frame: unknown;
      try { frame = JSON.parse(String(data)); } catch { return; }
      if (!Array.isArray(frame)) return;
      if (frame[0] === 'AUTH') authRequested = true;
      if (frame[0] === 'NOTICE' && typeof frame[1] === 'string') notice = frame[1].slice(0, 250);
      if (frame[1] !== subscription) return;
      if (frame[0] === 'EOSE') finish('reachable', authRequested ? 'Read check passed. The relay requested authentication; writes may require it.' : 'Connection and read check passed.');
      if (frame[0] === 'CLOSED') finish('restricted', typeof frame[2] === 'string' ? frame[2].slice(0, 250) : 'Relay refused the read check.');
    };
    socket.onerror = () => finish('unreachable', 'WebSocket connection failed.');
    socket.onclose = () => finish('unreachable', 'Connection closed before the read check completed.');
  });
}
