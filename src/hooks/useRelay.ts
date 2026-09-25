import { useState, useEffect, useCallback } from 'react';
import type { RelayState, NostrEvent, NostrFilter } from 'signet-protocol';
import {
  connectRelay,
  disconnectRelay,
  getRelayState,
  addStateListener,
  publishEvent,
  fetchEvents,
  setRelayUrl,
  getRelayUrl,
} from '../lib/relay-service';

export function useRelay() {
  const [state, setState] = useState<RelayState>(getRelayState());
  const [url, setUrl] = useState(getRelayUrl());

  useEffect(() => {
    // M8: fan-out listener, not a direct single-slot registration — see
    // relay-service.ts addStateListener.
    const unsubscribe = addStateListener((newState) => setState(newState));
    setState(getRelayState());
    return unsubscribe;
  }, [url]);

  const connect = useCallback(async () => {
    await connectRelay();
    setState(getRelayState());
  }, []);

  const disconnect = useCallback(() => {
    disconnectRelay();
    setState('disconnected');
  }, []);

  const publish = useCallback(async (event: NostrEvent) => {
    return publishEvent(event);
  }, []);

  const fetch = useCallback(async (filters: NostrFilter[]) => {
    return fetchEvents(filters);
  }, []);

  const changeUrl = useCallback((newUrl: string) => {
    setRelayUrl(newUrl);
    setUrl(newUrl);
  }, []);

  return { state, url, connect, disconnect, publish, fetch, changeUrl };
}
