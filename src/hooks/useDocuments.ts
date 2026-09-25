import { useState, useEffect, useCallback } from 'react';
import type { IdentityDocument } from '../types';
import * as db from '../lib/db';

export function useDocuments(ownerPubkey?: string, encryptionKey?: string | null) {
  const [documents, setDocuments] = useState<IdentityDocument[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    if (!ownerPubkey) { setDocuments([]); setLoading(false); return; }
    const docs = await db.getDocumentsByOwner(ownerPubkey, encryptionKey ?? undefined);
    setDocuments(docs);
    setLoading(false);
  }, [ownerPubkey, encryptionKey]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const addDocument = useCallback(async (doc: IdentityDocument) => {
    // M2: saveDocument now throws without a key rather than silently
    // persisting PII in cleartext — bail out instead of letting the
    // throw surface mid-flow.
    if (!encryptionKey) return;
    await db.saveDocument(doc, encryptionKey);
    await loadAll();
  }, [loadAll, encryptionKey]);

  const removeDocument = useCallback(async (id: string) => {
    await db.deleteDocument(id);
    await loadAll();
  }, [loadAll]);

  return { documents, loading, addDocument, removeDocument, refresh: loadAll };
}
