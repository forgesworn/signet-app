import { useCallback, useState } from 'react';
import { isValidRelayUrl } from '../lib/relay-url';

/**
 * Hook for publishing credential events to a relay.
 * Opt-in only — called explicitly after verification.
 */
export function usePublishCredential(relayUrl?: string) {
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publish = useCallback(async (eventJson: string) => {
    if (!relayUrl) {
      setError('No relay configured. Go to Settings → Power Mode to add one.');
      return false;
    }
    setPublishing(true);
    setError(null);
    try {
      // Single source of truth for the relay-URL invariant (security audit
      // 2026-06-15) — wss:// for production, ws:// only for localhost/127.0.0.1.
      if (!isValidRelayUrl(relayUrl)) {
        throw new Error('Relay URL must be wss:// (ws:// only for localhost)');
      }
      let parsedEvent: Record<string, unknown>;
      try {
        const raw: unknown = JSON.parse(eventJson);
        if (typeof raw !== 'object' || raw === null) throw new Error('Invalid event JSON');
        parsedEvent = raw as Record<string, unknown>;
      } catch {
        throw new Error('Invalid event JSON');
      }
      const eventId = typeof parsedEvent.id === 'string' ? parsedEvent.id : null;

      const ws = new WebSocket(relayUrl);
      try {
        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => {
            ws.send(JSON.stringify(['EVENT', parsedEvent]));
            // Wait briefly for OK response
            ws.onmessage = (msg) => {
              try {
                const data: unknown = JSON.parse(msg.data as string);
                if (Array.isArray(data) && data[0] === 'OK' && (eventId === null || data[1] === eventId)) {
                  resolve();
                }
              } catch {
                // Malformed relay message — keep waiting for timeout
              }
            };
            // Timeout after 5 seconds
            setTimeout(() => resolve(), 5000);
          };
          ws.onerror = () => reject(new Error('Failed to connect to relay'));
          setTimeout(() => reject(new Error('Connection timeout')), 10000);
        });
      } finally {
        // Close on every path — success, onerror rejection, and the 10s
        // timeout rejection all used to leave the socket open.
        ws.close();
      }
      setPublished(true);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to publish');
      return false;
    } finally {
      setPublishing(false);
    }
  }, [relayUrl]);

  return { publish, publishing, published, error };
}
