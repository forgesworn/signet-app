import { useEffect, useRef, useState } from 'react';
import { vaultPurpose } from 'signet-protocol/experimental';
import type { VaultDataset } from 'signet-protocol/experimental';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import { syncPrivateVaultDataset } from '../lib/private-vault-sync';
import type { PrivateVaultDatasetAdapter, PrivateVaultSyncResult } from '../lib/private-vault-sync';

export interface PrivateVaultHealth {
  phase: 'checking' | 'unsupported' | 'running' | 'idle';
  datasets: Record<string, PrivateVaultSyncResult>;
}
export interface PrivateVaultJob { adapter: PrivateVaultDatasetAdapter; resolve(rotation: number): Promise<DecryptingSigningBackend> }

/** One cycle at a time; mutations coalesce, offline failures retry without new edits. */
export function usePrivateVaults(options: {
  sessionKey: string | null;
  ownerPubkey: string | null;
  encryptionKey: string | null;
  supported: boolean;
  ready: boolean;
  migrationReady?: boolean;
  changeToken: string;
  relays: { read: string[]; write: string[] };
  jobs(isCurrent: () => boolean): Promise<PrivateVaultJob[]>;
  onMerged(): void;
  onHealth?(health: PrivateVaultHealth): void;
}) {
  const [health, setHealth] = useState<PrivateVaultHealth>({ phase: 'checking', datasets: {} });
  const opts = useRef(options); opts.current = options;
  const kick = useRef<(() => void) | null>(null);
  const session = `${options.sessionKey ?? ''}:${options.encryptionKey ?? ''}`;
  const currentSession = useRef(session); currentSession.current = session;
  const relayKey = JSON.stringify(options.relays);

  useEffect(() => {
    const initial: PrivateVaultHealth = { phase: options.supported ? 'checking' : 'unsupported', datasets: {} };
    setHealth(initial); opts.current.onHealth?.(initial);
    if (!options.sessionKey || !options.encryptionKey || !options.ownerPubkey || !options.supported || !options.ready) return;
    let cancelled = false, running = false, dirty = false, failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest = initial;
    const valid = () => !cancelled && currentSession.current === session;
    const emit = (next: PrivateVaultHealth) => {
      if (!valid()) return;
      latest = next; setHealth(next); opts.current.onHealth?.(next);
    };
    const schedule = (delay: number) => {
      if (!valid()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void run(); }, delay);
    };
    const run = async () => {
      if (!valid()) return;
      if (running) { dirty = true; return; }
      running = true; dirty = false;
      emit({ ...latest, phase: 'running' });
      try {
        let merged = false;
        const jobs = await opts.current.jobs(valid);
        for (const job of jobs) {
          if (!valid()) return;
          const result = await syncPrivateVaultDataset({ adapter: job.adapter, resolve: job.resolve,
            ownerPubkey: options.ownerPubkey!, encryptionKey: options.encryptionKey!,
            relays: opts.current.relays, allowInitialPublish: opts.current.migrationReady, isCurrent: valid, now: Math.floor(Date.now() / 1000) });
          if (!valid()) return;
          merged ||= !!result.merged;
          const purpose = vaultPurpose(job.adapter.dataset);
          // Once canonical, an offline retry must never re-enable legacy writes.
          const canonical = result.canonical || latest.datasets[purpose]?.canonical;
          emit({ phase: 'running', datasets: { ...latest.datasets, [purpose]: { ...result, canonical } } });
        }
        if (valid() && merged) opts.current.onMerged();
        failures = Object.values(latest.datasets).some(d => d.state !== 'verified') ? failures + 1 : 0;
      } catch { failures++; }
      finally {
        running = false;
        emit({ ...latest, phase: 'idle' });
        schedule(dirty ? 1000 : Math.min(300000, 30000 * 2 ** Math.min(failures, 4)));
      }
    };
    kick.current = () => { if (running) dirty = true; else schedule(1000); };
    const online = () => kick.current?.();
    window.addEventListener('online', online);
    void run();
    return () => {
      cancelled = true; kick.current = null;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', online);
    };
  }, [session, options.supported, options.ready, relayKey, options.ownerPubkey]);

  const lastChangeToken = useRef(options.changeToken);
  useEffect(() => {
    if (lastChangeToken.current === options.changeToken) return;
    lastChangeToken.current = options.changeToken;
    kick.current?.();
  }, [options.changeToken]);
  return health;
}

export function legacyVaultWriteAllowed(health: PrivateVaultHealth, dataset: VaultDataset): boolean {
  if (health.phase === 'checking' || health.phase === 'unsupported') return false;
  const status = health.datasets[vaultPurpose(dataset)];
  return !!status && !status.canonical && status.state !== 'unusable' && status.state !== 'unavailable' && status.state !== 'waiting-legacy';
}
