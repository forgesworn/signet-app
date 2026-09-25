import type { BrowserContext, WebSocketRoute } from '@playwright/test';
type Event = { id: string; pubkey: string; kind: number; tags: string[][]; created_at: number; content: string };
type Filter = Record<string, unknown>;
const matches = (event: Event, filter: Filter) => Object.entries(filter).every(([key, value]) => {
  if (key === 'ids') return (value as string[]).includes(event.id);
  if (key === 'authors') return (value as string[]).includes(event.pubkey);
  if (key === 'kinds') return (value as number[]).includes(event.kind);
  if (key === 'since') return event.created_at >= Number(value);
  if (key === 'until') return event.created_at <= Number(value);
  if (key.startsWith('#')) return event.tags.some(t => t[0] === key.slice(1) && (value as string[]).includes(t[1]));
  return true;
});
/** One private in-memory network shared by browser contexts, including live subscriptions. */
export function privateRelays() {
  const events = new Map<string, Event>();
  const clients = new Map<WebSocketRoute, Map<string, Filter[]>>();
  const publish = (event: Event) => {
          if (event.kind >= 30000 && event.kind < 40000) {
            const d = event.tags.find(t => t[0] === 'd')?.[1];
            for (const [id, old] of events) if (old.pubkey === event.pubkey && old.kind === event.kind
              && old.tags.find(t => t[0] === 'd')?.[1] === d && old.created_at <= event.created_at) events.delete(id);
          }
          const fresh = !events.has(event.id); events.set(event.id, event);
          if (fresh) for (const [client, subs] of clients) for (const [id, filters] of subs)
            if (filters.some(filter => matches(event, filter))) client.send(JSON.stringify(['EVENT', id, event]));
  };
  return { events, publish, async install(context: BrowserContext) {
    await context.routeWebSocket('**', socket => {
      if (new URL(socket.url()).port === '5174') { socket.connectToServer(); return; }
      const subscriptions = new Map<string, Filter[]>(); clients.set(socket, subscriptions);
      socket.onClose((code, reason) => { clients.delete(socket); socket.close({ code, reason }); });
      socket.onMessage(raw => {
        let message: unknown[];
        try { message = JSON.parse(String(raw)); } catch { return; }
        if (message[0] === 'CLOSE') subscriptions.delete(String(message[1]));
        if (message[0] === 'EVENT') {
          const event = message[1] as Event;
          socket.send(JSON.stringify(['OK', event.id, true, '']));
          publish(event);
        }
        if (message[0] === 'REQ') {
          const id = String(message[1]), filters = message.slice(2) as Filter[];
          subscriptions.set(id, filters);
          const found = new Map<string, Event>();
          for (const filter of filters) for (const event of [...events.values()].filter(e => matches(e, filter))
            .sort((a, b) => b.created_at - a.created_at).slice(0, Number(filter.limit ?? 1000))) found.set(event.id, event);
          for (const event of found.values()) socket.send(JSON.stringify(['EVENT', id, event]));
          socket.send(JSON.stringify(['EOSE', id]));
        }
      });
    });
  } };
}
