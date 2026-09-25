import { useState, useCallback } from 'react';
import { isNativeApp, SignetNative } from '../lib/native';

export function useCamera() {
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requestPermission = useCallback(async () => {
    try {
      if (isNativeApp()) {
        // The WebView can only be granted camera access if the Android app
        // itself holds CAMERA — request it natively first. Denial falls
        // through to getUserMedia, which fails with the hook's normal
        // permission-denied handling.
        try { await SignetNative.requestCameraPermission(); } catch { /* fall through */ }
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      stream.getTracks().forEach(t => t.stop());
      setHasPermission(true);
      setError(null);
    } catch (err: any) {
      setHasPermission(false);
      if (err.name === 'NotAllowedError') {
        setError('Camera permission denied. Please allow camera access in your browser settings.');
      } else if (err.name === 'NotFoundError') {
        setError('No camera found on this device.');
      } else {
        setError('Could not access camera.');
      }
    }
  }, []);

  return { hasPermission, error, requestPermission };
}
