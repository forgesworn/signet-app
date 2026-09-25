import { useState, useEffect } from 'react';

/**
 * Resolve a Blob (via `load`) into an object URL with correct lifecycle:
 * revoke on cleanup, and guard the strict-mode double-invoke race (don't land
 * a revoked URL in state). Returns null while loading / when `load` is null /
 * on failure. `load` returning null means "no blob" → null.
 *
 * The single source of truth for the object-URL lifecycle previously duplicated
 * in useResolvedAvatar and useContactAvatar.
 */
export function useObjectUrl(
  load: (() => Promise<Blob | null>) | null,
  deps: unknown[],
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!load) { setUrl(null); return; }
    let cancelled = false;
    let created: string | null = null;
    void (async () => {
      try {
        const blob = await load();
        if (cancelled || !blob) { if (!cancelled) setUrl(null); return; }
        const obj = URL.createObjectURL(blob);
        if (cancelled) { URL.revokeObjectURL(obj); return; }
        created = obj;
        setUrl(obj);
      } catch {
        if (!cancelled) setUrl(null);
      }
    })();
    return () => { cancelled = true; if (created) URL.revokeObjectURL(created); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return url;
}
