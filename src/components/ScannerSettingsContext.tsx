import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_SCANNER_AUTO_START, DEFAULT_SCANNER_IDLE_SECONDS } from '../lib/scanner-settings';

export interface ScannerSettings {
  /** Camera switches off after this long with nothing found and no touch. */
  idleMs: number;
  /** Swiping to the carousel scan card starts the camera by itself. */
  autoStart: boolean;
}

export const DEFAULT_SCANNER_SETTINGS: ScannerSettings = {
  idleMs: DEFAULT_SCANNER_IDLE_SECONDS * 1000,
  autoStart: DEFAULT_SCANNER_AUTO_START,
};

/** Exported so tests can supply a value directly. */
export const ScannerSettingsContext = createContext<ScannerSettings>(DEFAULT_SCANNER_SETTINGS);
const SetScannerSettingsContext = createContext<(next: ScannerSettings) => void>(() => {});

/** Mounted once above App; App publishes the user's preferences into it. */
export function ScannerSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ScannerSettings>(DEFAULT_SCANNER_SETTINGS);
  return (
    <SetScannerSettingsContext.Provider value={setSettings}>
      <ScannerSettingsContext.Provider value={settings}>{children}</ScannerSettingsContext.Provider>
    </SetScannerSettingsContext.Provider>
  );
}

/** Consumers (QRScanner, CameraCard): the current scanner settings. */
export function useScannerSettings(): ScannerSettings {
  return useContext(ScannerSettingsContext);
}

/** Publisher (App): push the resolved preference values into the provider. */
export function usePublishScannerSettings(idleMs: number, autoStart: boolean): void {
  const set = useContext(SetScannerSettingsContext);
  const next = useMemo(() => ({ idleMs, autoStart }), [idleMs, autoStart]);
  useEffect(() => { set(next); }, [set, next]);
}
