import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * A minimal in-process NIP-01 relay on 127.0.0.1, for specs where a Node-side
 * consumer and the browser app have to meet at one relay (the consumer cannot
 * be served by Playwright's `routeWebSocket`, which only intercepts the page).
 *
 * It stores every event it is sent and answers REQ with matching stored events
 * then EOSE, forwards new events to open subscriptions, and acknowledges with
 * OK. No NIP-42 AUTH, no signature checks: the clients under test verify what
 * they receive. The app accepts `ws://` for 127.0.0.1, so its relay URL can be
 * `relay.url`. Text frames only, which is all NIP-01 uses.
 */

interface NostrEvent {
  id: string; pubkey: string; kind: number; created_at: number;
  tags: string[][]; content: string; sig: string;
}
type Filter = {
  ids?: string[]; authors?: string[]; kinds?: number[];
  since?: number; until?: number; limit?: number;
} & Record<string, unknown>;

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function matches(event: NostrEvent, filter: Filter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (typeof filter.since === 'number' && event.created_at < filter.since) return false;
  if (typeof filter.until === 'number' && event.created_at > filter.until) return false;
  for (const [key, wanted] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(wanted)) continue;
    const name = key.slice(1);
    if (!event.tags.some(tag => tag[0] === name && wanted.includes(tag[1]))) return false;
  }
  return true;
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) header = Buffer.from([0x80 | opcode, length]);
  else if (length < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2); }
  return Buffer.concat([header, payload]);
}

/** Parse as many complete client frames as `buffer` holds; returns the unread tail. */
function decodeFrames(buffer: Buffer, onFrame: (opcode: number, payload: Buffer) => void): Buffer {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor); cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8;
    }
    const maskLength = masked ? 4 : 0;
    if (buffer.length - cursor < maskLength + length) break;
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : undefined;
    cursor += maskLength;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    onFrame(opcode, payload);
    offset = cursor + length;
  }
  return buffer.subarray(offset);
}

interface Client { socket: Socket; subscriptions: Map<string, Filter[]> }

export class LocalRelay {
  readonly events: NostrEvent[] = [];
  private readonly clients = new Set<Client>();
  private constructor(private readonly server: Server, readonly url: string) {}

  static async start(): Promise<LocalRelay> {
    const server = createServer((_request, response) => { response.writeHead(426).end('websocket only'); });
    let relay!: LocalRelay;
    server.on('upgrade', (request, socket: Socket) => {
      const key = request.headers['sec-websocket-key'];
      if (typeof key !== 'string') { socket.destroy(); return; }
      const accept = createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      relay.attach(socket);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    relay = new LocalRelay(server, `ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return relay;
  }

  private attach(socket: Socket) {
    const client: Client = { socket, subscriptions: new Map() };
    this.clients.add(client);
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = decodeFrames(Buffer.concat([pending, chunk]), (opcode, payload) => {
        if (opcode === 0x8) { socket.end(encodeFrame(0x8, Buffer.alloc(0))); return; }
        if (opcode === 0x9) { socket.write(encodeFrame(0xa, payload)); return; }
        if (opcode === 0x1) this.handle(client, payload.toString('utf8'));
      });
    });
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => this.clients.delete(client));
  }

  private send(client: Client, message: unknown[]) {
    if (!client.socket.destroyed) client.socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(message))));
  }

  private handle(client: Client, text: string) {
    let message: unknown;
    try { message = JSON.parse(text); } catch { return; }
    if (!Array.isArray(message)) return;
    if (message[0] === 'EVENT' && message[1] && typeof message[1] === 'object') {
      const event = message[1] as NostrEvent;
      if (!this.events.some(stored => stored.id === event.id)) {
        this.events.push(event);
        for (const other of this.clients) {
          for (const [subscription, filters] of other.subscriptions) {
            if (filters.some(filter => matches(event, filter))) this.send(other, ['EVENT', subscription, event]);
          }
        }
      }
      this.send(client, ['OK', event.id, true, '']);
    } else if (message[0] === 'REQ' && typeof message[1] === 'string') {
      const filters = message.slice(2) as Filter[];
      client.subscriptions.set(message[1], filters);
      for (const event of this.events) {
        if (filters.some(filter => matches(event, filter))) this.send(client, ['EVENT', message[1], event]);
      }
      this.send(client, ['EOSE', message[1]]);
    } else if (message[0] === 'CLOSE' && typeof message[1] === 'string') {
      client.subscriptions.delete(message[1]);
    }
  }

  async close() {
    for (const client of this.clients) client.socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
