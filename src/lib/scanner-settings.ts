/**
 * Device-local settings for the QR scanner camera. Kept out of the sync rails.
 * The pure values live here so the preferences hook, the scanner components and
 * the settings screen share one source for the allowed choices and defaults.
 */

/** How long (seconds) the camera stays on with nothing found, offered in Settings. */
export const SCANNER_IDLE_SECONDS_OPTIONS = [10, 20, 30, 60] as const;
export type ScannerIdleSeconds = (typeof SCANNER_IDLE_SECONDS_OPTIONS)[number];

export const DEFAULT_SCANNER_IDLE_SECONDS: ScannerIdleSeconds = 20;
export const DEFAULT_SCANNER_AUTO_START = true;

/** Anything that is not one of the offered values falls back to the default. */
export function normaliseScannerIdleSeconds(value: unknown): ScannerIdleSeconds {
  return (SCANNER_IDLE_SECONDS_OPTIONS as readonly unknown[]).includes(value)
    ? (value as ScannerIdleSeconds)
    : DEFAULT_SCANNER_IDLE_SECONDS;
}

export function scannerIdleLabel(seconds: number): string {
  return seconds === 60 ? '1 min' : `${seconds} s`;
}
