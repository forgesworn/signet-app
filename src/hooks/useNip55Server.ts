/**
 * NIP-55 serving on the MySignet APK: requests from other apps on the
 * phone, decided by `planNip55`, signed by the same owner backends the
 * NIP-46 server uses, answered through the native plugin.
 *
 * One request is shown at a time; the rest wait their turn. A request that
 * arrives while the app is locked waits too, and `onNeedsUnlock` asks for
 * the PIN, so the approval screen only ever renders over an unlocked app.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UnsignedEvent } from 'signet-protocol';
import { describeEventTemplate } from '../lib/nip46-server';
import { isNativeApp, SignetNative, type Nip55Response } from '../lib/native';
import {
  describeNip55, loadNip55Grants, npubOf, parseNip55Request, planNip55, saveNip55Grants,
  type NativeNip55Request, type Nip55Grants, type Nip55Method, type ParsedNip55,
} from '../lib/nip55';
import type { BunkerRoute } from './useBunkerServer';

export interface PendingNip55 {
  handle: number;
  id: string;
  callerPackage: string;
  /** The app's name as the phone shows it; null when only the package is known. */
  callerLabel: string | null;
  method: Nip55Method;
  description: string;
  template?: UnsignedEvent;
  peer?: string;
  /** The key the request will be answered with unless the person picks another. */
  pubkey: string | null;
  permissions: string[];
  /** Whether this app has been seen before. */
  existing: boolean;
}

interface Options {
  enabled: boolean;
  /** Owner routes: the person's own keys, each with its backend. Empty while locked. */
  routes: BunkerRoute[];
  locked: boolean;
  activePubkey: string | null;
  onNeedsUnlock?: () => void;
  /** Called each time a phone app is about to be served (a key, a signature, a cipher), before the answer goes back. */
  onServed?: () => void;
  /** Test seam. */
  now?: () => number;
}

interface Waiting {
  handle: number;
  raw: NativeNip55Request;
  parsed: ParsedNip55;
  pubkey: string | null;
}

