/**
 * A direct child's card says the Heartwood is fine once its connection is up,
 * and the connection never reports going down again: on a device run
 * (2026-11-17, finding F13) the Heartwood lost power mid-session and the card
 * went on saying everything was fine. So while the app is open, unlocked and
 * showing, this pings the Heartwood once a minute (the device answers a ping
 * with no button press). A ping that fails counts as a miss; after
 * `CHILD_HEARTBEAT_MISSES` misses in a row the Heartwood counts as lost, and
 * one answer clears it. Only one ping is ever in flight. Hiding the app, a
 * lock, or a new connection stops it and starts again from a clean slate, and
 * the answer to a ping sent before that is ignored.
 */
import { useEffect, useState } from 'react';

export const CHILD_HEARTBEAT_MS = 60_000;
export const CHILD_HEARTBEAT_TIMEOUT_MS = 20_000;
export const CHILD_HEARTBEAT_MISSES = 2;

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

/** True while the Heartwood has missed `misses` pings in a row. */
export function useChildHeartwoodHeartbeat(opts: {
  enabled: boolean;
  ping: (() => Promise<unknown>) | null;
  intervalMs?: number;
  misses?: number;
}): boolean {
  const { enabled, ping } = opts;
  const intervalMs = opts.intervalMs ?? CHILD_HEARTBEAT_MS;
  const missLimit = opts.misses ?? CHILD_HEARTBEAT_MISSES;
  const [visible, setVisible] = useState(isVisible);
  const [lost, setLost] = useState(false);

  useEffect(() => {
    const onChange = () => setVisible(isVisible());
    document.addEventListener('visibilitychange', onChange);
    onChange();
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  const active = enabled && !!ping && visible;

  useEffect(() => {
    setLost(false);
    if (!active || !ping) return;
    let live = true;
    let pending = false;
    let misses = 0;
    const tick = () => {
      if (pending) return;
      pending = true;
      let attempt: Promise<unknown>;
      try {
        attempt = Promise.resolve(ping());
      } catch (e) {
        attempt = Promise.reject(e);
      }
      attempt.then(
        () => {
          pending = false;
          if (!live) return;
          misses = 0;
          setLost(false);
        },
        () => {
          pending = false;
          if (!live) return;
          misses += 1;
          if (misses >= missLimit) setLost(true);
        },
      );
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, ping, intervalMs, missLimit]);

  return active && lost;
}
