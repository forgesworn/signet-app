import type { Page, WebSocketRoute } from '@playwright/test';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';

/** Disposable NIP-46 signer with real encrypted requests and signed responses. */
export class TestBunker {
  private readonly key = new Uint8Array(32).fill(43);
  readonly pubkey = getPublicKey(this.key);
  readonly uri = `bunker://${this.pubkey}?relay=${encodeURIComponent('wss://relay.example.com')}&secret=test-only`;
  readonly methods: string[] = [];
  private online = true;
  private readonly sockets = new Map<WebSocketRoute, Map<string, Record<string, unknown>[]>>();

  setOnline(online: boolean) {
    this.online = online;
    if (!online) {
      for (const socket of this.sockets.keys()) socket.close();
      this.sockets.clear();
    }
  }

  async route(page: Page) {
    await page.routeWebSocket(/^wss:\/\//, socket => {
      if (!this.online) { socket.close(); return; }
      const subscriptions = new Map<string, Record<string, unknown>[]>();
      this.sockets.set(socket, subscriptions);
      socket.onClose(() => this.sockets.delete(socket));
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message[0] === 'REQ') {
          subscriptions.set(message[1], message.slice(2));
          socket.send(JSON.stringify(['EOSE', message[1]]));
        } else if (message[0] === 'CLOSE') subscriptions.delete(message[1]);
        else if (message[0] === 'EVENT') {
          const event = message[1];
          if (!verifyEvent(event)) return;
          socket.send(JSON.stringify(['OK', event.id, true, '']));
          if (event.kind !== 24133 || !event.tags.some((tag: string[]) => tag[0] === 'p' && tag[1] === this.pubkey)) return;
          const conversation = getConversationKey(this.key, event.pubkey);
          const request = JSON.parse(decrypt(event.content, conversation));
          this.methods.push(request.method);
          let result: string | undefined;
          let error: string | undefined;
          switch (request.method) {
            case 'connect': result = 'ack'; break;
            case 'ping': result = 'pong'; break;
            case 'get_public_key': result = this.pubkey; break;
            case 'sign_event': result = JSON.stringify(finalizeEvent(JSON.parse(request.params[0]), this.key)); break;
            case 'nip44_encrypt': result = encrypt(request.params[1], getConversationKey(this.key, request.params[0])); break;
            case 'nip44_decrypt': result = decrypt(request.params[1], getConversationKey(this.key, request.params[0])); break;
            default: error = 'Unsupported method';
          }
          const response = finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000),
            tags: [['p', event.pubkey]], content: encrypt(JSON.stringify({ id: request.id, result, error }), conversation) }, this.key);
          for (const [peer, filtersById] of this.sockets) {
            for (const [id, filters] of filtersById) {
              // limit:0 suppresses history, never live subscription events.
              if (filters.some(filter => (!Array.isArray(filter.kinds) || filter.kinds.includes(24133))
                && (!Array.isArray(filter.authors) || filter.authors.includes(this.pubkey))
                && (!Array.isArray(filter['#p']) || filter['#p'].includes(event.pubkey)))) {
                peer.send(JSON.stringify(['EVENT', id, response]));
              }
            }
          }
        }
      });
    });
  }
}