export function useNip55Server({ enabled, routes, locked, activePubkey, onNeedsUnlock, onServed, now = () => Date.now() }: Options) {
  const [queue, setQueue] = useState<Waiting[]>([]);
  const [grants, setGrants] = useState<Nip55Grants>(() => loadNip55Grants());
  const routesRef = useRef(routes);
  routesRef.current = routes;
  const grantsRef = useRef(grants);
  grantsRef.current = grants;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const activeRef = useRef(activePubkey);
  activeRef.current = activePubkey;
  const onNeedsUnlockRef = useRef(onNeedsUnlock);
  onNeedsUnlockRef.current = onNeedsUnlock;
  const nextHandle = useRef(1);
  const seen = useRef(new Set<string>());
  const onServedRef = useRef(onServed);
  onServedRef.current = onServed;

  const respond = useCallback(async (response: Nip55Response, cameByIntent = false) => {
    try { await SignetNative.nip55Respond(response); } catch { /* the shell is gone; nothing to answer */ }
    // An intent brought this app to the front over the caller; once the
    // answer is on its way, step back so the caller is what the person sees.
    if (cameByIntent) { try { await SignetNative.returnToPreviousApp(); } catch { /* not native, or nothing behind us */ } }
  }, []);

  /** Signs, encrypts or decrypts with the route that holds `pubkey`, and answers. */
  const execute = useCallback(async (raw: NativeNip55Request, parsed: ParsedNip55, pubkey: string) => {
    const byIntent = !raw.viaProvider;
    const route = routesRef.current.find(r => !r.dependantId && r.pubkey.toLowerCase() === pubkey);
    if (!route) { await respond({ id: raw.id, status: 'rejected' }, byIntent); return; }
    const backend = route.signingBackend ?? route.backend;
    onServedRef.current?.();
    try {
      switch (parsed.method) {
        case 'get_public_key':
          await respond({ id: raw.id, status: 'ok', result: npubOf(pubkey) }, byIntent);
          return;
        case 'sign_event': {
          const template = { ...parsed.template!, pubkey } as UnsignedEvent;
          const signed = await backend.signEvent(template);
          await respond({ id: raw.id, status: 'ok', result: signed.sig, event: JSON.stringify(signed) }, byIntent);
          return;
        }
        case 'nip44_encrypt':
          await respond({ id: raw.id, status: 'ok', result: await backend.nip44Encrypt(parsed.peer!, parsed.payload!) }, byIntent);
          return;
        case 'nip44_decrypt':
          await respond({ id: raw.id, status: 'ok', result: await backend.nip44Decrypt(parsed.peer!, parsed.payload!) }, byIntent);
          return;
      }
    } catch {
      await respond({ id: raw.id, status: 'rejected' }, byIntent);
    }
  }, [respond]);

  const handleRequest = useCallback(async (raw: NativeNip55Request) => {
    if (!raw || typeof raw.id !== 'string' || seen.current.has(raw.id)) return;
    seen.current.add(raw.id);
    const parsed = parseNip55Request(raw);
    const pkg = raw.callerPackage ?? '';
    const grant = pkg ? grantsRef.current[pkg] : undefined;
    const owned = lockedRef.current ? [] : routesRef.current.filter(r => !r.dependantId).map(r => r.pubkey);
    const plan = planNip55(parsed, raw.viaProvider, grant, owned, activeRef.current);
    // Locked and asked by intent: the plan says "no identity" only because
    // the keys are not decrypted yet. Hold the request and ask for the PIN.
    if (!raw.viaProvider && lockedRef.current && parsed && plan.kind === 'reject' && plan.reason === 'no-identity') {
      onNeedsUnlockRef.current?.();
      setQueue(q => [...q, { handle: nextHandle.current++, raw, parsed, pubkey: grant?.pubkey ?? null }]);
      return;
    }
    switch (plan.kind) {
      case 'reject': await respond({ id: raw.id, status: 'rejected' }, !raw.viaProvider); return;
      case 'defer': await respond({ id: raw.id, status: 'deferred' }); return;
      case 'forward': await execute(raw, parsed!, plan.pubkey); return;
      case 'ask': setQueue(q => [...q, { handle: nextHandle.current++, raw, parsed: parsed!, pubkey: plan.pubkey }]); return;
    }
  }, [execute, respond]);

  useEffect(() => {
    if (!enabled || !isNativeApp()) return;
    let cancelled = false;
    let handle: { remove(): Promise<void> } | null = null;
    void SignetNative.addListener('nip55Request', (request) => { void handleRequest(request); })
      .then(h => { if (cancelled) void h.remove(); else handle = h; });
    void SignetNative.nip55Pending().then(({ requests }) => { for (const r of requests ?? []) void handleRequest(r); }).catch(() => {});
    return () => { cancelled = true; void handle?.remove(); };
  }, [enabled, handleRequest]);

  // A request held through an unlock was never planned against the keys:
  // once they are there, one the person already allowed always is answered
  // without a screen, as it would have been had the app been open.
  useEffect(() => {
    if (locked || queue.length === 0) return;
    const owned = routes.filter(r => !r.dependantId).map(r => r.pubkey.toLowerCase());
    // The keys are decrypted a render after the unlock; until they are here
    // there is nothing to judge against, and "no key" would be a false refusal.
    if (owned.length === 0) return;
    const settled: number[] = [];
    for (const item of queue) {
      const grant = item.raw.callerPackage ? grants[item.raw.callerPackage] : undefined;
      const plan = planNip55(item.parsed, item.raw.viaProvider, grant, owned, activePubkey);
      if (plan.kind === 'forward') { settled.push(item.handle); void execute(item.raw, item.parsed, plan.pubkey); }
      else if (plan.kind === 'reject') { settled.push(item.handle); void respond({ id: item.raw.id, status: 'rejected' }, !item.raw.viaProvider); }
    }
    if (settled.length) setQueue(q => q.filter(w => !settled.includes(w.handle)));
  }, [locked, queue, routes, grants, activePubkey, execute, respond]);

  const remember = useCallback((pkg: string, grant: Nip55Grants[string]) => {
    setGrants(g => { const next = { ...g, [pkg]: grant }; saveNip55Grants(next); return next; });
  }, []);

  const take = useCallback((handle: number): Waiting | undefined => {
    const item = queue.find(w => w.handle === handle);
    if (item) setQueue(q => q.filter(w => w.handle !== handle));
    return item;
  }, [queue]);

  const approveOnce = useCallback((handle: number, pubkey?: string) => {
    const item = take(handle);
    if (!item) return;
    const key = (pubkey ?? item.pubkey)?.toLowerCase();
    if (!key) { void respond({ id: item.raw.id, status: 'rejected' }); return; }
    if (item.raw.callerPackage) {
      const prior = grantsRef.current[item.raw.callerPackage];
      remember(item.raw.callerPackage, { pubkey: key, allowAlways: prior?.allowAlways === true && prior.pubkey === key, denyAlways: false, grantedAt: now(), label: item.raw.callerLabel ?? prior?.label });
    }
    void execute(item.raw, item.parsed, key);
  }, [take, respond, remember, execute, now]);

  const approveAlways = useCallback((handle: number, pubkey?: string) => {
    const item = take(handle);
    if (!item) return;
    const key = (pubkey ?? item.pubkey)?.toLowerCase();
    if (!key) { void respond({ id: item.raw.id, status: 'rejected' }); return; }
    if (item.raw.callerPackage) remember(item.raw.callerPackage, { pubkey: key, allowAlways: true, denyAlways: false, grantedAt: now(), label: item.raw.callerLabel ?? grantsRef.current[item.raw.callerPackage]?.label });
    void execute(item.raw, item.parsed, key);
  }, [take, respond, remember, execute, now]);

  const deny = useCallback((handle: number) => {
    const item = take(handle);
    if (item) void respond({ id: item.raw.id, status: 'rejected' }, !item.raw.viaProvider);
  }, [take, respond]);

  const denyAlways = useCallback((handle: number) => {
    const item = take(handle);
    if (!item) return;
    if (item.raw.callerPackage) remember(item.raw.callerPackage, { pubkey: item.pubkey ?? activeRef.current ?? '0'.repeat(64), allowAlways: false, denyAlways: true, grantedAt: now(), label: item.raw.callerLabel ?? grantsRef.current[item.raw.callerPackage]?.label });
    void respond({ id: item.raw.id, status: 'rejected' }, !item.raw.viaProvider);
  }, [take, remember, respond, now]);

  const forget = useCallback((pkg: string) => {
    setGrants(g => { const next = { ...g }; delete next[pkg]; saveNip55Grants(next); return next; });
  }, []);

  const pending = useMemo<PendingNip55 | null>(() => {
    const item = queue[0];
    if (!item || locked) return null;
    const pkg = item.raw.callerPackage ?? '';
    return {
      handle: item.handle,
      id: item.raw.id,
      callerPackage: pkg || 'an app',
      callerLabel: item.raw.callerLabel ?? null,
      method: item.parsed.method,
      description: describeNip55(item.parsed, describeEventTemplate),
      template: item.parsed.template,
      peer: item.parsed.peer,
      // A request held through an unlock has no key yet; the active one is the default.
      pubkey: item.pubkey ?? activePubkey,
      permissions: item.parsed.permissions,
      existing: !!(pkg && grants[pkg]),
    };
  }, [queue, locked, grants, activePubkey]);

  return { pending, waiting: queue.length, grants, approveOnce, approveAlways, deny, denyAlways, forget };
}
