/**
 * Operator keys for Heartwoods other than the one this phone is paired with
 * (a second device holding some personas: a business Heartwood, one for a
 * relative). Used only to hand app pairings to the device that holds the
 * persona (`lib/heartwood-handoff.ts`); the family policy push stays on the
 * primary key (`useHeartwoodOperator`). Loaded on unlock, stopped and
 * zeroized on lock, like the primary.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { readExtraHeartwoodOperators, updateExtraHeartwoodOperators } from '../lib/db';
import type { HeartwoodOperatorCredential } from '../lib/heartwood-operator';
import { HeartwoodMgmtClient } from '../lib/heartwood-mgmt';
import { resolveImportInput, resolvePhraseInput } from '../lib/heartwood-operator-import';
import type { OperatorImportOutcome } from './useHeartwoodOperator';

export interface UseExtraHeartwoodOperatorsReturn {
  credentials: HeartwoodOperatorCredential[];
  clients: HeartwoodMgmtClient[];
  importLink: (text: string, pin?: string) => Promise<OperatorImportOutcome>;
  importPhrase: (words: string, deviceInput: string, relaysText: string) => Promise<OperatorImportOutcome>;
  forget: (deviceHex: string) => Promise<void>;
}

export function useExtraHeartwoodOperators({ encryptionKey, enabled, primaryDeviceHex }: {
  encryptionKey: string | null;
  enabled: boolean;
  /** The primary operator's device; importing it here is refused (it has its own card). */
  primaryDeviceHex?: string | null;
}): UseExtraHeartwoodOperatorsReturn {
  const [credentials, setCredentialsState] = useState<HeartwoodOperatorCredential[]>([]);
  const credentialsRef = useRef<HeartwoodOperatorCredential[]>([]);
  const setCredentials = useCallback((next: HeartwoodOperatorCredential[]) => {
    credentialsRef.current = next;
    setCredentialsState(next);
  }, []);
  const [clients, setClients] = useState<HeartwoodMgmtClient[]>([]);
  const clientsRef = useRef<HeartwoodMgmtClient[]>([]);
  const genRef = useRef(0);

  const stopAll = useCallback(() => {
    for (const c of clientsRef.current) { try { c.stop(); } catch { /* already stopped */ } }
    clientsRef.current = [];
    setClients([]);
  }, []);

  const activate = useCallback((creds: HeartwoodOperatorCredential[]) => {
    stopAll();
    const started: HeartwoodMgmtClient[] = [];
    for (const cred of creds) {
      try {
        const c = new HeartwoodMgmtClient({ skHex: cred.skHex, deviceHex: cred.deviceHex, relays: cred.relays });
        c.start();
        started.push(c);
      } catch { /* a bad row is skipped, never the rest */ }
    }
    clientsRef.current = started;
    setClients(started);
  }, [stopAll]);

  useEffect(() => {
    const gen = ++genRef.current;
    if (!enabled || !encryptionKey) { stopAll(); setCredentials([]); return; }
    let cancelled = false;
    // In turn with add/forget, so this never lands over a newer import.
    readExtraHeartwoodOperators(encryptionKey).then(creds => {
      if (cancelled || genRef.current !== gen) return;
      setCredentials(creds);
      activate(creds);
    }).catch(() => { /* nothing stored */ });
    return () => { cancelled = true; };
  }, [enabled, encryptionKey, activate, stopAll, setCredentials]);

  useEffect(() => () => stopAll(), [stopAll]);

  const add = useCallback(async (cred: HeartwoodOperatorCredential): Promise<OperatorImportOutcome> => {
    if (!enabled || !encryptionKey) return { error: 'Unlock first.' };
    const device = cred.deviceHex.toLowerCase();
    if (primaryDeviceHex && device === primaryDeviceHex.toLowerCase()) {
      return { error: 'That is the Heartwood this phone is already paired with. Its key goes in the card above.' };
    }
    const gen = genRef.current;
    let next: HeartwoodOperatorCredential[];
    try {
      // Against what is stored: the in-memory list is empty until the unlock load lands.
      next = await updateExtraHeartwoodOperators(encryptionKey, stored => [...stored.filter(c => c.deviceHex.toLowerCase() !== device), cred]);
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Could not save the operator key.' };
    }
    // Locked (or the session changed) while saving: the key is stored and loads
    // on the next unlock; starting clients now would outlive the lock.
    if (genRef.current !== gen) return { imported: true };
    setCredentials(next);
    activate(next);
    return { imported: true };
  }, [enabled, encryptionKey, primaryDeviceHex, activate, setCredentials]);

  const importLink = useCallback(async (text: string, pin?: string): Promise<OperatorImportOutcome> => {
    const r = resolveImportInput(text, pin);
    if (r.kind === 'needs-pin') return { needsPin: true };
    if (r.kind === 'error') return { error: r.message };
    return add(r.cred);
  }, [add]);

  const importPhrase = useCallback(async (words: string, deviceInput: string, relaysText: string): Promise<OperatorImportOutcome> => {
    const r = resolvePhraseInput(words, deviceInput, relaysText);
    if (r.kind === 'error') return { error: r.message };
    return add(r.cred);
  }, [add]);

  const forget = useCallback(async (deviceHex: string) => {
    if (!encryptionKey) return;
    const device = deviceHex.toLowerCase();
    const others = (list: HeartwoodOperatorCredential[]) => list.filter(c => c.deviceHex.toLowerCase() !== device);
    const gen = genRef.current;
    let next: HeartwoodOperatorCredential[];
    try {
      next = await updateExtraHeartwoodOperators(encryptionKey, others);
    } catch {
      next = others(credentialsRef.current); // dropped from this session regardless
    }
    if (genRef.current !== gen) return;
    setCredentials(next);
    activate(next);
  }, [encryptionKey, activate, setCredentials]);

  return { credentials, clients, importLink, importPhrase, forget };
}
