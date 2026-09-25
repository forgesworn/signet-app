import { useState, useEffect, useCallback, useRef } from 'react';
import { buildVenueEntryPayload } from '../lib/venue-entry';
import type { SigningBackend } from '../lib/signing-backend';

const REFRESH_INTERVAL_MS = 30_000;
const COUNTDOWN_TICK_MS = 1_000;

interface VenueEntryState {
  qrData: string;
  secondsRemaining: number;
  generatedAt: Date;
  error: string | null;
}

/**
 * Generates a signed venue entry QR payload, refreshing every 30 seconds.
 * Uses the SigningBackend for signing (local or remote).
 *
 * `expectedNpPubkeyHex` is threaded through to `buildVenueEntryPayload`,
 * which fails closed if `backend` doesn't sign for that Natural Person key.
 */
export function useVenueEntry(
  backend: SigningBackend,
  expectedNpPubkeyHex: string,
  photoHash?: string,
  blossomUrl?: string,
  photoKey?: string,
): VenueEntryState {
  const [qrData, setQrData] = useState('');
  const [generatedAt, setGeneratedAt] = useState<Date>(new Date());
  const [secondsRemaining, setSecondsRemaining] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const generatedAtRef = useRef<Date>(new Date());
  const consecutiveFailures = useRef(0);

  const generate = useCallback(async () => {
    try {
      const event = await buildVenueEntryPayload(backend, expectedNpPubkeyHex, photoHash, blossomUrl, photoKey);
      setQrData(JSON.stringify(event));
      const now = new Date();
      setGeneratedAt(now);
      generatedAtRef.current = now;
      setSecondsRemaining(30);
      setError(null);
      consecutiveFailures.current = 0;
    } catch (err: unknown) {
      consecutiveFailures.current++;
      if (consecutiveFailures.current >= 2) {
        const detail = err instanceof Error ? err.message : String(err);
        setError(`Signing failed: ${detail}`);
      }
    }
  }, [backend, expectedNpPubkeyHex, photoHash, blossomUrl, photoKey]);

  useEffect(() => {
    generate();
    const interval = setInterval(generate, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [generate]);

  useEffect(() => {
    const tick = setInterval(() => {
      const elapsed = Math.floor((Date.now() - generatedAtRef.current.getTime()) / 1000);
      const remaining = Math.max(0, 30 - elapsed);
      setSecondsRemaining(remaining);
    }, COUNTDOWN_TICK_MS);
    return () => clearInterval(tick);
  }, []);

  return { qrData, secondsRemaining, generatedAt, error };
}
