/**
 * Runs the legacy `contacts` / `ken` → contacts v2 import once per unlock.
 *
 * It re-runs deliberately: the existing Contacts UI keeps writing to the
 * legacy stores until Phase C switches over, so each unlock picks up whatever
 * appeared since. The marker store makes an unchanged run a no-op, and every
 * imported id is deterministic, so a repeat is an idempotent `put` rather than
 * a duplicate contact.
 *
 * A failure is recorded in `status` and never thrown: a legacy row that will
 * not lift must not stop the app from unlocking.
 */

import { useEffect, useState } from 'react';
import * as db from '../lib/db';
import {
  runContactsV2Import,
  type ImportDependantRef,
  type ImportRunResult,
} from '../lib/contacts-v2-import';

export interface UseContactsV2ImportOptions {
  enabled: boolean;
  encryptionKey: string | null;
  deviceId: string | null;
  actorPubkey: string | null;
  ownerPubkeys: string[];
  dependants: ImportDependantRef[];
}

export function useContactsV2Import(opts: UseContactsV2ImportOptions): {
  status: 'idle' | 'running' | 'done' | 'error';
  result: ImportRunResult | null;
} {
  const { enabled, encryptionKey, deviceId, actorPubkey, ownerPubkeys, dependants } = opts;
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<ImportRunResult | null>(null);
  // Compare input values, not array identities: a hydration reload must not
  // cancel an in-flight import and leave its status stuck at "running".
  const ownersKey = JSON.stringify(ownerPubkeys);
  const dependantsKey = JSON.stringify(dependants);

  useEffect(() => {
    if (!enabled || !encryptionKey || !deviceId || !actorPubkey) {
      setStatus('idle'); setResult(null); return;
    }

    let cancelled = false;
    setStatus('running');
    void (async () => {
      try {
        const [contacts, kens] = await Promise.all([db.getAllContacts(encryptionKey), db.getAllKens()]);
        const runResult = await runContactsV2Import(
          { contacts, kens, ownerPubkeys, dependants, deviceId, actorPubkey, now: Date.now() },
          {
            listExistingOps: () => db.listAllContactOperationsV2(encryptionKey),
            listImportedSources: () => db.listContactImportSources(),
            // I3: one PBKDF2 derivation for the whole import batch instead of
            // one per operation.
            saveOps: (ops) => db.saveContactOperationsV2(ops, encryptionKey),
            markSources: (sourceKeys, importedAt) => db.markContactImportSources(sourceKeys, importedAt),
          },
        );
        if (cancelled) return;
        setResult(runResult);
        setStatus('done');
      } catch {
        if (cancelled) return;
        setStatus('error');
      }
    })();

    return () => { cancelled = true; };
  // Arrays are represented by their value keys above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, encryptionKey, deviceId, actorPubkey, ownersKey, dependantsKey]);

  return { status, result };
}
