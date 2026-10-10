import { useCallback, useEffect, useRef, useState } from 'react';
import { checkRelayHealth, type RelayHealth } from '../lib/relay-health';
import type { RelayConfig } from '../types';

export function useRelayHealth(relays: RelayConfig[]) {
  const [health, setHealth] = useState<Record<string, RelayHealth | 'checking'>>({});
  const active = useRef<AbortController | null>(null);
  const urls = JSON.stringify(relays.filter(relay => relay.enabled).map(relay => relay.url));
  const check = useCallback(() => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const enabled = JSON.parse(urls) as string[];
    setHealth(Object.fromEntries(enabled.map(url => [url, 'checking' as const])));
    for (const url of enabled) {
      void checkRelayHealth(url, { signal: controller.signal }).then(result => {
        if (!controller.signal.aborted) setHealth(previous => ({ ...previous, [url]: result }));
      });
    }
  }, [urls]);
  useEffect(() => {
    check();
    return () => active.current?.abort();
  }, [check]);
  return { health, check };
}
