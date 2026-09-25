import { useEffect, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { isNativeApp } from '../lib/native';
import {
  appUpdateState,
  fetchUpdateManifest,
  parseInstalledVersion,
  type AppUpdateState,
  type InstalledVersion,
} from '../lib/app-update';

/**
 * "Am I on the latest APK?" — native only. On the web returns `not-native`
 * synchronously and never touches the network (the service worker owns web
 * updates; see useSwUpdate). Called from `UpdateStatusLine`, which itself is
 * only mounted while a Settings About block is on screen — so the check
 * runs once per mount of that block, and opening Settings is the refresh.
 */
export function useAppUpdate(): AppUpdateState {
  const native = isNativeApp();
  const [state, setState] = useState<AppUpdateState>(native ? { kind: 'checking' } : { kind: 'not-native' });

  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    const timeoutMs = 5000;
    let installedSoFar: InstalledVersion | null = null;
    const timer = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      setState(appUpdateState(true, installedSoFar, null));
    }, timeoutMs);
    (async () => {
      let installed: InstalledVersion | null = null;
      try {
        installed = parseInstalledVersion(await CapacitorApp.getInfo());
      } catch {
        installed = null;
      }
      installedSoFar = installed;
      // Don't even fetch if we can't say what we are — the answer would be
      // 'unreadable' regardless, and the request is wasted bytes.
      const latest = installed ? await fetchUpdateManifest() : null;
      if (!cancelled) {
        cancelled = true;
        clearTimeout(timer);
        setState(appUpdateState(true, installed, latest));
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [native]);

  return state;
}
