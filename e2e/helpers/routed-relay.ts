import type { Page, WebSocketRoute } from '@playwright/test';

interface StoredEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

export function hasFilterValue(filter: Record<string, unknown>, key: string, value: string | number): boolean {
  const values = filter[key];
  return Array.isArray(values) && values.includes(value);
}

export class RoutedRelay {
  constructor(private readonly relayUrl: string | RegExp = 'wss://relay.example.com') {}
  readonly storedEvents: StoredEvent[] = [];
  private readonly sockets = new Set<WebSocketRoute>();
  private readonly subscriptions = new Map<WebSocketRoute, Map<string, Record<string, unknown>[]>>();
  private readonly waiters: Array<{
    predicate: (filter: Record<string, unknown>) => boolean;
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  async route(page: Page): Promise<void> {
    await page.routeWebSocket(this.relayUrl, ws => this.connect(ws));
  }

  waitForSubscription(
    predicate: (filter: Record<string, unknown>) => boolean,
    timeoutMs = 5_000,
  ): Promise<void> {
    for (const filtersBySub of this.subscriptions.values()) {
      for (const filters of filtersBySub.values()) {
        if (filters.some(predicate)) return Promise.resolve();
      }
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: () => {
          clearTimeout(waiter.timer);
          this.removeWaiter(waiter);
          resolve();
        },
        reject: (err: Error) => {
          this.removeWaiter(waiter);
          reject(err);
        },
        timer: setTimeout(() => waiter.reject(new Error('subscription-timeout')), timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close(): void {
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('relay-closed'));
    }
    this.waiters.length = 0;
    this.sockets.clear();
    this.subscriptions.clear();
  }

  private connect(ws: WebSocketRoute): void {
    this.sockets.add(ws);
    this.subscriptions.set(ws, new Map());
    ws.onMessage(raw => this.handleMessage(ws, String(raw)));
    ws.onClose(() => {
      this.sockets.delete(ws);
      this.subscriptions.delete(ws);
    });
  }

  private handleMessage(sender: WebSocketRoute, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || typeof msg[0] !== 'string') return;

    if (msg[0] === 'EVENT') {
      this.handleEvent(sender, msg[1] as StoredEvent);
    } else if (msg[0] === 'REQ') {
      this.handleReq(sender, String(msg[1]), msg.slice(2) as Record<string, unknown>[]);
    } else if (msg[0] === 'CLOSE') {
      this.subscriptions.get(sender)?.delete(String(msg[1]));
    }
  }

  private handleEvent(sender: WebSocketRoute, event: StoredEvent): void {
    this.storedEvents.push(event);
    sender.send(JSON.stringify(['OK', event.id, true, '']));

    for (const ws of this.sockets) {
      if (ws === sender) continue;
      const filtersBySub = this.subscriptions.get(ws);
      if (!filtersBySub) continue;
      for (const [subId, filters] of filtersBySub) {
        if (filters.some(filter => filter.limit !== 0 && this.matchesFilter(event, filter))) {
          ws.send(JSON.stringify(['EVENT', subId, event]));
        }
      }
    }
  }

  private handleReq(ws: WebSocketRoute, subId: string, filters: Record<string, unknown>[]): void {
    const normalized = filters.length > 0 ? filters : [{}];
    this.subscriptions.get(ws)?.set(subId, normalized);
    for (const filter of normalized) this.notifyWaiters(filter);

    if (normalized.every(filter => filter.limit === 0)) {
      ws.send(JSON.stringify(['EOSE', subId]));
      return;
    }

    for (const event of this.storedEvents) {
      if (normalized.some(filter => filter.limit !== 0 && this.matchesFilter(event, filter))) {
        ws.send(JSON.stringify(['EVENT', subId, event]));
      }
    }
    ws.send(JSON.stringify(['EOSE', subId]));
  }

  private matchesFilter(event: StoredEvent, filter: Record<string, unknown>): boolean {
    if (Array.isArray(filter.ids) && !filter.ids.includes(event.id)) return false;
    if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false;
    if (Array.isArray(filter.authors) && !filter.authors.includes(event.pubkey)) return false;
    if (typeof filter.since === 'number' && event.created_at < filter.since) return false;
    if (typeof filter.until === 'number' && event.created_at > filter.until) return false;

    for (const [key, value] of Object.entries(filter)) {
      if (!key.startsWith('#') || !Array.isArray(value)) continue;
      const tagName = key.slice(1);
      const eventTagValues = event.tags.filter(tag => tag[0] === tagName).map(tag => tag[1]);
      if (!value.some(v => eventTagValues.includes(String(v)))) return false;
    }
    return true;
  }

  private notifyWaiters(filter: Record<string, unknown>): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(filter)) waiter.resolve();
    }
  }

  private removeWaiter(waiter: RoutedRelay['waiters'][number]): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }
}

