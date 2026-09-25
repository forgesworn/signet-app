import { useEffect, useState } from 'react';

/** A failed initial read must not require another edit or an app restart. */
export function useSyncReadRetry(unreachable: boolean): number {
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!unreachable) return;
    const retry = () => setAttempt(value => value + 1);
    const timer = setTimeout(retry, 30000);
    window.addEventListener('online', retry);
    return () => { clearTimeout(timer); window.removeEventListener('online', retry); };
  }, [unreachable, attempt]);
  return attempt;
}
