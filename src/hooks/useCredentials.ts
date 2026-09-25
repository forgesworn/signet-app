import { useState, useEffect, useCallback } from 'react';
import type { StoredCredential } from '../types';
import * as db from '../lib/db';
import { computeLapseStatus } from '../lib/professional/cold-start';

/**
 * Scan credentials and transition any pending self-cert credentials that
 * have exceeded the 30-day lapse window to 'expired-pending'.
 * Returns a new array; does not mutate inputs.
 * Called at unlock and on each credential list render. Spec §6.10.6.
 */
export function sweepLapsedCredentials(
  credentials: StoredCredential[],
  nowMs: number = Date.now(),
): StoredCredential[] {
  return credentials.map((cred) => {
    if (cred.verifierStatus !== 'pending') return cred;
    if (cred.pendingIssuedAt === undefined) return cred;
    const status = computeLapseStatus(cred.pendingIssuedAt, nowMs);
    if (status === 'expired-pending') {
      return { ...cred, verifierStatus: 'expired-pending' };
    }
    return cred;
  });
}

export function useCredentials(encryptionKey?: string | null) {
  const [credentials, setCredentials] = useState<StoredCredential[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    if (!encryptionKey) {
      setCredentials([]);
      setLoading(false);
      return;
    }
    const raw = await db.getAllCredentials(encryptionKey);
    // Sweep lapsed self-cert credentials and persist any state transitions.
    const swept = sweepLapsedCredentials(raw, Date.now());
    const lapsed = swept.filter((c, i) => c.verifierStatus !== raw[i].verifierStatus);
    await Promise.all(lapsed.map(c => db.updateCredential(c, encryptionKey)));
    setCredentials(swept);
    setLoading(false);
  }, [encryptionKey]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const addCredential = useCallback(async (cred: StoredCredential) => {
    // M2: saveCredential now throws without a key rather than silently
    // persisting the credential body in cleartext — guard here, matching
    // loadAll's bail-out, instead of letting the throw surface mid-flow.
    if (!encryptionKey) return;
    await db.saveCredential(cred, encryptionKey);
    await loadAll();
  }, [loadAll, encryptionKey]);

  return { credentials, loading, addCredential, refresh: loadAll };
}
